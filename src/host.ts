// SPDX-License-Identifier: MIT

// The host seam — the engine-implementation boundary of the SDK.
//
// `@boardwalk-labs/workflow` is a host-backed package: the hooks authors import (agent, sleep,
// workflows.call, secrets.get, input) are thin facades over a `WorkflowHost` the *engine*
// installs at runtime. hosted Boardwalk installs its hosted adapter; the local engine installs
// one backed by the developer's environment. The author's program is identical either way —
// explicit hooks instead of injected globals.
//
// State is a module-level singleton. Node ESM caches a module by resolved path, so the
// program (which imports the hooks) and the engine (which installs the host) share ONE
// instance of this module and therefore one host + one `input`.

import type {
  AgentOptions,
  ArtifactBody,
  ArtifactRef,
  CallOptions,
  HumanInputOptions,
  HumanInputResult,
  JsonValue,
  PhaseOptions,
  ScheduleOptions,
  SleepArg,
} from "./types.js";

/** The engine contract a host supplies. The author-facing hooks delegate to this. */
export interface WorkflowHost {
  /**
   * Mark the current run phase. Everything after this marker belongs to the phase until the next
   * marker or run end. Observability-only: this is not a checkpoint/resume boundary.
   */
  setPhase?(name: string, opts: PhaseOptions | undefined): void;
  /**
   * Run an agent leaf to completion; resolve to its text (or schema-validated object).
   * `opts.model` may be omitted — the provider routes automatically (default provider =
   * `boardwalk` on every engine; BYO keys only when a provider is explicitly named).
   */
  agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown>;
  /** Dispatch a durable child run and resolve to its output (parent holds while it runs). */
  callWorkflow(slug: string, input: unknown, opts: CallOptions | undefined): Promise<unknown>;
  /**
   * Pause the run for the requested duration. The engine may HOLD the task (short waits, locals
   * survive) or SUSPEND it (long waits — the task is released and re-acquired on wake); either way
   * the hook resolves once the time has elapsed.
   */
  sleep(arg: SleepArg): Promise<void>;
  /** Resolve a granted secret to its plaintext value (fail-closed against `permissions.secrets`). */
  getSecret(name: string): Promise<string>;
  /**
   * Fire-and-forget trigger of another workflow; resolve to the new run's id WITHOUT holding for
   * its result (the sibling of {@link callWorkflow}). Optional — an engine that doesn't support it
   * makes the `workflows.run` hook throw a clear error.
   */
  runWorkflow?(slug: string, input: unknown, opts: CallOptions | undefined): Promise<string>;
  /**
   * Provision a durable schedule that fires the target workflow later (one-shot `at`) or on a
   * recurrence (`cron`/`rate`); resolve to the new schedule's id WITHOUT running it now. The
   * schedule outlives this run. Optional — an engine that doesn't support it makes the
   * `workflows.schedule` hook throw a clear error.
   */
  scheduleWorkflow?(slug: string, input: unknown, opts: ScheduleOptions): Promise<string>;
  /**
   * Store a file under the run's artifact prefix and resolve to its id + download URL.
   * Optional — an engine that doesn't support it makes the `artifacts.write` hook throw a clear error.
   */
  writeArtifact?(
    name: string,
    contentType: string,
    body: ArtifactBody,
    metadata: Record<string, unknown> | undefined,
  ): Promise<ArtifactRef>;
  /**
   * Pause the run for a human to answer and resolve to their validated response. Optional — an
   * engine that doesn't support it makes the `humanInput` hook throw a clear error.
   */
  humanInput?(opts: HumanInputOptions): Promise<HumanInputResult>;
  /**
   * Run `fn` once and memoize its result under `name`; on replay return the cached value WITHOUT
   * re-running `fn`. Optional — an engine that doesn't support it makes the `step.run` hook throw a
   * clear error.
   */
  step?(name: string, fn: () => unknown): Promise<unknown>;
}

let currentHost: WorkflowHost | null = null;

/**
 * The trigger payload for the current run, exposed to the program as
 * `import { input } from "@boardwalk-labs/workflow"`. It is an ES live binding: the engine assigns
 * it via {@link installInput} before the program evaluates, so the import reflects the value.
 * `unknown` by contract — narrow it (e.g. with a schema) in your program.
 */
export let input: unknown = undefined;

/**
 * The run's deploy-time configuration, exposed as `import { config } from "@boardwalk-labs/workflow"`.
 * `{}` unless the deployment supplies one. Read it to vary behavior WITHOUT editing code — e.g.
 * `agent(prompt, { model: config.model ?? undefined })`. Like {@link input}, an ES live binding
 * the engine installs before the program evaluates. Frozen so a program can't mutate it.
 */
export let config: Readonly<Record<string, JsonValue>> = {};

/**
 * The run's declared output — what `output(value)` recorded, or null if the program never called
 * it. Wrapped in a `{ value }` box so an explicit `output(null)` is distinguishable from "never
 * set". The engine reads this AFTER the program body finishes (see {@link takeDeclaredOutput});
 * it's the value persisted as the run's output, returned to a `workflows.call` parent, and the
 * `output` event in the run's stream.
 */
let declaredOutput: { value: JsonValue } | null = null;

/** Record the run's output (last write wins). Author-facing as `output(...)` (re-exported by index). */
export function recordOutput(value: JsonValue): void {
  declaredOutput = { value };
}

/** The engine reads the program's declared output after the body finishes; null ⇒ never declared. */
export function takeDeclaredOutput(): { value: JsonValue } | null {
  return declaredOutput;
}

/** Install the host adapter. Called by the engine (hosted or local) before the program evaluates. */
export function installHost(host: WorkflowHost): void {
  currentHost = host;
}

/** Set the run's trigger payload (the value `import { input }` resolves to). */
export function installInput(value: unknown): void {
  input = value;
}

/** Set the run's deploy-time config (the value `import { config }` resolves to). Frozen on install. */
export function installConfig(value: Record<string, JsonValue>): void {
  config = Object.freeze({ ...value });
}

/** Clear all installed runtime state. Primarily for tests and reused local-dev processes. */
export function resetRuntime(): void {
  currentHost = null;
  input = undefined;
  config = {};
  declaredOutput = null;
}

/** The installed host, or a clear error if a hook was called outside a Boardwalk engine. */
export function requireHost(): WorkflowHost {
  if (currentHost === null) {
    throw new Error(
      "@boardwalk-labs/workflow hooks were called with no host installed. Under a Boardwalk engine " +
        "the host is installed automatically; in tests call installHost(...) " +
        'from "@boardwalk-labs/workflow/runtime" first.',
    );
  }
  return currentHost;
}
