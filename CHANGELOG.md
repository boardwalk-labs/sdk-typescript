# Changelog

Notable changes to `@boardwalk-labs/workflow` — the workflow authoring contract (SDK primitives,
the `meta` → manifest schema, the run-event wire format). Pre-1.0, additive changes ship as
patch releases.

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
