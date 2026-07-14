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
 * How much a model should reason before answering, as a single effort level on one unified scale:
 * `minimal` spends the fewest reasoning tokens (fastest time-to-answer), `xhigh` the most (deepest);
 * `none` disables reasoning entirely. Not every provider/model supports every level — an unsupported
 * choice surfaces as a provider error, never a silent downgrade.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * The full reasoning control for an {@link AgentOptions.reasoning} value — the bare-string form
 * (`reasoning: "high"`) is sugar for `{ effort: "high" }`. Supply `effort` OR `maxTokens`, not both:
 * they are mutually exclusive (if both are given, `effort` wins and `maxTokens` is dropped).
 */
export interface ReasoningOptions {
  /** Effort level (see {@link ReasoningEffort}). Mutually exclusive with `maxTokens`. */
  effort?: ReasoningEffort;
  /**
   * A direct upper bound on internal reasoning tokens, for providers that take one (Anthropic /
   * Gemini / some Qwen). Mutually exclusive with `effort`; the engine clamps it to each provider's
   * own minimum/maximum.
   */
  maxTokens?: number;
  /**
   * Reason internally but keep the reasoning trace OUT of the response. Defaults to false. A no-op
   * on providers that never surface reasoning to the loop.
   */
  exclude?: boolean;
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
   * How hard the model should think before answering — one unified `reasoning` control. A bare
   * string is shorthand for `{ effort }`: `reasoning: "high"` ≡ `reasoning: { effort: "high" }`.
   * OMIT entirely for the provider's default (adaptive — the model sizes its own reasoning per
   * prompt).
   *
   * Effort scales `minimal` → `xhigh`; `none` turns reasoning off. The engine maps this ONE neutral
   * control to each provider's wire format: a unified `reasoning` object on the managed lane,
   * `reasoning_effort` for a BYO OpenAI-compatible endpoint, and `thinking`/token-budget for BYO
   * Anthropic + Bedrock. Per-agent like {@link model}/{@link provider} — never a manifest declaration.
   */
  reasoning?: ReasoningEffort | ReasoningOptions;
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
   * The workspace-relative directory this leaf works FROM. Re-roots the leaf's view of the
   * workspace: the built-in file tools (`read`/`write`/`edit`/`ls`/`grep`/`glob`/`apply_patch`)
   * resolve and confine their paths under this directory, `bash` starts there, the ambient
   * workspace orientation describes it, and project context (`AGENTS.md`) is discovered from it.
   * Useful when one run drives several agents in different checkouts (e.g. one cloned repo each):
   * each agent sees clean repo-relative paths instead of guessing the checkout prefix.
   *
   * Must name an EXISTING directory inside the workspace — the call fails loudly otherwise (create
   * it in program code first). {@link memory} stays workspace-ROOT-relative (a memory dir is a
   * stable cross-run identity, not a working location). A `subagent` spawned by this leaf inherits
   * the same `cwd`. This is scoping/ergonomics, not a security boundary — `bash` may still `cd`
   * elsewhere; the run's sandbox is the isolation boundary. Defaults to the workspace root.
   */
  cwd?: string;
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
  /**
   * Give this leaf the `human_input` tool, letting the model pause the run mid-loop to ask a
   * person (the leaf's transcript is checkpointed; the run suspends and resumes with the answer).
   * Off by default — a leaf cannot block on a human unless you opt in. Per-agent.
   */
  humanInput?: boolean;
  /**
   * A ceiling on this leaf's tool-calling turns. OMIT (the default) for NO cap — the loop runs
   * until the model stops calling tools, bounded by the run budget, the repetition guard, and
   * cancellation. Set a positive integer to bound a leaf you expect to finish in N turns.
   *
   * A cap does NOT hard-fail the run: on the turn past the ceiling the model is asked once more
   * with its tools WITHHELD, so it must produce a final answer from the work it has done rather
   * than the call erroring out. Use it as a cost/latency guardrail on a leaf whose scope you know,
   * not as a correctness mechanism (a genuinely stuck loop is already caught by the repetition
   * guard). Per-agent. Non-integer or `< 1` values are ignored (treated as no cap).
   */
  maxIterations?: number;
  /**
   * A computer-use {@link BrowserSession} (from {@link import("./index.js").computer}.openBrowser)
   * this leaf may drive. When set, the leaf gains that session's tool surface — for a browser
   * session, in-VM Playwright MCP attached to the session; the program still owns the session and
   * may drive/inspect it in plain code between leaves. Per-agent. Defaults to none. Requires an
   * engine with computer-use support (otherwise the session couldn't have been opened).
   */
  session?: BrowserSession;
  /**
   * Files to prepend to this leaf's first user message so the model can SEE them — images
   * (`image/*`) and documents (PDFs, …). Each is an {@link AgentAttachment} carrying a `mimeType`
   * plus either inline base64 (`data`) or a `url` (a `data:` URI or a remote `https:` URL the
   * provider fetches). The model must support the matching input modality (vision/document); the
   * managed catalog routes/refuses an incapable model. Text/source files should be passed as text
   * in the prompt (or read with the `read` tool), not as attachments. Per-agent. Defaults to none.
   */
  attachments?: readonly AgentAttachment[];
}

/**
 * A file handed to an {@link AgentOptions.attachments} — an image or a document the model reads
 * directly. Provide the bytes ONE of two ways (exactly one of `data`/`url`):
 *  - `data`: inline base64 — provider-portable, the default for locally-produced bytes.
 *  - `url`: a `data:` URI or a remote `https:` URL. Remote URLs keep the payload small but aren't
 *    accepted by every provider/modality.
 */
export interface AgentAttachment {
  /** MIME type, e.g. `"image/png"` or `"application/pdf"`. */
  mimeType: string;
  /** Inline base64 bytes. Set exactly one of `data`/`url`. */
  data?: string;
  /** A `data:` URI or a remote `https:` URL the provider fetches. Set exactly one of `data`/`url`. */
  url?: string;
  /** Optional display/label name, meaningful mainly for documents. */
  filename?: string;
}

/**
 * A live, in-VM browser session the PROGRAM owns — opened with
 * {@link import("./index.js").computer}.openBrowser, handed to a leaf via {@link AgentOptions.session},
 * and/or driven directly in trusted program code. Survives suspend/resume (the browser lives inside the
 * run's snapshot). The handle is thin (an opaque {@link BrowserSession.id} + methods that round-trip to
 * the guest); it holds no browser state itself.
 */
export interface BrowserSession {
  /** Opaque session id, stable for the session's lifetime. */
  readonly id: string;
  /** Navigate the session's page to `url` (waits for load). */
  navigate(url: string): Promise<void>;
  /** The current page URL. */
  url(): Promise<string>;
  /** The current page title. */
  title(): Promise<string>;
  /** Capture the viewport; stored as an artifact, its {@link ArtifactRef} returned. */
  screenshot(opts?: { fullPage?: boolean }): Promise<ArtifactRef>;
  /** Recent browser console entries (newest last). `since` filters by epoch-ms. */
  console(opts?: { since?: number }): Promise<readonly ConsoleEntry[]>;
  /** Recent network requests (newest last). `since` filters by epoch-ms. */
  network(opts?: { since?: number }): Promise<readonly NetworkEntry[]>;
  /**
   * Evaluate JS in the page context and resolve to the result. **Program-only** — deliberately not
   * an agent tool (arbitrary page-eval is the injection jackpot); the trusted layer holds this.
   */
  eval<T = unknown>(expression: string): Promise<T>;
  /** Close the session (tears down the browser). Idempotent; a session left open is reaped at run end. */
  close(): Promise<void>;
}

/** Options for {@link import("./index.js").computer}.openBrowser. */
export interface BrowserSessionOptions {
  /** Navigate here on open; omit for `about:blank`. */
  startUrl?: string;
  /** Viewport size; defaults to the ambient desktop resolution. */
  viewport?: { width: number; height: number };
  /**
   * Grounding strategy for agent leaves bound to this session (see the computer-use design). Default
   * `"auto"` → accessibility-tree refs for a browser (no vision); `"none"` uses raw coordinates (for
   * models that ground natively); `"vision"` uses a detector; `"a11y"` forces the a11y-ref surface.
   */
  grounding?: "auto" | "a11y" | "vision" | "none";
}

/** A browser console entry, from {@link BrowserSession.console}. */
export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  /** Epoch milliseconds. */
  timestamp: number;
}

/** A network request record, from {@link BrowserSession.network}. */
export interface NetworkEntry {
  method: string;
  url: string;
  /** Response status, once known. */
  status?: number;
  /** Epoch milliseconds the request started. */
  timestamp: number;
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

/**
 * The form a {@link HumanInputOptions} gate presents to the responder — a discriminated union on
 * `kind`. It is the single source of truth for both UI rendering and server-side validation, so
 * common gates need no JSON Schema.
 */
export type HumanInputSpec = HumanInputTextSpec | HumanInputChoiceSpec | HumanInputMultiSelectSpec;

/** Free-text input. Resolves to {@link HumanTextResult}. */
export interface HumanInputTextSpec {
  kind: "text";
  /** Render a multi-line textarea instead of a single line. */
  multiline?: boolean;
  /** Placeholder shown in the empty field. */
  placeholder?: string;
  /** Reject an empty submission. Defaults to false. */
  required?: boolean;
}

/**
 * Single-select from `options`, with a trailing open-text entry unless `allowOther` is false.
 * Resolves to {@link HumanChoiceResult}.
 */
export interface HumanInputChoiceSpec {
  kind: "choice";
  /** The selectable options, in display order. */
  options: readonly string[];
  /** Include a trailing "Other..." entry that reveals a text field. Defaults to true. */
  allowOther?: boolean;
  /** Label for the open-text entry. Defaults to "Other...". */
  otherLabel?: string;
}

/**
 * Multi-select from `options`, with a trailing open-text entry unless `allowOther` is false.
 * Resolves to {@link HumanMultiSelectResult}.
 */
export interface HumanInputMultiSelectSpec {
  kind: "multiselect";
  /** The selectable options, in display order. */
  options: readonly string[];
  /** Include a trailing "Other..." entry that reveals a text field. Defaults to true. */
  allowOther?: boolean;
  /** Label for the open-text entry. Defaults to "Other...". */
  otherLabel?: string;
  /** Minimum number of selections required. */
  min?: number;
  /** Maximum number of selections allowed. */
  max?: number;
}

/** Result of a `text` gate. */
export interface HumanTextResult {
  value: string;
}
/** Result of a `choice` gate. `isOther` is true when `value` is the responder's typed text. */
export interface HumanChoiceResult {
  value: string;
  isOther: boolean;
}
/** Result of a `multiselect` gate. `other` is the typed freeform value when the open entry was used. */
export interface HumanMultiSelectResult {
  values: string[];
  other?: string;
}
/** Any human-input result (one of the per-kind results above). */
export type HumanInputResult = HumanTextResult | HumanChoiceResult | HumanMultiSelectResult;

/**
 * Options for {@link import("./index.js").humanInput} — pause the run for a person to answer, then
 * resume with their validated response. The run SUSPENDS while it waits (the task is released and
 * does not bill idle time) and resumes when a responder submits via the control plane (web / MCP /
 * REST / CLI).
 */
export interface HumanInputOptions {
  /**
   * Optional stable key for this gate (defaults to the seam's sequence position). Shown in the UI
   * and in determinism errors; set one when you want a human-readable, edit-stable identifier.
   */
  key?: string;
  /** The question shown to the responder. */
  prompt: string;
  /** The form: free text, single choice, or multi-select (see {@link HumanInputSpec}). */
  input: HumanInputSpec;
  /**
   * Who may respond, as RBAC scopes (`"role:admin"`, `"user:<id>"`). Defaults to any org member
   * with the `run:respond` permission.
   */
  assignees?: readonly string[];
  /**
   * Optional cap on how long to wait, as `"<n> <unit>"` (e.g. `"48h"`). Provisions a one-shot wake;
   * on expiry the gate resolves per {@link onTimeout}.
   */
  timeout?: string;
  /**
   * What to do if `timeout` elapses with no response: `"fail"` fails the run; `{ value }` resolves
   * the gate with a default value. Defaults to `"fail"`.
   */
  onTimeout?: "fail" | { value: HumanInputResult };
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
