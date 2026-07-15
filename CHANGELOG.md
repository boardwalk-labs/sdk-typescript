# Changelog

Notable changes to `@boardwalk-labs/workflow` — the workflow authoring contract (SDK primitives,
the `meta` → manifest schema, the run-event wire format). Pre-1.0, additive changes ship as
patch releases.

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
