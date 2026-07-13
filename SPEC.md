# SPEC — `sdk` (`@boardwalk-labs/workflow`)

> The authoring contract. Everything a workflow program can import, the manifest schema, and the run-event wire format. MIT. Public in **Phase 1**.
>
> Scope: the workflow model and versioning. This repo defines contracts; it implements no engine behavior.

## 1. Purpose

`@boardwalk-labs/workflow` is the only package a workflow author needs. It provides:

1. **Primitives** — `agent()`, `sleep()`, `workflows.*`, `secrets.get()`, `artifacts.write()`, `parallel()`, `input`/`output()`/`config`, `phase()`.
2. **The `meta` type + manifest schema** — the Zod schema every engine and hosted Boardwalk validate against; TS types derived from the schema, never hand-written.
3. **The run-event wire format** — the typed event stream every engine emits.
4. **The host interface** — the seam engines implement to back the primitives.

The SDK has **zero engine knowledge**: no scheduling, no process management, no storage, no HTTP. It is a thin, typed bridge from author code to whatever engine is hosting the run.

## 2. Public API surface (v1)

### 2.1 Primitives

```ts
function agent<T = string>(prompt: string, opts?: AgentOptions): Promise<T>;

interface AgentOptions {
  model?: string; // OPAQUE, passed VERBATIM to the provider — never parsed or prefixed.
  // Omitted → the provider routes automatically (the default `boardwalk` provider's Auto lane).
  provider?: string; // Who fulfills the call. Default `boardwalk` on EVERY engine; BYO keys only when explicitly named.
  schema?: JsonSchema; // Validates parsed JSON output; run fails on mismatch.
  tools?: readonly ToolDef[]; // PER-AGENT: inline program-defined tools, added ON TOP of the default-on built-ins.
  builtins?: "all" | "read-only" | "none" | readonly string[]; // Scopes the engine's default-on built-in tools. Default "all".
  mcp?: readonly McpServerRef[]; // PER-AGENT: inline server definitions (stdio command or http url).
  skills?: readonly string[]; // PER-AGENT: skills/<name>.md deployed alongside the program.
  memory?: string; // PER-AGENT: workspace-relative dir, auto-persisted across runs by the engine.
}

const workflows: {
  call(slug: string, input: unknown, opts?: CallOptions): Promise<unknown>; // durable, awaits child result
  run(slug: string, input: unknown, opts?: CallOptions): Promise<string>; // fire-and-forget, returns child run id
};
interface CallOptions {
  idempotencyKey?: string;
} // default: deterministic hash(parent run, target, input)

function sleep(arg: number | { durationMs: number } | { until: string | Date }): Promise<void>;

const secrets: { get(name: string): Promise<string> }; // name must appear in permissions.secrets

const runtime: {
  runId: string; // this run's identity, synchronous
  workflowId: string;
  orgId: string;
  apiUrl: string; // public API base origin
  apiToken(): Promise<string>; // short-lived bearer scoped to this run's manifest permissions, fetched on demand
  idToken(audience: string): Promise<string>; // short-lived OIDC id-token asserting the run's identity, for
  // external cloud federation (AWS AssumeRoleWithWebIdentity / GCP / Azure); requires permissions.id_token: "write".
}; // engines without a runtime context make every accessor throw a clear error (e.g. local dev)
const artifacts: {
  write(
    name: string,
    contentType: string,
    body: ArtifactBody,
    metadata?: Record<string, unknown>,
  ): Promise<ArtifactRef>;
};
interface ArtifactRef {
  id: string;
  name: string;
  url: string;
}

function parallel<T>(thunks: readonly (() => Promise<T>)[]): Promise<T[]>;
function output(value: JsonValue): void; // the run's declared result; validated against meta.output_schema
const input: unknown; // live binding: the trigger payload; validated against meta.input_schema
const config: Readonly<Record<string, JsonValue>>; // deploy-time configuration
function phase(name: string, opts?: { id?: string }): void; // named phase boundary in the run log
```

**v1 change from pre-release:** `AgentOptions.model` becomes **optional** (was required), and `provider`/`model` are fully **orthogonal** (decided 2026-06-12): `provider` picks who fulfills the call; `model` is an opaque string passed **verbatim** to that provider — engines never parse, prefix, or rewrite it, and nothing in the model string ever selects credentials. **Default provider = `boardwalk` on every engine:** omission of `model` routes automatically through the managed lane, which works when the engine holds a Boardwalk credential (hosted: ambient; local engines: `BOARDWALK_API_KEY` / the `boardwalk login` account where a login flow exists) — otherwise an actionable error names every fix (set the credential, or name a provider). BYO keys are used only when the call names a non-`boardwalk` provider explicitly.

**Planned (not v1):** `shell(cmd, opts?)` — exec convenience that streams output into the run event log. Until then programs use `child_process` directly; stdout/stderr are captured into the run log either way.

### 2.1.1 The `agent()` capability set (v1 — required, all engines)

The loop is a real agentic loop, not bare inference. **The engine's built-in coding tools are ON BY DEFAULT** (`read`, `write`, `edit`, `ls`, `grep`, `glob`, `bash`, `apply_patch`, `webfetch`, `web_search`, `artifacts`, `lsp`): a plain `agent(prompt)` can already read, edit, and run commands in the run's workspace, and `builtins` scopes that set. **Everything else is PER-AGENT (decided 2026-06-11): each `agent()` call brings its own inline tools, MCP servers, skills, and memory — the manifest declares NONE of them** (no `meta.tools`/`meta.mcp`/`meta.skills`; memory needs no `workspace.persist` declaration).

```ts
// built-ins are default-on; everything else is per-agent, on AgentOptions:
tools?: readonly ToolDef[];             // inline program-defined tools, ON TOP of the built-ins
builtins?: "all" | "read-only" | "none" | readonly string[]; // scopes the default-on built-in set; default "all"
mcp?: readonly McpServerRef[];          // inline: { name, transport: "stdio" | "http", command? | url?, env?/headers? }
skills?: readonly string[];             // skills/<name>.md deployed alongside the program
memory?: string;                        // a workspace-relative dir, auto-persisted across runs

// program-defined tools (inline in AgentOptions.tools)
interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown): Promise<unknown>;  // runs in the program process; results stream as tool_call events
}
```

- **Built-in tools (default-on):** the engine's coding tools — `read`, `write`, `edit`, `ls`, `grep`, `glob`, `bash`, `apply_patch`, `webfetch`, `web_search`, `artifacts`, `lsp` — are available to every leaf with no declaration. `builtins` scopes the set: `"all"` (default) is every built-in; `"read-only"` is the non-mutating set (`read`, `ls`, `grep`, `glob`, `webfetch`, `web_search`, `lsp`, dropping `write`/`edit`/`apply_patch`/`bash`/artifact writes); `"none"` removes them entirely; a `string[]` names an explicit subset. Built-ins that need host infrastructure (`web_search`, `artifacts`, `webfetch`) are served by the engine the run executes on; an engine without that backend fails loudly. An unknown built-in name fails loudly at call time.
- **Inline tools:** program-defined `ToolDef`s in `tools`, added ON TOP of the built-ins, whose `execute` runs in the program process (the trusted layer — it may use `secrets.get`; only its _return value_ enters model context, subject to redaction).
- **MCP:** the loop connects to the call's inline `McpServerRef`s and exposes their tools to the model. The program is the trusted layer — it supplies credentials in `env`/`headers` directly (e.g. from `secrets.get`); no interpolation syntax.
- **Skills:** user-authored markdown loaded into the loop's context by name, resolved from the `skills/` directory deployed alongside the program (`skills/<name>.md`). A missing skill file fails loudly at call time.
- **Memory is not a separate system — it is a persistent directory, per agent.** `agent(prompt, { memory: "memory/triager" })` points the loop at a workspace-relative directory; the **engine persists every memory directory automatically across runs** (hydrated at run start, written back at successful run end — no declaration anywhere). The loop gets read/write file tools scoped to that directory and loads its index into context at turn start; the _program_ may read/write the same files in plain code (seed it, inspect it, prune it). Multiple agents may use separate directories or deliberately share one. Rules: paths are workspace-relative; `..` (or any escape) is a validation error. `workspace.persist` remains the separate, program-level persistence knob for non-memory state.
- Built-ins default to **`"all"`** (a plain `agent(prompt)` can already work the workspace); inline `tools`, `mcp`, `skills`, and `memory` default to **none**. An unknown built-in name or a missing skill file is a loud error, never silent degradation.
- Secret-redaction applies to all of it: tool args/results, MCP traffic, skill content, and memory content are scrubbed of known secret values before reaching the model.

### 2.2 `meta` / manifest — v1 core fields

The manifest field table: `slug` (the workflow's URL-safe identity — alphanumeric + hyphens; referenced by the CLI, `workflows.call`, and the API), `title` (optional human display label, free text one line; UIs fall back to a title-cased slug), `description`, `triggers` (cron `{expr, timezone?, input?}` — `input` pins a static payload for every scheduled run, matched against `input_schema` when declared; omitted ⇒ no input / manual / webhook `{auth}`), `env` (with `${{ secrets.NAME }}` whole-value interpolation; `BOARDWALK_*` / `AWS_*` reserved), `input_schema`, `output_schema`, `workspace.persist` (`true | string[]` — program-level persistence; agent memory is auto-persisted separately, §2.1.1), `budget` (`max_usd` / `max_tokens` / `max_duration_seconds`), `concurrency`, `runs_on`. The **secret allowlist is `permissions.secrets`** (`{name}[]` — a readable secret is an access grant), not a top-level field. There are **no capability manifest fields** (`tools` / `mcp` / `skills`) — all agent capabilities are per-agent (§2.1.1).

**Platform-extension fields** (in the schema, enforced only on hosted Boardwalk, documented as such): `permissions`, `egress`, `callable_by`, `notifications`, `container`. `permissions` is the access-grant surface — access-level knobs (`id_token` / `artifacts` / `contents`) plus the secret allowlist (`secrets: {name}[]`); it carries **no `tools` grant** (tool selection is per-agent, §2.1.1). Engines without the capability fail validation loudly when a workflow requires it (capability-presence rule).

**Not in v1** (rejected by the schema): `instructions`, `outcome`, `eval_sample_rate`, `scripts`, `chains`, `event` triggers + `events.emit`, and any integration/connection-flavored secret variants — a secret ref is exactly `{ name }`; **secrets + env vars are the entire credential story.** Some fields may return in later minors; v1 ships the surface above and nothing silent.

### 2.3 Schema rules

- One Zod schema, exported; TS types derived via `z.infer`. No hand-written manifest types.
- Unknown fields are **validation errors**.
- Any union members ordered **most-specific-first** (Zod unions are first-match-wins and objects strip unknown keys — a less-specific variant listed first silently drops fields). Round-trip tests assert with `toEqual`, never just `toBeDefined`.
- `meta` must be a **pure literal**; the SDK ships the static extractor (`extractMetaLiteral` / `extractManifest` on the `@boardwalk-labs/workflow/extract` subpath) the CLI and engines use to derive the manifest from a program file without executing it.

### 2.4 The host interface (engine seam)

The SDK's primitives delegate to a `WorkflowHost` installed by the engine before the program module is invoked:

```ts
interface WorkflowHost {
  runtime?: RuntimeContext; // run identity + apiToken()/idToken(audience); absent ⇒ runtime.* accessors throw
  agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown>;
  callWorkflow(slug: string, input: unknown, opts: CallOptions | undefined): Promise<unknown>;
  sleep(arg: SleepArg): Promise<void>;
  getSecret(name: string): Promise<string>;
  // Optional capabilities — hooks throw a clear "not supported" error when absent:
  setPhase?(name: string, opts: PhaseOptions | undefined): void;
  runWorkflow?(slug: string, input: unknown, opts: CallOptions | undefined): Promise<string>;
  writeArtifact?(name, contentType, body, metadata): Promise<ArtifactRef>;
}
```

The engine installs the host (plus `input`/`config` live bindings) via `@boardwalk-labs/workflow/runtime` (`installHost` / `installInput` / `installConfig`) before evaluating the program, and reads the declared output afterwards (`takeDeclaredOutput`). State is a module-level singleton — Node ESM module caching guarantees the program and engine share one instance. This interface is **part of the public contract** (engines — including third-party ones — implement it). Calling a primitive with no host installed throws a clear "no host installed" error.

### 2.5 The run-event wire format

Exported types + Zod schemas for the full event union: envelope (`runId`, `turnId`, per-turn 1-based `seq`, `t` ms-epoch) + run-global cursor (`turnNumber * 1_000_000 + seq`); event kinds `turn_started`, `turn_ended` (both carry the leaf's `agentId` + optional `agentName`; `turn_ended` adds `reason`, `usage?`, `error?`), `text_start/delta/end`, `tool_call_start / _input_delta / _input_complete / _executing / _result / _error`, `reasoning_delta`; `ToolReturn` (`kind?`, `humanSummary?`, `data?`), `TokenUsage`, error shape (`code`, `message`). Run-lifecycle frames (queued/running/terminal status), `phase()` boundary frames, `output()` frames, and captured-stdout/stderr frames are part of the same union.

**Channels:** every event kind maps to exactly one subscription channel — `lifecycle`, `phase`, `output`, `log`, `agent`. The SDK exports the `Channel` type, the kind→channel mapping, and the subscription-filter helper engines use server-side, so all engines and clients agree on what `?channels=phase,output` vs `verbose` means. Default subscription: `lifecycle + phase + output`. Cursors are global across channels — filtered subscriptions resume correctly.

## 3. Internal architecture

```
src/
  index.ts        — the author-facing hooks + public exports
  types.ts        — option/argument types (AgentOptions, ToolDef, SleepArg, …)
  meta.ts         — WorkflowMeta + trigger/capability/platform-extension types
  host.ts         — WorkflowHost interface + singleton install/teardown + "no host" errors
  runtime.ts      — the engine-facing subpath export (/runtime)
  manifest.ts     — the Zod schema, validateMeta, MetaValidationError
  events.ts       — wire-format schemas + channels + cursor helpers
  extract.ts      — pure-literal AST extraction (the /extract subpath export)
```

- **Dependencies:** `zod` (schemas) and `typescript` (the `/extract` AST parser — engines and the CLI need extraction; authors already have TypeScript to author with). Every additional dependency needs PR justification.
- No I/O anywhere in this package. Everything async goes through the host.

## 4. Testing

- Manifest schema: exhaustive valid/invalid fixtures; round-trip (`parse` → `toEqual`) for every union member; unknown-field rejection; env interpolation + reserved-prefix cases; cron expr edge cases.
- Extraction: pure-literal enforcement (rejects spreads, calls, shorthand, computed keys, template interpolation, array holes) with precise `file:line:col` error positions; `satisfies`/`as const` unwrapping.
- Primitives: a fake host proves delegation, error propagation, and the no-host error.
- Wire format: cursor monotonicity + resume filtering; schema round-trips for every event kind.

## 5. Ready to go public when

1. The API in §2 is implemented and exported — nothing more (no engine imports, no leftover undocumented exports).
2. `npm pack` contains exactly: built JS + d.ts + README + LICENSE.
3. Docs: every export has a docstring; README quickstart authors a workflow in <60 seconds of reading.
4. Conformance fixtures consumed by the engine repo compile against the published types.
5. Publication checklist passes.
