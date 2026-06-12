// Option/argument types for the workflow hooks (Phase, agent, workflows.call, sleep, secrets).

/** A JSON Schema object (loosely typed — the engine validates against it). */
export type JsonSchema = Record<string, unknown>;

/** Any JSON value — the shape of the run's `config`, `output(...)`, and event payloads. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A program-defined tool for an {@link import("./index.js").agent} loop. `execute` runs in the
 * program process — the trusted layer (it may read secrets); only its RETURN VALUE enters model
 * context, subject to secret redaction.
 */
export interface ToolDef {
  /** Tool name the model sees. Unique within the call's tool set. */
  name: string;
  /** What the tool does — the model chooses tools by this. */
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: JsonSchema;
  /** Runs in the program process; the resolved value is returned to the model (redacted). */
  execute: (input: unknown) => Promise<unknown>;
}

/**
 * Options for an {@link import("./index.js").agent} leaf call. Capabilities are PER-AGENT:
 * each call brings its own `tools`, `skills`, and `memory` — no meta declaration. Only `mcp`
 * names servers declared on `meta` (deploy-time infrastructure: commands, URLs, secret-bearing
 * env). A plain `agent(prompt)` is simple inference.
 */
export interface AgentOptions {
  /**
   * Model ref `<vendor>/<model-id>` (the model-id may itself contain `/` or `:`), e.g.
   * `anthropic/claude-sonnet-4.5`. OPTIONAL — when omitted, the provider routes automatically
   * (the default `boardwalk` provider's Auto lane). The vendor prefix names the MODEL, not the
   * credentials — fulfillment is chosen by `provider`.
   */
  model?: string;
  /**
   * Who fulfills this leaf. Defaults to `boardwalk` (Boardwalk-managed inference) on EVERY
   * engine; your own keys are used only when this names a non-`boardwalk` provider — a
   * built-in vendor (`anthropic`, `openai`, …) or a provider configured on the engine.
   */
  provider?: string;
  /**
   * JSON Schema for the leaf's structured output. When supplied, `agent()` resolves to the
   * validated object (the run fails on mismatch); without it, to the leaf's final text.
   */
  schema?: JsonSchema;
  /**
   * Tools this leaf may use: engine built-in names, plus inline program-defined
   * {@link ToolDef}s. Per-agent — no meta declaration. Defaults to none.
   */
  tools?: readonly (string | ToolDef)[];
  /** MCP servers (by `meta.mcp` name) whose tools this leaf may use. Defaults to none. */
  mcp?: readonly string[];
  /**
   * Skills loadable into this leaf's context, by name — resolved from the `skills/` directory
   * deployed alongside the program (`skills/<name>.md`). Per-agent. Defaults to none.
   */
  skills?: readonly string[];
  /**
   * The leaf's persistent memory: a workspace-relative directory. Per-agent — the engine
   * persists it across runs automatically (no `workspace.persist` declaration needed). The
   * loop gets read/write file tools scoped to that directory and loads its index at turn
   * start; the program may read/write the same files in plain code. Agents may use separate
   * directories or deliberately share one.
   */
  memory?: string;
}

/** Options for a {@link import("./index.js").workflows}.call durable child run. */
export interface CallOptions {
  /**
   * Idempotency key for the child call. Defaults to a deterministic key over
   * `(parent_run_id, target, input)` so a restarted parent re-attaches to the existing
   * child instead of spawning a duplicate.
   */
  idempotencyKey?: string;
}

/**
 * How long {@link import("./index.js").sleep} holds the run. A bare number is milliseconds;
 * the object forms are explicit.
 */
export type SleepArg = number | { durationMs: number } | { until: string | Date };

/** Options for {@link import("./index.js").Phase}, the run-timeline marker. */
export interface PhaseOptions {
  /**
   * Optional stable identifier for the phase. Omit for the engine to assign one in marker order.
   * This is only an observability key; it is not a checkpoint/resume identifier.
   */
  id?: string;
}

/** Body for {@link import("./index.js").artifacts}.write — UTF-8 text or raw bytes. */
export type ArtifactBody = string | Uint8Array;

/** A stored artifact, returned by {@link import("./index.js").artifacts}.write. */
export interface ArtifactRef {
  /** Stable artifact id. */
  id: string;
  /** The name it was stored under. */
  name: string;
  /** A download URL (signed and time-limited on hosted engines; a file URL locally). */
  url: string;
}
