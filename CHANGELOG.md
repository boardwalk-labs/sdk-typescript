# Changelog

Notable changes to `@boardwalk-labs/workflow` — the workflow authoring contract (SDK primitives,
the `meta` → manifest schema, the run-event wire format). Pre-1.0, additive changes ship as
patch releases.

## 0.3.3

### Added

- **`github` trigger kind** — `{ "kind": "github", "event", "repos"? }` joins the trigger union.
  The event vocabulary is semantic, curated names (`pr.opened`, `pr.merged`, `issue.opened`,
  `issue.commented`, `ci.completed`), each mapping platform-side to a tested provider event +
  condition — authors never write raw provider actions or payload filters. `repos` narrows to
  `owner/name` full names; omitted covers every repo the org's GitHub connection includes.

  ```jsonc
  { "triggers": [{ "kind": "github", "event": "pr.merged", "repos": ["acme/api"] }] }
  ```

  The descriptor carries no URL and no secret: delivery, signature verification, filtering, and
  dedupe all happen platform-side through the org's GitHub connection, before any run is created.
  Exported: `GITHUB_TRIGGER_EVENTS`, `GithubTrigger`, `GithubTriggerEvent`.

## 0.3.2

### Added

- **`workspace.key`** — an optional template that scopes a workflow's persistent workspace, so ONE
  workflow keeps N independent compounding states (per customer, per repo, per tenant). Without it,
  per-customer state forces N workflows or N environments, neither of which is what the author means.

  ```jsonc
  { "workspace": { "persist": ["index"], "key": "${input.repo}" } }
  ```

  It uses exactly the grammar of `concurrency.key` — `${input.<path>}` interpolations, each a
  restricted accessor rooted at `input` — and is validated at deploy by the same checker, which now
  names the offending FIELD so an author with both set knows which template to fix. Value resolution
  happens at run creation on the control plane, never in this package.

  `workspace.key` is an **independent axis** from `concurrency.key`, sharing only the grammar. They
  answer different questions — which state do I compound into, versus how many runs may execute at
  once — so an author may set one, the other, both, or neither, with different templates. Persistence
  is made safe by the store's merge, never by serializing.

## 0.3.1

### Added

- **`workspace_persist_skipped`** run event (`log` channel) — the frame a producer needs to tell an
  author that a `/workspace` snapshot was dropped, carrying `reason` plus `bytes` / `maxBytes` /
  `detail` where known. Publishing it gates the runner change that emits it: an unknown kind has no
  variant to match, so `parseRunEventLenient` drops the whole frame.

## 0.3.0

### Changed (breaking — the descriptor replaces the meta literal)

The workflow-format redesign's schema half (P4). Deployment policy is now a hand-written
`workflow.jsonc` (or strict-JSON `workflow.json`) descriptor the control plane reads as data —
the pure-literal `meta` export and its static extraction are deleted wholesale (an approved
clean break; published consumers pin old versions).

- **New: `descriptor.ts`** (exported from the package root):
  - `parseJsonc(text)` — hand-rolled JSONC parsing (no new dependency): strips `//` and
    `/* */` comments and trailing commas without touching string contents (escape-aware),
    then `JSON.parse`. Comments are author-facing only — stripped on parse, never stored.
  - `parseWorkflowDescriptor(text)` — JSONC parse → validation against
    `workflowManifestSchema` minus the build-derived `input_schema` / `output_schema` (a
    descriptor supplying either is an ERROR with a targeted message — those derive from
    `run`'s signature) → the concurrency-key template syntax check. Returns the typed
    `WorkflowDescriptor`; throws `DescriptorValidationError` listing every issue with its
    path.
  - `validateConcurrencyKeyTemplate(template)` — the deploy-time SYNTAX check for
    `concurrency.key`: well-formed `${…}` interpolations, each path a restricted accessor
    rooted at `input` (dotted fields + `[index]` only — no function calls, operators, or
    arbitrary expressions). Returns structured `ConcurrencyKeyTemplateIssue[]`. VALUE
    resolution happens at run creation on the control plane, not in this SDK.
- **Changed: the manifest schema (`workflowManifestSchema`).**
  - `budget.deadline_seconds` is **deleted** (no wall-clock cap; every budget dimension is
    metered and pausable).
  - `budget.max_duration_seconds` is **renamed `max_compute_seconds`** (still active-compute
    only; no alias).
  - `concurrency` is now `{ mode: "unlimited" }` (default) | `{ mode: "serial", key?: string }`
    — `serial` with `key` is one run per resolved key, subsuming the deleted `serial_by_key`
    variant. `key` is a runtime-interpolated template over the input.
  - **New optional fields:** `entry` (the package-relative file exporting `run`; omitted ⇒
    the language default `src/index.ts` / `main.py`, resolved at deploy) and `files` (the
    non-code asset allowlist — relative globs; `skills/**` + `README.md` ride by convention).
- **Removed: the meta-literal surface.** `src/meta.ts` and `src/extract.ts` are deleted:
  the `WorkflowMeta` type, `validateMeta`, `MetaValidationError`, and the
  `@boardwalk-labs/workflow/extract` subpath (`extractMetaLiteral` / `extractManifest` /
  `MetaExtractionError`) are gone. Manifest component types (`Trigger`, `Budget`,
  `Concurrency`, `RunsOn`, …) are now derived from the Zod schema and re-exported from the
  root; `McpServerRef` (a per-agent option, not a manifest type) moved to `types.ts`
  unchanged. `typescript` is no longer a runtime dependency (it powered only the deleted
  AST extractor).

### Changed (breaking — the function model: `run(input, context)` + the host protocol)

The workflow-format redesign lands its SDK half (P0 + P2; an approved clean break — published
consumers pin old versions). A workflow is now a **typed function**: you
`export default async function run(input, context)` and the platform calls it — the module body
no longer executes as the run, input is param 0, the output is the return value, and read-only
run metadata is param 1.

- **New: the program↔host protocol (`protocol.ts`).** Capabilities are now thin clients of a
  JSON-RPC 2.0 contract over the local socket named by `BOARDWALK_HOST_SOCK` (Unix socket;
  named pipe on win32), newline-delimited JSON frames, runner = server / SDK = client — one
  contract both the TS and Python SDKs speak. Zod schemas + types are exported for every
  method: loader-only `bootstrap` / `report_return`; the author capabilities (`agent`,
  `workflows.*`, `sleep`, `humanInput`, `secrets.get`, `artifacts.write`,
  `computer.openBrowser` + the `computer.browser.*` sub-namespace, `shell`, `auth.*`,
  `usage.get`); the `phase` notification; the full-duplex host→client `tool_invoke` callback
  (inline `agent()` tools cross as declarations only — `{name, description, input_schema}` —
  and their handlers run in the program process; a handler throw is a tool-error result, never
  run-fatal); and the host→client `cancel` notification. Errors are `{code, message, data?}`
  with STRING taxonomy codes; `isRunFatal` / `RUN_FATAL_CODES` / `HostError` are exported.
- **New: `Context`** (+ `TriggerInfo`, `Actor`) — the frozen v1 field set: `runId`,
  `workflowId`, `workflowVersion`, `orgId`, `environment`, `actor`, `attempt`, `trigger`,
  `workspaceDir`, `signal`. The wire carries context DATA only; the client synthesizes
  `signal` from `cancel`. Append-only forever.
- **New: `auth.{idToken, apiToken}`** (the credential mints, split out of the removed
  `runtime`) and **`usage.get()`** (live `{spent, cap, remaining}` per budget dimension —
  `usd`, `tokens`, `compute_seconds`; `cap`/`remaining` null when uncapped).
- **New: `installTestHost(overrides)`** — an in-process fake host, so `run(input, context)` is
  a plain unit-test call over stubs (no socket, no engine). Its handle builds a plausible
  frozen `Context` and can simulate cancellation. Replaces the `/runtime`
  `installHost`/`installInput`/`installConfig` seam.
- **Changed: `workflows.call` revives its result.** The call's result carries the callee's
  `output_schema`, and the SDK applies a generic schema-guided revival pass (exported as
  `reviveBySchema` on `/runtime`): ISO date-time → `Date`, integer-pattern string → `bigint`,
  base64 → `Uint8Array`, uniqueItems array → `Set`. An untyped callee returns plain JSON.
- **Changed: `shell()` is protocol-backed and async** — `Promise<ShellResult>`
  (`{exitCode, stdout, stderr}`); a non-zero exit resolves (check `exitCode`) instead of
  throwing, and it no longer runs `execSync` in-process.
- **Changed: `/runtime`** is now the engine/loader-facing surface: `connectHost` /
  `HostClient` (with `bootstrap()` / `reportReturn()`), the protocol schemas, and
  `reviveBySchema`.
- **Removed:** the `input` and `config` live bindings, `output()`, the `runtime` namespace
  (ids live on `context`; the mints are `auth.*`), the `WorkflowHost`/`RuntimeContext` seam
  (`installHost`, `installInput`, `installConfig`, `takeDeclaredOutput`, `resetRuntime`,
  `requireHost`, and the internal `recordOutput` path — `src/host.ts` is deleted).
- **Unchanged:** the run-event wire format exports, `normalizeReasoning`, `parallel()`
  semantics, and the `agent()` author surface (`AgentOptions` incl. `ToolDef`). (The
  manifest module and the `/extract` subpath, unchanged by this entry, are reshaped by the
  descriptor entry above — both land in the same release.)

## 0.2.5

### Changed (breaking — `parallel()` isolates a failed task instead of rejecting the whole batch)

`parallel()` was `Promise.all`: one thunk that threw rejected the entire call, discarding the work of
its siblings — so one non-deterministic `agent()` failing (a stuck leaf, a transient model error) took
down a whole fan-out. It now runs every thunk to completion; a thrown thunk becomes `null` in its slot
(and the failure is logged), so the healthy tasks survive. Filter the nulls to use the successes:
`(await parallel(tasks)).filter((r) => r !== null)`. A run-fatal rejection — the budget being exhausted
or the run cancelled (`code` `BUDGET_EXCEEDED` / `CANCELLED`, or an explicit `fatal` flag) — still
rejects, because the whole run must stop. The return type is now `(T | null)[]`.

## 0.2.0

### Removed (breaking — the determinism tax is deleted)

The snapshot substrate makes the whole VM the durable unit: a suspended run resumes with its
exact heap, so nothing replays and no value needs to be journaled. The replay-era author
surface is deleted outright, not deprecated:

- **Durable `now()` / `random()` / `uuid()`.** Write plain `Date.now()` / `Math.random()` /
  `crypto.randomUUID()` — a suspended run resumes with the same values because it resumes with
  the same memory. (Post-snapshot CSPRNG uniqueness is the engine's job, not the author's.)
- **`step` / `step.run(name, fn)`** and the `WorkflowHost.step` hook. Its only behavior was
  journal memoization across resumes; with the heap durable it collapses to `await fn()`. The
  crash model is restart-from-top: side effects re-run on a crash, so a memoization primitive
  would promise a durability it can't deliver.
- **The `/lint` subpath** (`lintDeterminism`, `DeterminismWarning`, `LintOptions`). With no
  determinism contract to enforce there is nothing to lint; `boardwalk deploy` no longer blocks
  on bare clock/random calls and `--allow-nondeterminism` is gone from the CLI.

## 0.1.29

### Added

- **`AgentOptions.cwd`.** The workspace-relative directory an `agent()` leaf works from. Re-roots
  the leaf's workspace view — built-in file tools resolve and confine paths under it, `bash` starts
  there, the ambient workspace orientation describes it, and `AGENTS.md` project context is
  discovered from it — so a run driving several agents in different checkouts gives each one clean
  repo-relative paths. Must name an existing directory inside the workspace (fails loudly
  otherwise); `memory` stays workspace-root-relative; a `subagent` inherits the parent's `cwd`.
  Scoping, not a security boundary — the run's sandbox remains the isolation boundary.

## 0.1.28

### Added

- **`runtime.idToken(audience)`.** Mint a short-lived OIDC id-token (JWT) asserting the run's
  identity for the given audience, to exchange with an external cloud's federation endpoint —
  AWS `AssumeRoleWithWebIdentity`, GCP workload identity, Azure federated credentials — instead
  of storing long-lived cloud keys in secrets. Requires `permissions.id_token: "write"` in the
  workflow's meta (schema already present). Backed by the new required `idToken` method on
  `RuntimeContext` (engine seam); engines that supply no runtime context are unaffected — every
  `runtime.*` accessor already throws a clear error there.

## 0.1.27

### Removed

- **`boardwalk/linux-large` hosted runner label.** A larger machine is the `runs_on` `size` selector
  (`{ label: "boardwalk/linux", size: "large" }`) — a per-run resource override on the one image, never
  a distinct label. The label was redundant with `size` and had no `-medium`/`-xlarge` peer, so it is
  dropped from the `runs_on` schema and the `HostedRunsOn` type. Sizing is unchanged: `size` still spans
  `small`–`xlarge` on any hosted label. A manifest using `boardwalk/linux-large` must switch to the size
  form.

## 0.1.26

### Added

- **`egress_denied` run-event kind.** A host-observed egress denial on the `log` channel: the runtime
  substrate's per-host proxy blocked the run's attempt to reach `host` (a `custom`-allowlist miss, or
  an always-on guard like the private-range/metadata deny). Emitted by the substrate, not the workflow
  program — it surfaces WHY a fetch failed instead of an opaque network error. Carries
  `{ host, method?, reason }`; non-terminal.

## 0.1.21

### Added

- **`AgentOptions.maxIterations`** — an optional per-`agent()` ceiling on tool-calling turns. Omit
  (the default) for no cap: the leaf runs until the model stops calling tools, bounded by the run
  budget, the repetition guard, and cancellation. A positive integer caps the leaf as a **soft**
  landing — the turn past the ceiling withholds tools so the model must give a final answer rather
  than the run failing. Non-integer / `< 1` values are ignored. (Consumed by `@boardwalk-labs/engine`
  once its dep is bumped to this build.)

## 0.1.18

### Changed

- **`runs_on: { kind: "self-hosted" }` defaults `pool` to `"default"`.** The pool
  `boardwalk runner start` creates; naming it explicitly is now optional. Parsed manifests
  always carry a concrete `pool`.

## 0.1.17

### Added

- **Durable clock + randomness: `now()` / `random()` / `uuid()`.** A workflow program replays from the
  top on a resume (durable suspension) and a crash, so a bare `Date.now()` / `new Date()` /
  `Math.random()` / `crypto.randomUUID()` re-runs and yields a _different_ value each segment —
  silently corrupting any value captured before a `sleep`/`humanInput` and read after it. These
  capture the value once through the durable `step` seam and memoize it, so it survives a
  suspend/resume and a crash-restart unchanged. `now()` is epoch ms (`new Date(await now())` for a
  Date); `random()` is a float in [0, 1); `uuid()` is a v4 id. Each is one journaled step (a broker
  round-trip), so capture a value once rather than calling in a hot loop.

### Changed

- **Determinism lint (`@boardwalk-labs/workflow/lint`) now covers crypto randomness and points at the
  primitives.** Added `crypto.randomUUID` / `crypto.getRandomValues` / bare `randomUUID` to the
  flagged set, and each clock/random/uuid warning now names its durable replacement (`now()` /
  `random()` / `uuid()`) instead of only `step.run`. The lint itself stays a pure function returning
  warnings; enforcement is the caller's policy (the CLI fails `deploy` on warnings unless
  `--allow-nondeterminism` is passed).

## 0.1.16

### Added

- `runtime` — the run's identity + on-demand platform credential, imported as
  `import { runtime } from "@boardwalk-labs/workflow"`. Synchronous `runtime.runId` /
  `runtime.workflowId` / `runtime.orgId` / `runtime.apiUrl`, plus `await runtime.apiToken()` for a
  short-lived, manifest-scoped bearer to call the public API / MCP / CLI. Platform credentials are
  no longer placed in `process.env`, so `apiToken()` is the supported way to reach the bearer; it is
  redacted from all LLM context. Backed by the new optional `WorkflowHost.runtime` host seam.

### Changed

- **Env var names are unrestricted.** The `meta.env` validator no longer rejects the `BOARDWALK_*` /
  `AWS_*` prefixes — the program owns `process.env` outright. Platform context + credentials reach a
  run out of band (never as env), so a user var can't shadow anything.

## 0.1.15

### Fixed

- `budget.deadline_seconds` is now part of the `Budget` / `WorkflowMeta` TYPE. It shipped in 0.1.13
  in the manifest schema (so the runtime accepted it) but was never added to the hand-written
  interface, so `budget: { deadline_seconds: N } satisfies WorkflowMeta` failed `tsc` even though a
  deployed run honored it. The contract guard only compared top-level keys, so the nested drift went
  unnoticed; it now also asserts the nested `budget` key set matches the schema.

## 0.1.14

### Added

- `workflow_run` trigger — react to another workflow's run finishing (GitHub-Actions `on:
workflow_run`). A workflow declares `triggers: [{ kind: "workflow_run", workflows: ["ci"],
conclusions: ["success"] }]` to run when any named upstream workflow (slug, same org) completes,
  optionally filtered by conclusion (`success` / `failure` / `cancelled`); the run-event payload
  becomes the triggered run's input. Server engines only.

## 0.1.13

### Added

- `budget.deadline_seconds` — a WALL-CLOCK cap (including suspended idle) distinct from
  `max_duration_seconds`, which is now defined as ACTIVE COMPUTE time only (a long sleep,
  human-input gate, or child-wait does NOT burn it). Use the two together for "cap runaway compute
  AND give up if the whole thing isn't done within N real-world seconds."
- `@boardwalk-labs/workflow/lint` — `lintDeterminism(source)`, a shared, AST-based determinism lint
  (the CLI, the engines, and the hosted deploy all call it). Flags bare `Date.now` / `Math.random`
  / `new Date()` / `performance.now` / `fetch` that sit OUTSIDE a journaled seam (`step.run` /
  `agent`), where a restart/resume would re-run them with a different value. Advisory — it returns
  warnings, it never blocks.

## 0.1.12

### Added

- **Durable suspension hooks.** `humanInput(opts)` pauses the run for a person to answer and resumes
  with their validated response; the `input` form is a discriminated union — `text`, `choice`, or
  `multiselect` (each with an optional trailing open-text entry) — and the return type follows the
  kind. `step.run(name, fn)` runs a side-effecting function once and memoizes its result so it is not
  re-run on a resume. Both are facades over new OPTIONAL `WorkflowHost` methods (`humanInput`,
  `step`), so an engine that doesn't implement them makes the hook throw a clear error (the
  `workflows.run` / `artifacts.write` pattern).
- `AgentOptions.humanInput?: boolean` — opt a leaf into the `human_input` tool, letting the model
  pause the run mid-loop to ask a person (off by default).
- Run-event kinds on the `lifecycle` channel: `suspended` (`reason: "sleep" | "human_input" |
"child"`, optional `wakeAt`), `resumed`, `human_input_requested` (`requestId`, `key`, `prompt`),
  and `human_input_resolved` (`requestId`, `key`).
- Run statuses `sleeping`, `awaiting_input`, and `waiting_for_child` (non-terminal suspended states).
- `@boardwalk-labs/workflow/runtime` re-exports the human-input option/result types for engines
  implementing `WorkflowHost.humanInput`.

All changes are additive and backward-compatible.

## 0.1.11

### Added

- `@boardwalk-labs/workflow/runtime` now re-exports `ScheduleOptions`, so an engine implementing
  `WorkflowHost.scheduleWorkflow` can import it from the runtime entry point alongside the other
  hook option types.

### Changed

- Neutralized the reasoning-effort docstrings (`ReasoningEffort` / `AgentOptions.reasoning`): the
  effort scale is described on its own terms, with no provider/back-end name in the public types.

## 0.1.8

### Added

- `tool_output_delta` run-event kind (`toolCallId`, `stream: "stdout" | "stderr"`, `text`) on the
  `agent` channel — streams a tool's output as it is produced (e.g. a long `bash` command). The
  final `tool_call_result` still carries the complete bounded output; deltas are the live view.

## 0.1.6

### Changed

- The engine's built-in coding tools (`read`, `write`, `edit`, `ls`, `grep`, `glob`, `bash`,
  `apply_patch`, `webfetch`, `web_search`, `artifacts`, `lsp`) are now **on by default** — a plain
  `agent(prompt)` can read, edit, and run commands in the run's workspace with no declaration.
- `AgentOptions.tools` is narrowed to `readonly ToolDef[]` — it is now ONLY a leaf's inline
  program-defined tools, added on top of the built-ins. Built-in tools are no longer named here
  to enable them (they are default-on, scoped by `builtins`).

### Added

- `AgentOptions.builtins` (`"all" | "read-only" | "none" | readonly string[]`, default `"all"`) —
  scopes the default-on built-in set per `agent()` call: `"all"` is every built-in, `"read-only"`
  is the non-mutating subset (drops `write`/`edit`/`apply_patch`/`bash`/artifact writes), `"none"`
  removes them entirely, and a `string[]` names an explicit subset.

## 0.1.1

### Added

- `AgentOptions.name` — an optional human display label for an `agent()` leaf, echoed onto its
  `turn_started` / `turn_ended` events as `agentName`. It lets a stream consumer tell concurrent
  agents apart (e.g. a `reviewer` and a `summarizer` running under `parallel`). It is not an
  identifier and need not be unique.
- `turn_started` / `turn_ended` run events now carry `agentId` — a stable, run-unique identifier
  the engine assigns to each leaf — alongside the optional `agentName`.

Both changes are backward-compatible: existing programs and event consumers are unaffected.

## 0.1.0

Initial public release: the workflow authoring contract — the SDK primitives, the pure-literal
`meta` → manifest derivation and its Zod schema, and the run-event wire format with channel
mapping.
