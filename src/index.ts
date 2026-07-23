// SPDX-License-Identifier: MIT

// @boardwalk-labs/workflow — the author-facing API a workflow program imports.
//
// A workflow is a typed function: you export a `run` function, the platform calls it.
// The ENTRY CONTRACT is documented, not exported — you write it, Lambda-style (positional
// params: `input` is param 0, `context` is param 1, optional from the right):
//
//   import { agent, phase, secrets } from "@boardwalk-labs/workflow";
//
//   export default async function run(input: Payment, context: Context): Promise<Triage> {
//     const key = await secrets.get("STRIPE_API_KEY");
//     phase("analyze");
//     const note = await agent(`Why did payment ${input.id} fail?`);
//     return { action: "retry", note };
//   }
//
// The signature carries the data in and the run's metadata; IMPORTS carry everything that
// acts (exactly `import boto3` in a Lambda); the RETURN is the data out — persisted as the
// run's output and handed to `workflows.call` parents. There is no ambient `input`, no
// `output()`, no `config`: input is param 0, output is the return value, and read-only run
// metadata is param 1 (`Context`).
//
// Each capability import is a thin facade over the program↔host protocol (protocol.ts /
// host_client.ts) — the engine hosts the run; the program holds no platform credentials.
// Unit tests install an in-process fake instead: `installTestHost({ agent, secrets, ... })`
// makes `run(input, context)` a plain function call over stubs.

import { getHost, peekHost, reasonText } from "./host_client.js";
import { isRunFatal, type UsageSnapshot } from "./protocol.js";
import { reviveBySchema } from "./revive.js";
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
  PhaseOptions,
  ScheduleOptions,
  SleepArg,
} from "./types.js";

/**
 * Mark the current run phase for live-tail and run-log grouping. Everything after this call
 * belongs to the named phase until the next `phase(...)` marker or the run ends. This is
 * observability-only (a fire-and-forget marker); it does not checkpoint or skip code on
 * restart, and it never blocks the program.
 */
export function phase(name: string, opts?: PhaseOptions): void {
  const host = peekHost();
  if (host !== null) {
    host.phase(name, opts);
    return;
  }
  // Not connected yet (the marker may be the program's first statement): send once the lazy
  // connect completes. Fire-and-forget by contract, so a connect failure only warns — the
  // very next awaited capability call will surface the real error.
  void getHost()
    .then((h) => {
      h.phase(name, opts);
    })
    .catch((err: unknown) => {
      console.warn(`phase(${JSON.stringify(name)}) could not reach the host — ${reasonText(err)}`);
    });
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
 *
 * Inline `tools` run IN THE PROGRAM PROCESS (the trusted layer): only their declarations cross
 * to the host, and the leaf calls the handlers back over the protocol — a handler throw becomes
 * an ordinary tool-error result for the model, never a run failure.
 */
export function agent<T>(prompt: string, opts: AgentOptions & { schema: JsonSchema }): Promise<T>;
export function agent(prompt: string, opts?: AgentOptions): Promise<string>;
export async function agent<T = string>(prompt: string, opts?: AgentOptions): Promise<T> {
  // The host returns `unknown`; the overloads above are the public contract. With a `schema` the
  // host validated the value (best-effort; the run fails on mismatch) → `T`; without one it is the
  // leaf's final text → `string` (the `T = string` default). The cast is confined to this boundary.
  return (await (await getHost()).agent(prompt, opts)) as T;
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
   *
   * The child's output arrives REVIVED per the callee's declared output schema — a child
   * returning a `Date` hands you a `Date` (same for `bigint`, `Uint8Array`, `Set`). An untyped
   * callee returns plain JSON, honestly. Caller/callee compatibility is by convention (resolve
   * by slug; the platform is not a schema registry).
   */
  async call(slug: string, input: unknown, opts?: CallOptions): Promise<unknown> {
    const { output, outputSchema } = await (await getHost()).callWorkflow(slug, input, opts);
    return reviveBySchema(output, outputSchema);
  },
  /**
   * Trigger another workflow as a fire-and-forget run. Returns the new run's id WITHOUT
   * holding for its result. Idempotent on (parent, target, input) like {@link call}, so a
   * restarted parent doesn't double-fire. Use when you want to kick something off and move on.
   */
  async run(slug: string, input: unknown, opts?: CallOptions): Promise<string> {
    return await (await getHost()).runWorkflow(slug, input, opts);
  },
  /**
   * Schedule another workflow to run later — once at a future instant (`at`) or on a recurrence
   * (`cron` / `rate`). Returns the new schedule's id WITHOUT running it now. Supply exactly one of
   * `cron`, `rate`, or `at`. The schedule is durable and OUTLIVES this run; manage it (list / pause /
   * delete) from the control plane. Idempotent on the schedule spec, so a restarted run re-attaches
   * to the same schedule instead of provisioning a duplicate.
   */
  async schedule(slug: string, input: unknown, opts: ScheduleOptions): Promise<string> {
    const recurrences = [opts.cron, opts.rate, opts.at].filter((v) => v !== undefined).length;
    if (recurrences !== 1) {
      throw new Error("workflows.schedule requires exactly one of `cron`, `rate`, or `at`");
    }
    return await (await getHost()).scheduleWorkflow(slug, input, opts);
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
  await (await getHost()).sleep(arg);
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
  return await (await getHost()).humanInput(opts);
}

/** Granted secrets, resolved lazily and fail-closed against `permissions.secrets`. */
export const secrets = {
  /** Resolve a granted secret to its plaintext value. */
  async get(name: string): Promise<string> {
    return await (await getHost()).getSecret(name);
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
    return await (await getHost()).writeArtifact(name, contentType, body, metadata);
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
    return await (await getHost()).openBrowser(opts);
  },
} as const;

/**
 * Short-lived credentials, minted on demand — actions, so they are IMPORTS, not `context`
 * fields (`context` is read-only data and carries nothing that acts). Both mints are redacted
 * from all LLM context; the agent leaf never sees them.
 */
export const auth = {
  /**
   * Mint a short-lived OIDC id-token (JWT) asserting this run's identity for `audience`, to
   * exchange with an external cloud's federation endpoint — keyless AWS/GCP/Azure access instead
   * of long-lived keys in secrets. Requires `permissions.id_token: "write"`, plus a trust
   * relationship configured in the target cloud (e.g. an AWS IAM OIDC identity provider for the
   * Boardwalk issuer and a role trust policy pinning `sub` or `org_id`).
   *
   *   const jwt = await auth.idToken("sts.amazonaws.com");
   */
  async idToken(audience: string): Promise<string> {
    if (audience.trim() === "") {
      throw new Error('auth.idToken requires a non-empty audience (e.g. "sts.amazonaws.com")');
    }
    return await (await getHost()).idToken(audience);
  },
  /**
   * Fetch a short-lived, manifest-scoped bearer for the public API / MCP / CLI. Fetched on
   * demand (never ambient): pass it into an MCP `headers` block or a subprocess env explicitly.
   */
  async apiToken(): Promise<string> {
    return await (await getHost()).apiToken();
  },
} as const;

/**
 * Live budget state, for authors who want to self-govern gracefully before the platform's
 * budget pause safety-net kicks in.
 */
export const usage = {
  /**
   * The run's current budget state: `{ spent, cap, remaining }` per dimension (`usd`, `tokens`,
   * `compute_seconds`), with `cap`/`remaining` null when a dimension is uncapped.
   */
  async get(): Promise<UsageSnapshot> {
    return await (await getHost()).usage();
  },
} as const;

/**
 * Run thunks concurrently and resolve to their results in order. A barrier: awaits all of them.
 *
 * FAULT-TOLERANT: a thunk that throws is isolated to `null` in its slot (and the failure is logged)
 * rather than rejecting the whole batch — so one non-deterministic `agent()` failing (a stuck leaf, a
 * transient model error) doesn't discard the work of its siblings. Filter the nulls to use the
 * successes: `(await parallel(tasks)).filter((r) => r !== null)`.
 *
 * The ONE exception is a run-fatal error — the budget being exhausted or the run being cancelled.
 * Those still reject `parallel()` (after the other thunks settle), because they mean the whole run
 * must stop, not that one task failed. Everything else is yours to handle via the nulls.
 */
export async function parallel<T>(thunks: readonly (() => Promise<T>)[]): Promise<(T | null)[]> {
  const settled = await Promise.allSettled(thunks.map((thunk) => thunk()));
  let fatal: unknown;
  const results = settled.map((outcome, i) => {
    if (outcome.status === "fulfilled") return outcome.value;
    if (isRunFatal(outcome.reason)) {
      fatal ??= outcome.reason;
    } else {
      console.warn(
        `parallel: task #${String(i)} failed and was isolated to null — ${reasonText(outcome.reason)}`,
      );
    }
    return null;
  });
  if (fatal !== undefined) {
    // Re-throw the ORIGINAL run-fatal rejection (an engine error carrying BUDGET_EXCEEDED /
    // CANCELLED) so the run terminates with the right code, not a re-wrapped one.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw fatal;
  }
  return results;
}

export { shell, type ShellOptions, type ShellResult } from "./shell.js";

// The read-only run metadata (`run`'s second parameter) and its parts.
export {
  HostError,
  isRunFatal,
  RUN_FATAL_CODES,
  type Actor,
  type Context,
  type ContextData,
  type TriggerInfo,
  type UsageDimension,
  type UsageSnapshot,
} from "./protocol.js";

// Unit-testing surface: an in-process fake host, so `run(input, context)` is a plain call.
export { installTestHost, type TestHostHandle, type TestHostOverrides } from "./host_client.js";

export type {
  AgentOptions,
  McpServerRef,
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
  type WorkflowManifest,
  type Trigger,
  type CronTrigger,
  type WebhookTrigger,
  type ManualTrigger,
  type WorkflowRunTrigger,
  type Concurrency,
  type CallableBy,
  type OrgRole,
  type RunsOn,
  type HostedRunsOn,
  type HostedRunsOnObject,
  type HostedRunnerSize,
  type SelfHostedRunsOn,
  type Container,
  type SecretRef,
  type EnvVars,
  type EgressPolicy,
  type RunPermissions,
  type RunPermissionAccess,
  type Budget,
  type Notification,
  type Workspace,
} from "./manifest.js";

// The hand-written `workflow.jsonc` descriptor: JSONC parsing (comments stripped, never
// stored), validation against the manifest schema minus the build-derived I/O schemas, and
// the deploy-time concurrency-key template SYNTAX check.
export {
  parseJsonc,
  parseWorkflowDescriptor,
  validateConcurrencyKeyTemplate,
  DescriptorValidationError,
  DEFAULT_ENTRY_SOURCES,
  PYTHON_DEFAULT_ENTRY,
  type WorkflowDescriptor,
  type ConcurrencyKeyTemplateIssue,
} from "./descriptor.js";

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
