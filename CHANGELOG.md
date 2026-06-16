# Changelog

Notable changes to `@boardwalk-labs/workflow` — the workflow authoring contract (SDK primitives,
the `meta` → manifest schema, the run-event wire format). Pre-1.0, additive changes ship as
patch releases.

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
