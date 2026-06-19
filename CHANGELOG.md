# Changelog

Notable changes to `@boardwalk-labs/workflow` — the workflow authoring contract (SDK primitives,
the `meta` → manifest schema, the run-event wire format). Pre-1.0, additive changes ship as
patch releases.

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
