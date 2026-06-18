// SPDX-License-Identifier: MIT

// Option/argument types for the workflow hooks (phase, agent, workflows.call, sleep, secrets).

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
 * Options for an {@link import("./index.js").agent} leaf call. The engine's built-in coding
 * tools (`read`, `write`, `edit`, `ls`, `grep`, `glob`, `bash`, `apply_patch`, `webfetch`,
 * `web_search`, `artifacts`, `lsp`) are ON BY DEFAULT — a plain `agent(prompt)` can already
 * read, edit, and run commands in the run's workspace; `builtins` scopes that set. Everything
 * else is PER-AGENT: each call brings its own inline `tools` (added on top of the built-ins),
 * `mcp` servers, `skills`, and `memory` — the manifest declares none of them.
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
   * Inline program-defined {@link ToolDef}s, added ON TOP of the engine's built-in tools
   * (which are default-on; scope them with `builtins`). Built-ins are no longer named here to
   * get them — `tools` is ONLY the leaf's own inline tools. Per-agent — no meta declaration.
   * Defaults to none.
   */
  tools?: readonly ToolDef[];
  /**
   * Which engine built-in tools this leaf gets. Defaults to `"all"`.
   * - `"all"` — every engine built-in is available.
   * - `"read-only"` — the non-mutating set (`read`, `ls`, `grep`, `glob`, `webfetch`,
   *   `web_search`, `lsp`); drops `write`, `edit`, `apply_patch`, `bash`, and artifact writes.
   * - `"none"` — no built-ins; the leaf has only its inline {@link tools}.
   * - `string[]` — an explicit subset of built-in names.
   *
   * Built-ins that need host infrastructure (`web_search`, `artifacts`, `webfetch`) are served
   * by the engine the run executes on; an engine without that backend fails loudly.
   */
  builtins?: "all" | "read-only" | "none" | readonly string[];
  /**
   * MCP servers this leaf connects to, defined inline ({@link McpServerRef}). Per-agent — no
   * meta declaration; the program supplies credentials directly (it is the trusted layer).
   * Defaults to none.
   */
  mcp?: readonly McpServerRef[];
  /**
   * Skills available to this leaf, by name — each resolved from `skills/<name>/SKILL.md` in the
   * package deployed alongside the program. Loaded with PROGRESSIVE DISCLOSURE: the leaf sees a
   * compact catalog (each skill's name + `description` from its SKILL.md frontmatter), and loads a
   * skill's full instructions on demand via the built-in `skill` tool — which can also return a
   * bundled resource file from the skill's folder (`skill({ name, file })`). Per-agent. Defaults to
   * none.
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
 * When + how often {@link import("./index.js").workflows}.schedule fires a target workflow. Supply
 * EXACTLY ONE of `cron`, `rate`, or `at` — the recurrence is recurring (`cron`/`rate`) or one-shot
 * (`at`). The schedule outlives the run that created it; manage it (list/pause/delete) from the
 * control plane (REST / MCP / console), not the program.
 */
export interface ScheduleOptions {
  /**
   * Recurring on a cron expression — 5-field standard (`min hour dom mon dow`) or a provider-native
   * `cron(...)`. Mutually exclusive with `rate` and `at`. Minute granularity (no sub-minute).
   */
  cron?: string;
  /**
   * Recurring on a fixed interval, as `"<n> <unit>"` — e.g. `"5 minutes"`, `"1 hour"`, `"7 days"`.
   * Mutually exclusive with `cron` and `at`. Minimum interval is 1 minute.
   */
  rate?: string;
  /**
   * One-shot: fire ONCE at this instant (ISO-8601 string or `Date`), then the schedule completes.
   * Mutually exclusive with `cron` and `rate`. For sub-minute waits inside a run, use `sleep`.
   */
  at?: string | Date;
  /** IANA timezone for `cron` (e.g. `"America/Anchorage"`). Defaults to UTC. Ignored by `rate`/`at`. */
  timezone?: string;
  /**
   * Idempotency key. Defaults to a deterministic key over `(creator, target, schedule spec, input)`
   * so a restarted run re-attaches to the same schedule instead of provisioning a duplicate.
   */
  idempotencyKey?: string;
}

/**
 * How long {@link import("./index.js").sleep} holds the run. A bare number is milliseconds;
 * the object forms are explicit.
 */
export type SleepArg = number | { durationMs: number } | { until: string | Date };

/** Options for {@link import("./index.js").phase}, the run-timeline marker. */
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
