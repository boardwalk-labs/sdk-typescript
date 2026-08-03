# SPEC — `sdk-typescript` (`@boardwalk-labs/workflow`)

> The authoring contract. Everything a workflow program can import, the program↔host protocol, the manifest schema, and the run-event wire format. MIT. Public in **Phase 1**.
>
> Scope: the workflow model and versioning. This repo defines contracts; it implements no engine behavior.

## 1. Purpose

`@boardwalk-labs/workflow` is the only package a workflow author needs. It provides:

1. **Capabilities (imports)** — `agent()`, `workflows.*`, `sleep()`, `humanInput()`, `secrets.get()`, `artifacts.write()`, `computer.openBrowser()`, `shell()`, `parallel()`, `phase()`, `auth.{idToken,apiToken}`, `usage.get()` — plus the `Context` type for `run`'s second parameter and `installTestHost()` for unit tests.
2. **The program↔host protocol** — JSON-RPC 2.0 over a local socket (`src/protocol.ts`), one method per capability, spoken by every SDK (TS here; Python is a sibling client of the same contract) against the runner's host server. The TS client is `src/host_client.ts`.
3. **The manifest schema + the descriptor** — the Zod schema every engine and hosted Boardwalk validate against (TS types derived from the schema, never hand-written), plus parsing/validation for the hand-written `workflow.jsonc` descriptor (JSONC parse, the manifest schema minus the build-derived I/O schemas, and the deploy-time concurrency-key template syntax check).
4. **The run-event wire format** — the typed event stream every engine emits.

The SDK has **zero engine knowledge**: no scheduling, no process management, no storage, no HTTP. It is a thin, typed marshaling layer from author code to whatever engine is hosting the run; the only I/O in the package is the protocol client's local socket.

## 2. Public API surface (v1)

### 2.0 The entry contract (you write it; the SDK doesn't export it)

A workflow is a typed function, Lambda-style. Params are **positional**: `input` is param 0, `context` is param 1, optional from the right — `run()`, `run(input)`, and `run(input, context)` are the valid shapes:

```ts
export default async function run(input: I, context?: Context): Promise<O>;
```

- **`input`** — the trigger payload, best-effort converted to the declared type (schema-guided revival: ISO string → `Date`, base64 → `Uint8Array`, deduped array → `Set`, integer-pattern string → `bigint`). A bare/`unknown` param is the untyped floor: raw JSON, no derivation.
- **`context`** — read-only run metadata (`Context`, §2.1.2). Data only; nothing that acts.
- **the return value** — the run's output, validated against the derived output schema and persisted; `void` persists `null`. There is no `output()` and no ambient `input` — both are deleted.
- **capabilities** — ordinary imports (§2.1), like `import boto3` in a Lambda.

### 2.1 Capabilities (imports)

```ts
function agent<T>(prompt: string, opts: AgentOptions & { schema: JsonSchema }): Promise<T>;
function agent(prompt: string, opts?: AgentOptions): Promise<string>;

interface AgentOptions {
  model?: string; // OPAQUE, passed VERBATIM to the provider — never parsed or prefixed.
  // Omitted → the provider routes automatically (the default `boardwalk` provider's Auto lane).
  provider?: string; // Who fulfills the call. Default `boardwalk` on EVERY engine; BYO keys only when explicitly named.
  schema?: JsonSchema; // Validates parsed JSON output; run fails on mismatch.
  tools?: readonly ToolDef[]; // PER-AGENT: inline program-defined tools, added ON TOP of the default-on built-ins.
  builtins?: "all" | "read-only" | "none" | readonly string[]; // Scopes the engine's default-on built-in tools. Default "all".
  cwd?: string; // PER-AGENT: the existing workspace-relative dir the leaf works from — file tools, bash,
  // orientation, and AGENTS.md discovery re-root there (memory stays root-relative; subagents inherit it).
  mcp?: readonly McpServerRef[]; // PER-AGENT: inline server definitions (stdio command or http url).
  skills?: readonly string[]; // PER-AGENT: skills/<name>.md deployed alongside the program.
  memory?: string; // PER-AGENT: workspace-relative dir, auto-persisted across runs by the engine.
}

const workflows: {
  call(slug: string, input: unknown, opts?: CallOptions): Promise<unknown>; // durable, awaits child result,
  // REVIVES the output per the callee's output_schema (a child returning a Date hands you a Date;
  // an untyped callee returns plain JSON, honestly)
  run(slug: string, input: unknown, opts?: CallOptions): Promise<string>; // fire-and-forget, returns child run id
  schedule(slug: string, input: unknown, opts: ScheduleOptions): Promise<string>; // durable schedule, outlives the run
};
interface CallOptions {
  idempotencyKey?: string;
} // default: deterministic hash(parent run, target, input)

function sleep(arg: number | { durationMs: number } | { until: string | Date }): Promise<void>;
function humanInput(opts: HumanInputOptions): Promise<HumanInputResult>; // typed per opts.input.kind

const secrets: { get(name: string): Promise<string> }; // name must appear in permissions.secrets

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

const computer: {
  openBrowser(opts?: BrowserSessionOptions): Promise<BrowserSession>;
  openDesktop(opts?: DesktopSessionOptions): Promise<DesktopSession>; // whole screen; at most one per run
};

function shell(cmd: string, opts?: ShellOptions): Promise<ShellResult>; // { exitCode, stdout, stderr };
// a non-zero exit RESOLVES (check exitCode) — only a command that could not run rejects

function parallel<T>(thunks: readonly (() => Promise<T>)[]): Promise<(T | null)[]>; // isolates
// non-fatal failures to null; re-throws run-fatal reasons (isRunFatal: BUDGET_EXCEEDED / CANCELLED / fatal flag)

function phase(name: string, opts?: { id?: string }): void; // fire-and-forget timeline marker

const auth: {
  idToken(audience: string): Promise<string>; // short-lived OIDC id-token asserting the run's identity, for
  // external cloud federation (AWS AssumeRoleWithWebIdentity / GCP / Azure); requires permissions.id_token: "write".
  apiToken(): Promise<string>; // short-lived bearer scoped to this run's manifest permissions, fetched on demand
};

const usage: {
  get(): Promise<UsageSnapshot>; // live { spent, cap, remaining } per budget dimension
  // (usd / tokens / compute_seconds); cap/remaining null when uncapped
};
```

`provider`/`model` are fully **orthogonal**: `provider` picks who fulfills the call; `model` is an opaque string passed **verbatim** to that provider — engines never parse, prefix, or rewrite it, and nothing in the model string ever selects credentials. **Default provider = `boardwalk` on every engine:** omission of `model` routes automatically through the managed lane; BYO keys are used only when the call names a non-`boardwalk` provider explicitly.

**Removed from the pre-function-model SDK (P2, clean break):** `input` (now param 0), `output()` (now the return value), `config`, and `runtime` (split into `context` + the imported `auth`). Logging is `console.log`, captured into the run log.

### 2.1.1 The `agent()` capability set (v1 — required, all engines)

The loop is a real agentic loop, not bare inference. **The engine's built-in coding tools are ON BY DEFAULT** (`read`, `write`, `edit`, `ls`, `grep`, `glob`, `bash`, `apply_patch`, `diagnostics`, `navigate`, `clock`, `todo`, `webfetch`, `http`, `web_search`, `artifacts`, `subagent`, `run_code`): a plain `agent(prompt)` can already read, edit, and run commands in the run's workspace, and `builtins` scopes that set. **Everything else is PER-AGENT (decided 2026-06-11): each `agent()` call brings its own inline tools, MCP servers, skills, and memory — the descriptor declares NONE of them** (no `tools`/`mcp`/`skills` fields; memory needs no `workspace.persist` declaration).

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

- **Built-in tools (default-on):** the engine's coding tools — `read`, `write`, `edit`, `ls`, `grep`, `glob`, `bash`, `apply_patch`, `diagnostics`, `navigate`, `clock`, `todo`, `webfetch`, `http`, `web_search`, `artifacts`, `subagent`, `run_code` — are available to every leaf with no declaration. `builtins` scopes the set: `"all"` (default) is every built-in; `"read-only"` is the non-mutating set (`read`, `ls`, `grep`, `glob`, `diagnostics`, `navigate`, `clock`, `todo`, `webfetch`, `web_search`, dropping `write`/`edit`/`apply_patch`/`bash`/`http`/`subagent`/`run_code`/artifact writes); `"none"` removes them entirely; a `string[]` names an explicit subset. Built-ins that need host infrastructure (`web_search`, `artifacts`, `webfetch`) are served by the engine the run executes on; an engine without that backend fails loudly. An unknown built-in name fails loudly at call time.
- **Inline tools:** program-defined `ToolDef`s in `tools`, added ON TOP of the built-ins, whose `execute` runs in the program process (the trusted layer — it may use `secrets.get`; only its _return value_ enters model context, subject to redaction).
- **MCP:** the loop connects to the call's inline `McpServerRef`s and exposes their tools to the model. The program is the trusted layer — it supplies credentials in `env`/`headers` directly (e.g. from `secrets.get`); no interpolation syntax.
- **Skills:** user-authored markdown loaded into the loop's context by name, resolved from the `skills/` directory deployed alongside the program (`skills/<name>.md`). A missing skill file fails loudly at call time.
- **Memory is not a separate system — it is a persistent directory, per agent.** `agent(prompt, { memory: "memory/triager" })` points the loop at a workspace-relative directory; the **engine persists every memory directory automatically across runs** (hydrated at run start, written back at successful run end — no declaration anywhere). The loop gets read/write file tools scoped to that directory and loads its index into context at turn start; the _program_ may read/write the same files in plain code (seed it, inspect it, prune it). Multiple agents may use separate directories or deliberately share one. Rules: paths are workspace-relative; `..` (or any escape) is a validation error. `workspace.persist` remains the separate, program-level persistence knob for non-memory state.
- Built-ins default to **`"all"`** (a plain `agent(prompt)` can already work the workspace); inline `tools`, `mcp`, `skills`, and `memory` default to **none**. An unknown built-in name or a missing skill file is a loud error, never silent degradation.
- Secret-redaction applies to all of it: tool args/results, MCP traffic, skill content, and memory content are scrubbed of known secret values before reaching the model.

### 2.1.2 `Context` — read-only run metadata (frozen v1 set, append-only)

`run`'s second parameter. Pure invocation identity — no capabilities, no secrets, no budget, no deadline, no time (live budget state is `usage.get()`; the credential mints are the imported `auth`). **Append-only forever**: fields are added, never removed or renamed.

```ts
interface Context {
  readonly runId: string; // bare 26-char ULID, like all entity ids
  readonly workflowId: string;
  readonly workflowVersion: number; // sequential int; pins the run to the version it started on
  readonly orgId: string;
  readonly environment: { id: string; name: string } | null; // the run's selected environment; null = org base
  readonly actor: Actor; // who/what invoked the run — union discriminated on `type`:
  // user | workflow | webhook | cron | event. On a `workflow` actor, `user_id` is the synthetic
  // `workflow:<workflowId>` principal of the immediate parent, never a human.
  readonly attempt: number; // 1-based; increments on crash-restart-from-top (side effects re-run)
  readonly trigger: TriggerInfo; // kind ∈ "cron" | "webhook" | "manual" + firedAt + source?.
  // Two-axis rule: `kind` is the transport, `actor` is the initiator — the enum never grows to
  // restate what `actor` says (a workflows.call child is manual + actor.type "workflow").
  readonly workspaceDir: string; // absolute /workspace root (also cwd + HOME)
  readonly signal: AbortSignal; // aborts on cancellation (synthesized from the host `cancel`
  // notification — never a wire field)
}
```

### 2.2 The descriptor (`workflow.jsonc`) / manifest — v1 core fields

A workflow's deployment policy lives in a small, hand-written declarative descriptor — `workflow.jsonc` (JSON + comments + trailing commas) or strict-JSON `workflow.json` — that the control plane reads as **data**, never by executing the program. Comments are author-facing only: stripped on parse, never stored. The **stored manifest** is the descriptor plus the build-derived `input_schema` / `output_schema` (derived from `run`'s signature — a descriptor supplying either is a validation **error**, never a merge).

The descriptor field table: `slug` (the workflow's URL-safe identity — alphanumeric + hyphens; referenced by the CLI, `workflows.call`, and the API), `title` (optional human display label, free text one line; UIs fall back to a title-cased slug), `description`, `entry` (the package-relative file exporting `run`; omitted ⇒ the language default, `src/index.ts` / `main.py`, resolved at deploy — never defaulted in-schema), `triggers` (cron `{expr, timezone?, input?}` — `input` pins a static payload for every scheduled run, matched against `input_schema` when declared; omitted ⇒ no input / manual / webhook `{name}` / `workflow_run`), `env` (with `${{ secrets.NAME }}` whole-value interpolation), `workspace.persist` (`true | string[]` — program-level persistence; agent memory is auto-persisted separately, §2.1.1), `budget` (`max_usd` / `max_tokens` / `max_compute_seconds` — active compute only; every dimension is metered and pausable; there is **no `deadline_seconds`**), `concurrency`, `runs_on`, `files` (the non-code asset **allowlist** — relative globs; `skills/**` and `README.md` ride by convention). The **secret allowlist is `permissions.secrets`** (`{name}[]` — a readable secret is an access grant), not a top-level field. There are **no capability manifest fields** (`tools` / `mcp` / `skills`) — all agent capabilities are per-agent (§2.1.1).

**Concurrency:** `{ mode: "unlimited" }` (default) or `{ mode: "serial", key?: string }` — `serial` with no `key` is one run globally; with `key` it is one run per resolved key (this subsumes the old `serial_by_key`). `key` is a **runtime-interpolated template** over the input: literal text plus `${<path>}` interpolations, each path a restricted accessor **rooted at `input`** — dotted fields + `[index]` only (`input.customerId`, `input.items[0].sku`); no function calls, operators, or arbitrary expressions. The SDK ships the deploy-time **syntax** check (`validateConcurrencyKeyTemplate`, applied by `parseWorkflowDescriptor`); **value resolution happens at run creation on the control plane**, never in this SDK.

**Platform-extension fields** (in the schema, enforced only on hosted Boardwalk, documented as such): `permissions`, `egress`, `callable_by`, `notifications`, `container`. `permissions` is the access-grant surface — access-level knobs (`id_token` / `artifacts` / `contents`) plus the secret allowlist (`secrets: {name}[]`); it carries **no `tools` grant** (tool selection is per-agent, §2.1.1). Engines without the capability fail validation loudly when a workflow requires it (capability-presence rule).

**Not in v1** (rejected by the schema): `instructions`, `outcome`, `eval_sample_rate`, `scripts`, `chains`, `event` triggers + `events.emit`, and any integration/connection-flavored secret variants — a secret ref is exactly `{ name }`; **secrets + env vars are the entire credential story.** Some fields may return in later minors; v1 ships the surface above and nothing silent.

### 2.3 Schema rules

- One Zod schema, exported; TS types derived via `z.infer`. No hand-written manifest types.
- Unknown fields are **validation errors**.
- Every author-writable field carries a `.describe()`. The schema converts to the JSON Schema published at `https://boardwalk.sh/schemas/workflow.json`, which is what an editor shows on hover for the `$schema`-annotated `workflow.jsonc`, so a field without one ships an empty tooltip. Descriptions are **product copy**, not code comments: they follow the house copy rules (no em dashes), and `manifest.test.ts` asserts both coverage and that rule. Describe at the **field site**, not on a shared scalar, which would leak the same text everywhere the scalar is reused; the call survives on either side of `.optional()` / `.default()`.
- Any union members ordered **most-specific-first** (Zod unions are first-match-wins and objects strip unknown keys — a less-specific variant listed first silently drops fields). Round-trip tests assert with `toEqual`, never just `toBeDefined`.
- The descriptor surface (`descriptor.ts`, exported from the package root): `parseJsonc(text)` (hand-rolled, string-aware comment + trailing-comma stripping — no new dependency; stripped characters become spaces so `JSON.parse` error positions still point at the original text), `parseWorkflowDescriptor(text)` (JSONC parse → the manifest schema minus the derived I/O schemas → the concurrency-key syntax check; throws `DescriptorValidationError` listing every issue with its path), and `validateConcurrencyKeyTemplate(template)` (returns structured `ConcurrencyKeyTemplateIssue[]`; empty = valid). The old meta-literal surface (`WorkflowMeta`, `validateMeta`, `MetaValidationError`, the `/extract` subpath) is **deleted** — the descriptor replaces the meta literal wholesale.

### 2.4 The program↔host protocol (the engine seam)

Every capability import is a thin facade over a local **JSON-RPC 2.0 protocol** (`src/protocol.ts`): newline-delimited JSON frames over the stream socket named by `BOARDWALK_HOST_SOCK` (a Unix domain socket; a named pipe on win32). **Runner = server, SDK = client**, localhost-only inside the microVM. One contract, spoken by both the TypeScript and Python SDKs — a new capability lands in the protocol first, then in both SDKs, never SDK-first. This protocol is **part of the public contract** (engines — including third-party ones — implement the server side against the exported method schemas).

Method categories (one zod params/result schema per method, exported via `/runtime`):

- **Loader-only** (SDK infrastructure that brackets the run — never author API): `bootstrap` (`{}` → `{input, context}`; the context payload is DATA ONLY — the client synthesizes `context.signal` locally) and `report_return` (`{value}` → `{}`; the loader reports `run`'s return, `void` ⇒ `null`).
- **Author capabilities** (client → host requests): `agent`, `workflows.call` (result carries the callee's nullable `output_schema` for the revival pass), `workflows.run`, `workflows.schedule`, `sleep`, `humanInput`, `secrets.get`, `artifacts.write`, `computer.openBrowser` (+ the session-scoped `computer.browser.*` sub-namespace keyed by `sessionId`), `computer.openDesktop` (+ `computer.desktop.*`, same pattern), `shell`, `auth.idToken`, `auth.apiToken`, `usage.get`.
- **Client → host notification:** `phase` (fire-and-forget marker).
- **Host → client request** (full-duplex): `tool_invoke` `{call_id, tool, input}` → `{output}` — how an inline `agent()` tool runs. `opts.tools` crosses as **declarations only** (`{name, description, input_schema}`); the handler stays in the program process, keyed per agent call (`call_id` = the originating `agent` request's JSON-RPC id, as a string). Invocations multiplex + dispatch concurrently; a handler throw returns a JSON-RPC error the host feeds to the model as a tool-error result — never run-fatal; a late response to an abandoned invocation is discarded by id.
- **Host → client notification:** `cancel` — the SDK aborts `context.signal`.
- **Client-side only (NOT an RPC):** `parallel` — pure SDK sugar. Both SDKs implement the same `isRunFatal` set (re-throw `BUDGET_EXCEEDED`/`CANCELLED` or an explicit `fatal: true`; isolate everything else to `null`).

Errors are JSON-RPC `{code, message, data?}` with `code` a **string** from the engine error taxonomy (a deliberate deviation from the base spec's integers — the codes are what consumers branch on, and both ends ship pinned together via the release chain). A rejected request surfaces as a `HostError` carrying the code.

**Loader flow** (`@boardwalk-labs/workflow/runtime`): `connectHost()` → `client.bootstrap()` → import the entry → `run(input, context)` → `client.reportReturn(value)`. The connected client installs itself as the module-level active host (Node ESM caching guarantees the program and loader share one instance); a capability called with no active host lazily connects to `BOARDWALK_HOST_SOCK`, and throws a clear "no host available" error when there is none.

**Unit tests never touch a socket:** `installTestHost({ agent, secrets, workflows, shell, … })` installs an in-process fake implementing the same interface, so `run(input, context)` is a plain call over stubs. The returned handle builds a plausible frozen `Context` (`handle.context({...})`) wired to a cancellable signal (`handle.cancel()`).

### 2.5 The run-event wire format

Exported types + Zod schemas for the full event union: envelope (`runId`, `turnId`, per-turn 1-based `seq`, `t` ms-epoch) + run-global cursor (`turnNumber * 1_000_000 + seq`); event kinds `turn_started`, `turn_ended` (both carry the leaf's `agentId` + optional `agentName`; `turn_ended` adds `reason`, `usage?`, `error?`), `text_start/delta/end`, `tool_call_start / _input_delta / _input_complete / _executing / _result / _error`, `reasoning_delta`; `ToolReturn` (`kind?`, `humanSummary?`, `data?`), `TokenUsage`, error shape (`code`, `message`). Run-lifecycle frames (queued/running/terminal status), `phase()` boundary frames, `output()` frames, and captured-stdout/stderr frames are part of the same union.

**Channels:** every event kind maps to exactly one subscription channel — `lifecycle`, `phase`, `output`, `log`, `agent`. The SDK exports the `Channel` type, the kind→channel mapping, and the subscription-filter helper engines use server-side, so all engines and clients agree on what `?channels=phase,output` vs `verbose` means. Default subscription: `lifecycle + phase + output`. Cursors are global across channels — filtered subscriptions resume correctly.

## 3. Internal architecture

```
src/
  index.ts        — the author-facing capability imports + public exports
  types.ts        — option/argument types (AgentOptions, ToolDef, McpServerRef, SleepArg, …)
  protocol.ts     — the program↔host JSON-RPC contract: frame + per-method zod schemas,
                    Context/actor/trigger data schemas, HostError, isRunFatal
  host_client.ts  — the protocol client (BOARDWALK_HOST_SOCK), the active-host singleton,
                    installTestHost (the in-process fake for unit tests)
  revive.ts       — the schema-guided revival pass (ISO→Date, base64→Uint8Array, …)
  shell.ts        — shell() + ShellOptions/ShellResult
  runtime.ts      — the engine/loader-facing subpath export (/runtime)
  manifest.ts     — the Zod schema + derived component types
  descriptor.ts   — workflow.jsonc parsing/validation (parseJsonc, parseWorkflowDescriptor,
                    validateConcurrencyKeyTemplate, DescriptorValidationError)
  events.ts       — wire-format schemas + channels + cursor helpers
```

- **Dependencies:** `zod` (schemas). `typescript` is dev-only (the build). Every additional dependency needs PR justification — the JSONC parser is deliberately hand-rolled.
- The only I/O in this package is the protocol client's local socket (`node:net`). Everything else goes through the host.

## 4. Testing

- Manifest schema: exhaustive valid/invalid fixtures; round-trip (`parse` → `toEqual`) for every union member; unknown-field rejection (incl. the deleted `deadline_seconds` / `max_duration_seconds` / `serial_by_key`); env interpolation cases; cron expr edge cases; `entry` / `files` path safety.
- Descriptor: JSONC edge cases (comments inside strings survive, escaped quotes, trailing commas in objects + arrays, CRLF, unterminated block comment); the `input_schema`/`output_schema` build-derived rejection; issue-collecting error messages; concurrency-key template syntax (valid nested dots + `[index]`; invalid: not rooted at `input`, function calls, operators, unclosed `${`, empty path).
- Protocol: schema round-trips (`toEqual`) for every method's params/result and every frame/actor variant; string-code error shape; `isRunFatal` semantics.
- Client ↔ host: a fake host server over a REAL socket covers concurrent request multiplexing, `tool_invoke` dispatch (declaration-only tools, concurrent invocations, handler throw → error response, unknown/abandoned call → error), `cancel` → signal abort, `bootstrap`/`report_return`, late-response discard, and the facades end-to-end (incl. `workflows.call` revival).
- Revival: golden tests per rich type (`Date`/`bigint`/`Uint8Array`/`Set`), nested structures, `$defs` recursion, and null-schema passthrough; mismatches never throw.
- Capabilities: `installTestHost` proves delegation, stub defaults, the no-host error, and that a sample `run(input, context)` is unit-testable as a plain call.
- Wire format: cursor monotonicity + resume filtering; schema round-trips for every event kind.

## 5. Ready to go public when

1. The API in §2 is implemented and exported — nothing more (no engine imports, no leftover undocumented exports).
2. `npm pack` contains exactly: built JS + d.ts + README + LICENSE.
3. Docs: every export has a docstring; README quickstart authors a workflow in <60 seconds of reading.
4. Conformance fixtures consumed by the engine repo compile against the published types.
5. Publication checklist passes.
