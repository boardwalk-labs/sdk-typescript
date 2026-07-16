// SPDX-License-Identifier: MIT

// @boardwalk-labs/workflow — the author-facing API a workflow program imports.
//
//   import { agent, workflows, sleep, secrets, input, type WorkflowMeta } from "@boardwalk-labs/workflow"
//
//   export const meta = { slug: "x", triggers: [{ kind: "manual" }] } satisfies WorkflowMeta
//
//   const groups = await agent("group failures", { schema: GROUPS })
//   await parallel(groups.map((g) => () => workflows.call("file-issue", g)))
//   await sleep({ until: "2026-07-01T00:00:00Z" })
//
// These hooks are facades over the installed host (see host.ts). Author programs never
// install a host — the engine running the program does.

import { requireHost, recordOutput } from "./host.js";
import type { RuntimeContext } from "./host.js";
import type {
  AgentOptions,
  ArtifactBody,
  ArtifactRef,
  BrowserSession,
  BrowserSessionOptions,
  CallOptions,
  HumanChoiceResult,
  HumanInputChoiceSpec,
  HumanInputMultiSelectSpec,
  HumanInputOptions,
  HumanInputResult,
  HumanInputTextSpec,
  HumanMultiSelectResult,
  HumanTextResult,
  JsonSchema,
  JsonValue,
  PhaseOptions,
  ScheduleOptions,
  SleepArg,
} from "./types.js";

/**
 * Mark the current run phase for live-tail and run-log grouping. Everything after this call
 * belongs to the named phase until the next `phase(...)` marker or the run ends. This is
 * observability-only; it does not checkpoint or skip code on restart.
 */
export function phase(name: string, opts?: PhaseOptions): void {
  const host = requireHost();
  if (host.setPhase === undefined) {
    throw new Error("phase is not supported by the installed engine");
  }
  host.setPhase(name, opts);
}

/**
 * Run an agent leaf to completion. Two typed forms, by whether you pass a `schema`:
 *  - `agent(prompt, opts?)` (no `schema`) → the leaf's final text (`Promise<string>`).
 *  - `agent<Shape>(prompt, { schema })` → the schema-validated object (`Promise<Shape>`); name the
 *    expected type. The run fails if the model's output doesn't validate.
 *
 * Asking for a typed result WITHOUT a schema (`agent<Shape>(prompt)`) is a type error: there would
 * be nothing to validate against, so the value would really be a string. Omit `opts.model` to let
 * the provider route automatically (the default `boardwalk` provider on every engine; your own keys
 * only via an explicit provider). Capabilities (`tools`, `mcp`, `skills`, `memory`) are PER-AGENT —
 * each call brings its own; the manifest declares none of them.
 */
export function agent<T>(prompt: string, opts: AgentOptions & { schema: JsonSchema }): Promise<T>;
export function agent(prompt: string, opts?: AgentOptions): Promise<string>;
export async function agent<T = string>(prompt: string, opts?: AgentOptions): Promise<T> {
  // The host returns `unknown`; the overloads above are the public contract. With a `schema` the
  // host validated the value (best-effort; the run fails on mismatch) → `T`; without one it is the
  // leaf's final text → `string` (the `T = string` default). The cast is confined to this boundary.
  return (await requireHost().agent(prompt, opts)) as T;
}

/**
 * Cross-workflow composition: `call` (await the result), `run` (fire-and-forget now), and
 * `schedule` (fire later / on a recurrence).
 */
export const workflows = {
  /**
   * Call another workflow as a durable child run. The parent HOLDS while the child runs and
   * resolves to the child's output; the call is idempotent, so a restarted parent re-attaches
   * instead of re-spawning. Use when you need the child's result to continue.
   */
  async call(slug: string, input: unknown, opts?: CallOptions): Promise<unknown> {
    return await requireHost().callWorkflow(slug, input, opts);
  },
  /**
   * Trigger another workflow as a fire-and-forget run. Returns the new run's id WITHOUT
   * holding for its result. Idempotent on (parent, target, input) like {@link call}, so a
   * restarted parent doesn't double-fire. Use when you want to kick something off and move on.
   */
  async run(slug: string, input: unknown, opts?: CallOptions): Promise<string> {
    const host = requireHost();
    if (host.runWorkflow === undefined) {
      throw new Error("workflows.run is not supported by the installed engine");
    }
    return await host.runWorkflow(slug, input, opts);
  },
  /**
   * Schedule another workflow to run later — once at a future instant (`at`) or on a recurrence
   * (`cron` / `rate`). Returns the new schedule's id WITHOUT running it now. Supply exactly one of
   * `cron`, `rate`, or `at`. The schedule is durable and OUTLIVES this run; manage it (list / pause /
   * delete) from the control plane. Idempotent on the schedule spec, so a restarted run re-attaches
   * to the same schedule instead of provisioning a duplicate.
   */
  async schedule(slug: string, input: unknown, opts: ScheduleOptions): Promise<string> {
    const host = requireHost();
    if (host.scheduleWorkflow === undefined) {
      throw new Error("workflows.schedule is not supported by the installed engine");
    }
    const recurrences = [opts.cron, opts.rate, opts.at].filter((v) => v !== undefined).length;
    if (recurrences !== 1) {
      throw new Error("workflows.schedule requires exactly one of `cron`, `rate`, or `at`");
    }
    return await host.scheduleWorkflow(slug, input, opts);
  },
} as const;

/**
 * Pause the run for a duration or until a timestamp. On hosted runners the engine HOLDS the task
 * for short waits and SUSPENDS it for long ones (the machine is snapshotted and released, then
 * restored on wake — locals survive either way, and suspended idle time is not billed). Engines
 * without a snapshot substrate (local dev, self-hosted runners) hold the process for the whole
 * wait. Either way this resolves once the time has elapsed.
 */
export async function sleep(arg: SleepArg): Promise<void> {
  await requireHost().sleep(arg);
}

/**
 * Pause the run for a human to answer, then resume with their validated response. On hosted
 * runners the run SUSPENDS while it waits — the machine is snapshotted and released, then restored
 * when a person responds via the control plane (web / MCP / REST / CLI), so idle wait time is not
 * billed. Engines without a snapshot substrate (local dev, self-hosted runners) hold the process
 * until the answer arrives. The return type follows the `input.kind`:
 *  - `{ kind: "text" }` → `{ value: string }`
 *  - `{ kind: "choice", options }` → `{ value: string, isOther: boolean }`
 *  - `{ kind: "multiselect", options }` → `{ values: string[], other?: string }`
 *
 * For a human gate the model itself can open mid-loop, enable the `human_input` tool on an
 * `agent()` call (`agent(prompt, { humanInput: true })`) instead.
 */
export function humanInput(
  opts: HumanInputOptions & { input: HumanInputTextSpec },
): Promise<HumanTextResult>;
export function humanInput(
  opts: HumanInputOptions & { input: HumanInputChoiceSpec },
): Promise<HumanChoiceResult>;
export function humanInput(
  opts: HumanInputOptions & { input: HumanInputMultiSelectSpec },
): Promise<HumanMultiSelectResult>;
export async function humanInput(opts: HumanInputOptions): Promise<HumanInputResult> {
  const host = requireHost();
  if (host.humanInput === undefined) {
    throw new Error("humanInput is not supported by the installed engine");
  }
  return host.humanInput(opts);
}

/** Granted secrets, resolved lazily and fail-closed against `permissions.secrets`. */
export const secrets = {
  /** Resolve a granted secret to its plaintext value. */
  async get(name: string): Promise<string> {
    return await requireHost().getSecret(name);
  },
} as const;

/** The installed host's runtime context, or a clear error when the engine doesn't supply one. */
function requireRuntime(): RuntimeContext {
  const ctx = requireHost().runtime;
  if (ctx === undefined) {
    throw new Error("runtime context is not available in the installed engine");
  }
  return ctx;
}

/**
 * This run's identity + on-demand platform credential. The ids are synchronous; `apiToken()` fetches
 * a short-lived, manifest-scoped bearer for raw public-API / MCP / CLI use. Platform credentials are
 * never placed in `process.env`, so this is the only way trusted program code obtains the bearer —
 * and it is redacted from all LLM context, so the agent leaf never sees it.
 *
 *   const token = await runtime.apiToken();
 *   const mcp = [{ name: "boardwalk", transport: "http", url: `${runtime.apiUrl}/mcp/v1`,
 *                  headers: { Authorization: `Bearer ${token}` } }];
 */
export const runtime = {
  /** This run's id. */
  get runId(): string {
    return requireRuntime().runId;
  },
  /** The workflow this run belongs to. */
  get workflowId(): string {
    return requireRuntime().workflowId;
  },
  /** The owning org (a run-scoped `apiToken()` already binds it, so callers rarely need this). */
  get orgId(): string {
    return requireRuntime().orgId;
  },
  /** Public API base origin (e.g. `https://api.boardwalk.sh`); append `/v1` or `/mcp/v1` as needed. */
  get apiUrl(): string {
    return requireRuntime().apiUrl;
  },
  /**
   * Absolute path to the run's WORKSPACE root — where `agent({ cwd })` resolves and the built-in
   * file tools work. It is also the program's own working directory and `HOME`, on every runner, so
   * a relative path in program code (`./repo`) and `${runtime.workspaceDir}/repo` name the same
   * place. Prefer this accessor when an ABSOLUTE path is what you need (passing a path to a tool,
   * logging it); reach for it over `process.cwd()` because it states the intent.
   *
   * (This used to say `process.cwd()` pointed at the bundle directory and would "escape the
   * workspace". That was true of the hosted runners as shipped, and it was a BUG, not a contract —
   * cwd was `/` on the microVM fleet and `/app` on Fargate, so a program's relative write silently
   * landed outside the tree `workspace.persist` archives and was thrown away with the VM. The
   * runner now chdirs to the workspace before author code runs; see WORKSPACE_PERSISTENCE.md I1.)
   *
   * Falls back to `process.env.WORKSPACE_ROOT` then `process.cwd()` when the engine doesn't supply
   * it, so it never throws.
   */
  get workspaceDir(): string {
    return requireHost().runtime?.workspaceDir ?? process.env.WORKSPACE_ROOT ?? process.cwd();
  },
  /** Fetch a short-lived, manifest-scoped bearer for the public API / MCP / CLI. */
  async apiToken(): Promise<string> {
    return await requireRuntime().apiToken();
  },
  /**
   * Mint a short-lived OIDC id-token asserting this run's identity for `audience`, to exchange
   * with an external cloud's federation endpoint — keyless AWS/GCP/Azure access instead of
   * long-lived keys in secrets. Requires `permissions.id_token: "write"` in the workflow's meta,
   * plus a trust relationship configured in the target cloud (e.g. an AWS IAM OIDC identity
   * provider for the Boardwalk issuer and a role trust policy pinning `sub` or `org_id`).
   *
   *   const jwt = await runtime.idToken("sts.amazonaws.com");
   *   const sts = new STSClient({ region, signer: noSigner }); // AssumeRoleWithWebIdentity is unsigned
   *   const creds = await sts.send(new AssumeRoleWithWebIdentityCommand({
   *     RoleArn: role, RoleSessionName: runtime.runId, WebIdentityToken: jwt }));
   */
  async idToken(audience: string): Promise<string> {
    if (audience.trim() === "") {
      throw new Error('runtime.idToken requires a non-empty audience (e.g. "sts.amazonaws.com")');
    }
    return await requireRuntime().idToken(audience);
  },
} as const;

/** Computer use — open in-VM browser/desktop sessions the program owns and hands to agent leaves. */
export const computer = {
  /**
   * Open a live, in-VM browser session (the browser tier of computer use). Returns a
   * {@link BrowserSession} handle the PROGRAM owns: pass it to `agent(prompt, { session })` to give a
   * leaf the browser tools (in-VM Playwright MCP attached to this session), and/or drive/inspect it in
   * plain code (`await s.url()`, `await s.eval(...)`). The session survives suspend/resume. Requires an
   * engine with a browser backend.
   */
  async openBrowser(opts?: BrowserSessionOptions): Promise<BrowserSession> {
    const host = requireHost();
    if (host.openBrowserSession === undefined) {
      throw new Error("computer.openBrowser is not supported by the installed engine");
    }
    return await host.openBrowserSession(opts);
  },
} as const;

/** Files (artifacts) that persist with the run. */
export const artifacts = {
  /**
   * Store a file under the run's artifact prefix. `body` is UTF-8 text or raw bytes; pass the
   * MIME `contentType` (e.g. "text/plain", "application/json"). Resolves to the artifact's id,
   * name, and a download URL.
   */
  async write(
    name: string,
    contentType: string,
    body: ArtifactBody,
    metadata?: Record<string, unknown>,
  ): Promise<ArtifactRef> {
    const host = requireHost();
    if (host.writeArtifact === undefined) {
      throw new Error("artifacts.write is not supported by the installed engine");
    }
    return await host.writeArtifact(name, contentType, body, metadata);
  },
} as const;

/**
 * Run thunks concurrently and resolve to their results in order. A barrier: awaits all of
 * them. Rejects on the first thunk that throws (standard `Promise.all` semantics) — wrap a
 * thunk in your own try/catch if you want failures tolerated.
 */
export async function parallel<T>(thunks: readonly (() => Promise<T>)[]): Promise<T[]> {
  return Promise.all(thunks.map((thunk) => thunk()));
}

/**
 * Declare the run's output — its final result. Since a workflow program is top-level module
 * code (it can't `return`), this is how you set what the run produced: the value a
 * `workflows.call` parent receives, what the run log shows as the result, and the `output`
 * event in the run's stream. Last call wins; never calling it leaves the output null. The
 * value must be JSON-serializable and is validated against `meta.output_schema` when declared.
 */
export function output(value: JsonValue): void {
  recordOutput(value);
}

export { input, config } from "./host.js";

export { shell, type ShellOptions } from "./shell.js";

export type {
  WorkflowMeta,
  Trigger,
  CronTrigger,
  WebhookTrigger,
  ManualTrigger,
  WorkflowRunTrigger,
  McpServerRef,
  Concurrency,
  CallableBy,
  OrgRole,
  RunsOn,
  HostedRunsOn,
  HostedRunsOnObject,
  HostedRunnerSize,
  SelfHostedRunsOn,
  Container,
  SecretRef,
  EnvVars,
  EgressPolicy,
  RunPermissions,
  RunPermissionAccess,
  Budget,
  Notification,
  Workspace,
} from "./meta.js";

export type {
  AgentOptions,
  AgentAttachment,
  ReasoningEffort,
  ReasoningOptions,
  ToolDef,
  ArtifactBody,
  ArtifactRef,
  BrowserSession,
  BrowserSessionOptions,
  ConsoleEntry,
  NetworkEntry,
  CallOptions,
  ScheduleOptions,
  PhaseOptions,
  SleepArg,
  HumanInputOptions,
  HumanInputSpec,
  HumanInputTextSpec,
  HumanInputChoiceSpec,
  HumanInputMultiSelectSpec,
  HumanInputResult,
  HumanTextResult,
  HumanChoiceResult,
  HumanMultiSelectResult,
  JsonSchema,
  JsonValue,
} from "./types.js";

export { normalizeReasoning, type NormalizedReasoning } from "./reasoning.js";

export {
  workflowManifestSchema,
  validateMeta,
  MetaValidationError,
  type WorkflowManifest,
} from "./manifest.js";

export {
  type RunEvent,
  type RunEventKind,
  type RunStatus,
  type Channel,
  type EventEnvelope,
  type TokenUsage,
  type ToolReturn,
  runEventSchema,
  parseRunEventLenient,
  CHANNELS,
  DEFAULT_CHANNELS,
  channelOf,
  matchesChannels,
  makeCursor,
  TURN_CURSOR_STRIDE,
} from "./events.js";
