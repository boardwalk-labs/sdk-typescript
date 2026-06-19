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
import type {
  AgentOptions,
  ArtifactBody,
  ArtifactRef,
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
 * Pause the run for a duration or until a timestamp. The engine HOLDS the task for short waits
 * (locals survive) and SUSPENDS it for long ones (the task is released and re-acquired on wake),
 * by an engine threshold; either way this resolves once the time has elapsed.
 */
export async function sleep(arg: SleepArg): Promise<void> {
  await requireHost().sleep(arg);
}

/**
 * Pause the run for a human to answer, then resume with their validated response. The run SUSPENDS
 * while it waits — the task is released and re-acquired when a person responds via the control
 * plane (web / MCP / REST / CLI), so idle wait time is not billed. The return type follows the
 * `input.kind`:
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

/** Durable steps: run a side-effecting function once and memoize its result across resumes. */
export const step = {
  /**
   * Run `fn` exactly once and memoize its (JSON-serializable) result under `name`. On a resume the
   * cached value is returned WITHOUT re-running `fn` — the escape hatch for arbitrary I/O that must
   * survive a suspend (everything else re-runs on replay unless it goes through a durable seam).
   */
  async run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const host = requireHost();
    if (host.step === undefined) {
      throw new Error("step.run is not supported by the installed engine");
    }
    return (await host.step(name, fn)) as T;
  },
} as const;

/** Granted secrets, resolved lazily and fail-closed against `permissions.secrets`. */
export const secrets = {
  /** Resolve a granted secret to its plaintext value. */
  async get(name: string): Promise<string> {
    return await requireHost().getSecret(name);
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

export type {
  WorkflowMeta,
  Trigger,
  CronTrigger,
  WebhookTrigger,
  ManualTrigger,
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
  ReasoningEffort,
  ReasoningOptions,
  ToolDef,
  ArtifactBody,
  ArtifactRef,
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
  CHANNELS,
  DEFAULT_CHANNELS,
  channelOf,
  matchesChannels,
  makeCursor,
  TURN_CURSOR_STRIDE,
} from "./events.js";
