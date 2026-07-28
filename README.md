# @boardwalk-labs/workflow

Author **Boardwalk workflows** in plain TypeScript — agent loops, schedules, durable sleeps, and cross-workflow composition, in a single program file that runs identically on your laptop, your own server, or the hosted Boardwalk platform.

```ts
// src/index.ts — the entry: export a run function, the platform calls it.
import { agent, secrets } from "@boardwalk-labs/workflow";

export default async function run(): Promise<string> {
  const token = await secrets.get("GITHUB_TOKEN");
  const issues = await fetch("https://api.github.com/issues", {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.text());

  return await agent(`Summarize for a morning digest:\n${issues}`);
}
```

```jsonc
// workflow.jsonc — the deployment descriptor, read by the control plane as data.
{
  "slug": "morning-digest",
  "title": "Morning Digest",
  "description": "Summarize my open issues every weekday at 9am",
  "triggers": [{ "kind": "cron", "expr": "0 9 * * 1-5" }],
  "permissions": { "secrets": [{ "name": "GITHUB_TOKEN" }] },
}
```

A workflow is **a typed function plus a small descriptor**: your behavior is the `run` function (input is param 0, the output is the return value — Lambda-style), and deployment policy (triggers, permissions, budget, concurrency) lives in `workflow.jsonc`, which the control plane reads without ever executing your code. Ordinary TypeScript throughout: any import, any control flow, any npm dependency.

## What's in this package

| Import                             | What it is                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@boardwalk-labs/workflow`         | The author API: `agent()`, `sleep()`, `workflows.call()`, `secrets.get()`, `artifacts.write()`, `parallel()`, `phase()`, `installTestHost()` — plus the manifest schema, `workflow.jsonc` descriptor parsing/validation, and the run-event wire format |
| `@boardwalk-labs/workflow/runtime` | The **engine/loader-facing** API: the program↔host protocol schemas and client. Authors never import this                                                                                                                                              |

## The primitives

- **`agent(prompt, opts?)`** — run an agent loop and get its final text (or `schema`-validated JSON). `model` is optional: name one explicitly, or let the engine resolve it. The engine's **built-in coding tools** (read/write/edit/ls/grep/glob/bash/apply_patch/webfetch/web_search/artifacts/lsp) are **on by default** — a plain `agent(prompt)` can already work the run's workspace; `builtins` scopes them (`"all"` · `"read-only"` · `"none"` · a subset). Everything else is brought **per call**: inline **tools**, **MCP servers**, **skills**, and **memory**; the manifest declares none of them.
- **`sleep(ms | { until })`** — durable wait. On hosted runners a short wait holds and a long one suspends (the machine is snapshotted and released, then restored on wake — locals survive either way, and suspended idle time is not billed). Engines without a snapshot substrate (local dev, self-hosted runners) hold the process for the whole wait. Plain `Date.now()` / `Math.random()` / `crypto.randomUUID()` work like ordinary TypeScript — a suspended run resumes with its exact program state.
- **`workflows.call(slug, input)`** — durably invoke another workflow by its slug and await its result; idempotent across restarts. `workflows.run` is the fire-and-forget sibling.
- **`secrets.get(name)`** — read a secret declared in `permissions.secrets`. Resolved from your `.env` locally, from the encrypted vault on hosted Boardwalk. Secret values never reach model context — the SDK contract requires engines to redact them.
- **The return value** — your `run` function's return is the run's output, persisted and handed to `workflows.call` parents.
- **Memory = a persistent directory, per agent.** `agent(prompt, { memory: "memory/triager" })` names any workspace-relative directory; the engine auto-persists it across runs — no declaration needed. The loop gets read/write file tools scoped to it, and your code can read and write the same files. (`workspace.persist` is the separate knob for non-memory state your program manages directly.)

## Where workflows run

The same file runs on two engines: the self-hosted Boardwalk engine (your own server, no account) or [the Boardwalk platform](https://boardwalk.sh) (`boardwalk run` — hosted, scheduled, with automatic model routing; `boardwalk check` validates the file first). The manifest schema and event stream are the same everywhere; engine differences are limited to documented resolution behavior.

The full authoring contract — every primitive, the manifest field inventory, and the run-event wire format — is in [`SPEC.md`](./SPEC.md).

## The Boardwalk repos

- [`boardwalk`](https://github.com/boardwalk-labs/boardwalk) — the open-source single-node engine: cron scheduling, webhooks, durable runs, run history
- [`cli`](https://github.com/boardwalk-labs/cli) — `boardwalk`: scaffold, validate, deploy, run
- [`examples`](https://github.com/boardwalk-labs/examples) — copyable workflow templates (`boardwalk init --template`)
- [`plugins`](https://github.com/boardwalk-labs/plugins) — skills + MCP server for Claude Code, Codex, Cursor, OpenClaw, OpenCode
- [`runner`](https://github.com/boardwalk-labs/runner) — self-hosted runner: your machines execute hosted-scheduled runs

Hosted platform and docs: [boardwalk.sh](https://boardwalk.sh).

## License

MIT
