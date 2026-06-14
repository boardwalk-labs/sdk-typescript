// SPDX-License-Identifier: MIT

// @boardwalk-labs/workflow — the author-facing API a workflow program imports.
//
//   import { agent, workflows, sleep, secrets, input, type WorkflowMeta } from "@boardwalk-labs/workflow"
//
//   export const meta = { name: "x", triggers: [{ kind: "manual" }] } satisfies WorkflowMeta
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
  JsonSchema,
  JsonValue,
  PhaseOptions,
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

/** Cross-workflow composition: `call` (await the result) and `run` (fire-and-forget). */
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
} as const;

/** Hold the run for a duration or until a timestamp (the run stays held while it waits; locals survive). */
export async function sleep(arg: SleepArg): Promise<void> {
  await requireHost().sleep(arg);
}

/** Granted secrets, resolved lazily and fail-closed against `meta.secrets`. */
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
  ToolGrant,
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
  ToolDef,
  ArtifactBody,
  ArtifactRef,
  CallOptions,
  PhaseOptions,
  SleepArg,
  JsonSchema,
  JsonValue,
} from "./types.js";

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
