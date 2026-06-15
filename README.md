# @boardwalk-labs/workflow

Author **Boardwalk workflows** in plain TypeScript — agent loops, schedules, durable sleeps, and cross-workflow composition, in a single program file that runs identically on your laptop, your own server, or the hosted Boardwalk platform.

```ts
import { agent, output, secrets, type WorkflowMeta } from "@boardwalk-labs/workflow";

export const meta = {
  slug: "morning-digest",
  title: "Morning Digest",
  description: "Summarize my open issues every weekday at 9am",
  triggers: [{ kind: "cron", expr: "0 9 * * 1-5" }],
  permissions: { secrets: [{ name: "GITHUB_TOKEN" }] },
} satisfies WorkflowMeta;

const token = await secrets.get("GITHUB_TOKEN");
const issues = await fetch("https://api.github.com/issues", {
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.text());

const summary = await agent(`Summarize for a morning digest:\n${issues}`);
output(summary);
```

A workflow is **a script**: the `meta` export is a **pure literal** (engines derive the manifest from it statically, without executing your code), and the module body is the program — importing the file is running it. Top-level `await` is the norm; `output(value)` declares the result. Ordinary TypeScript throughout: any import, any control flow, any npm dependency.

## What's in this package

| Import                             | What it is                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@boardwalk-labs/workflow`         | The author API: `agent()`, `sleep()`, `workflows.call()`, `secrets.get()`, `artifacts.write()`, `parallel()`, `input` / `output()` / `config`, `phase()` — plus the manifest schema and run-event wire format |
| `@boardwalk-labs/workflow/runtime` | The **engine-facing** API: install a `WorkflowHost` before evaluating a program. Authors never import this                                                                                                    |
| `@boardwalk-labs/workflow/extract` | Static `meta` → manifest extraction (AST-based, never executes the program). Used by engines and tooling                                                                                                      |

## The primitives

- **`agent(prompt, opts?)`** — run an agent loop and get its final text (or `schema`-validated JSON). `model` is optional: name one explicitly, or let the engine resolve it. Loops can use **tools** (built-in or program-defined), **MCP servers**, **skills**, and **memory** — each brought **per call** on `agent()`; the manifest declares none of them.
- **`sleep(ms | { until })`** — durable wait; the run holds, locals survive.
- **`workflows.call(slug, input)`** — durably invoke another workflow by its slug and await its result; idempotent across restarts. `workflows.run` is the fire-and-forget sibling.
- **`secrets.get(name)`** — read a secret declared in `permissions.secrets`. Resolved from your `.env` locally, from the encrypted vault on hosted Boardwalk. Secret values never reach model context — the SDK contract requires engines to redact them.
- **`output(value)`** — declare the run's result.
- **Memory = a persistent directory, per agent.** `agent(prompt, { memory: "memory/triager" })` names any workspace-relative directory; the engine auto-persists it across runs — no declaration needed. The loop gets read/write file tools scoped to it, and your code can read and write the same files. (`workspace.persist` is the separate knob for non-memory state your program manages directly.)

## Where workflows run

The same file runs on three engines: `boardwalk dev` (locally, no account), the self-hosted Boardwalk engine (your own server), or [the Boardwalk platform](https://boardwalk.sh) (`boardwalk deploy` — hosted, scheduled, with automatic model routing). The manifest schema and event stream are the same everywhere; engine differences are limited to documented resolution behavior.

The full authoring contract — every primitive, the manifest field inventory, and the run-event wire format — is in [`SPEC.md`](./SPEC.md).

## License

MIT
