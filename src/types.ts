// SPDX-License-Identifier: MIT

// Option/argument types for the workflow hooks (Phase, agent, workflows.call, sleep, secrets).

import type { McpServerRef } from "./meta.js";

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
 * each call brings its own `tools`, `mcp` servers, `skills`, and `memory` — the manifest
 * declares none of them. A plain `agent(prompt)` is simple inference.
 */
export interface AgentOptions {
  /**
   * A human label for this leaf, echoed onto its `turn_started`/`turn_ended` events as
   * `agentName`. Purely for display — it lets a stream consumer tell concurrent agents apart
   * (e.g. a `reviewer` and a `summarizer` running under `parallel`). It is NOT an identifier and
   * need not be unique; the engine always assigns a stable, run-unique `agentId` regardless.
   * Defaults to none (consumers fall back to a generic label).
   */
  name?: string;
  /**
   * The model, as an OPAQUE string passed VERBATIM to the provider — engines never parse,
   * prefix, or rewrite it. Use whatever identifier your provider expects (e.g.
   * `claude-sonnet-4-5` for Anthropic; `anthropic/sonnet-4.5` if that's what your local
   * server serves it as). OPTIONAL — when omitted, the provider routes automatically (the
   * default `boardwalk` provider's Auto lane). Fulfillment is chosen by `provider`, never
   * by anything in this string.
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
  /**
   * MCP servers this leaf connects to, defined inline ({@link McpServerRef}). Per-agent — no
   * meta declaration; the program supplies credentials directly (it is the trusted layer).
   * Defaults to none.
   */
  mcp?: readonly McpServerRef[];
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
