// SPDX-License-Identifier: MIT

// workflowManifestSchema — the validator of record for a workflow's manifest.
//
// One Zod schema, consumed by every engine (local `dev`, the self-hosted server, Boardwalk
// hosted platform) and by `descriptor.ts` after JSONC parsing. The stored manifest is the
// hand-written descriptor (`workflow.jsonc`) plus the build-derived `input_schema` /
// `output_schema`. TS types are derived from the schema, never hand-written. Unknown fields
// are validation errors — no silent drift.
//
// Union ordering rule: most-specific-first. Zod unions are first-match-wins and strict objects
// reject extras, but keep the discipline anyway — a less-specific variant listed first can
// silently strip fields if an object is ever relaxed from strict.

import { z } from "zod";

// ============================================================================
// Shared scalars
// ============================================================================

const SLUG_RE = /^[a-zA-Z0-9-]+$/;

/** The workflow's identity: a URL-safe slug, stable across the program's life (referenced by the
 *  CLI, `workflows.call`, and the API). The human-readable label is `title`, not this. */
const workflowSlug = z
  .string()
  .min(1)
  .max(100)
  .regex(SLUG_RE, "slug must be alphanumeric with hyphens");

/** The workflow's display label — free text, author-controlled. Falls back to a title-cased slug
 *  in UIs when omitted. One line only. */
const workflowTitle = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !s.includes("\n"), "title must be a single line");

/** A short identifier (tool/MCP/skill/secret names). */
const shortName = z.string().min(1).max(120);

/** Loosely-typed JSON Schema objects (input_schema / output_schema / tool inputSchema). */
const jsonSchemaObject = z.record(z.string(), z.unknown());

// ============================================================================
// Triggers
// ============================================================================

const cronExpr = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (expr) => {
      const fields = expr.trim().split(/\s+/);
      return fields.length === 5 || fields.length === 6;
    },
    { message: "cron expression must have 5 fields (standard) or 6 (with seconds)" },
  );

const cronTriggerSchema = z
  .strictObject({
    kind: z.literal("cron"),
    expr: cronExpr.describe("Cron expression: 5 fields (standard) or 6 (with seconds)."),
    timezone: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "IANA timezone the expression is evaluated in, for example `America/Anchorage`. " +
          "Omitted: UTC.",
      ),
    // Static input for each scheduled run (must satisfy the workflow's input_schema when declared).
    // Omitted ⇒ the run fires with no input. A JSON object, mirroring input_schema's `type: object`.
    input: jsonSchemaObject
      .optional()
      .describe(
        "Static input passed to every scheduled run. Must satisfy the workflow's derived input " +
          "schema. Omitted: the run fires with no input.",
      ),
  })
  .describe("Run on a schedule.");

const webhookName = z
  .string()
  .min(1)
  .max(100)
  .regex(SLUG_RE, "webhook name must be alphanumeric with hyphens");

/** Attach to one of the org's webhooks. Any number of workflows may attach to the same one, and all
 *  of them run on every delivery — narrow with the sender's own event picker, not a filter here.
 *  Only the NAME is program logic; URL/secret/verification are console-owned deployment wiring. */
const webhookTriggerSchema = z
  .strictObject({
    kind: z.literal("webhook"),
    name: webhookName.describe("Name of the org webhook endpoint to attach to."),
  })
  .describe(
    "Run when one of the org's webhook endpoints receives a delivery. Only the name lives here: " +
      "the URL, secret, and verification are console-owned wiring.",
  );

const manualTriggerSchema = z
  .strictObject({
    kind: z.literal("manual"),
  })
  .describe(
    "Run on demand: from the CLI, the console, the API, or another workflow's `workflows.call`.",
  );

/** React to ANOTHER workflow's run finishing (GitHub-Actions `on: workflow_run`). When any of the
 *  named upstream workflows (slugs in the same org) completes, this workflow runs with the run-event
 *  payload as its input. `conclusions` optionally narrows to specific outcomes; omitted = any. */
const workflowRunTriggerSchema = z
  .strictObject({
    kind: z.literal("workflow_run"),
    workflows: z
      .array(workflowSlug)
      .min(1)
      .max(20)
      .describe("Slugs of the upstream workflows to watch, in the same org."),
    conclusions: z
      .array(z.enum(["success", "failure", "cancelled"]))
      .min(1)
      .optional()
      .describe(
        "Narrow to specific upstream outcomes. Omitted: any conclusion fires this workflow.",
      ),
  })
  .describe(
    "Run when another workflow's run finishes. The run-event payload becomes this workflow's input.",
  );

/** GitHub semantic trigger events — a curated vocabulary, not raw provider actions. Each name maps
 *  to a tested provider-event + condition on the platform (e.g. `pr.merged` is
 *  `pull_request.closed` with `merged: true`); authors never express raw actions or payload
 *  filters. Fires only for repos covered by the org's Boardwalk GitHub connection. */
export const GITHUB_TRIGGER_EVENTS = [
  "pr.opened", // opened or ready_for_review; never fires for a PR whose head is a fork
  "pr.merged", // closed with merged == true
  "issue.opened",
  "issue.commented", // comments on real issues only (not PR conversation threads)
  "ci.completed", // check_suite completed — covers Actions and any Checks-API CI
] as const;

/** A GitHub repository full name, `owner/name`. */
const githubRepoFullName = z
  .string()
  .max(140)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
    "repos entries must be owner/name",
  );

/** Fire on a GitHub event, delivered through the org's GitHub connection — no URL, no secret, no
 *  webhook wiring; the platform verifies, filters, and dedupes before any run is created. `repos`
 *  narrows to specific repositories; omitted = every repo the installation covers. */
const githubTriggerSchema = z
  .strictObject({
    kind: z.literal("github"),
    event: z.enum(GITHUB_TRIGGER_EVENTS).describe("Which GitHub event fires the workflow."),
    repos: z
      .array(githubRepoFullName)
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Narrow to specific repositories, each `owner/name`. Omitted: every repo the " +
          "installation covers.",
      ),
  })
  .describe(
    "Run on a GitHub event, delivered through the org's GitHub connection. No URL and no secret: " +
      "the platform verifies, filters, and dedupes before creating a run.",
  );

/** Linear semantic trigger events — same discipline as GitHub's: curated names the platform maps
 *  to provider events + conditions (`issue.status_changed` is `Issue`/`update` with a state
 *  transition), never raw actions. Fires for the workspace the org's Linear connection covers. */
export const LINEAR_TRIGGER_EVENTS = [
  "issue.created",
  "issue.status_changed",
  "issue.commented",
] as const;

/** Fire on a Linear event, delivered through the org's Linear connection — no URL, no secret;
 *  the platform creates and verifies the workspace webhook itself. */
const linearTriggerSchema = z
  .strictObject({
    kind: z.literal("linear"),
    event: z.enum(LINEAR_TRIGGER_EVENTS).describe("Which Linear event fires the workflow."),
  })
  .describe(
    "Run on a Linear event, delivered through the org's Linear connection. No URL and no secret: " +
      "the platform creates and verifies the workspace webhook itself.",
  );

/** Jira semantic trigger events — same discipline as GitHub's and Linear's: curated names the
 *  platform maps to provider events + conditions (`issue.status_changed` is a `jira:issue_updated`
 *  whose changelog includes a status item), never raw actions. */
export const JIRA_TRIGGER_EVENTS = [
  "issue.created",
  "issue.status_changed",
  "issue.commented",
] as const;

/** Fire on a Jira event, delivered through the org's Jira connection — no URL, no secret; the
 *  platform registers, verifies, renews, and dedupes the site webhook itself. */
const jiraTriggerSchema = z
  .strictObject({
    kind: z.literal("jira"),
    event: z.enum(JIRA_TRIGGER_EVENTS).describe("Which Jira event fires the workflow."),
  })
  .describe(
    "Run on a Jira event, delivered through the org's Jira connection. No URL and no secret: the " +
      "platform registers, verifies, renews, and dedupes the site webhook itself.",
  );

/** Notion semantic trigger events — same discipline as the other providers: curated names the
 *  platform maps to provider events (`page.updated` covers both content and property updates;
 *  Notion aggregates rapid edits into one delivery), never raw event names. Payloads carry ids,
 *  not content — the workflow fetches what it needs with the org's own credential. */
export const NOTION_TRIGGER_EVENTS = ["page.created", "page.updated", "comment.created"] as const;

/** Fire on a Notion event, delivered through the org's Notion connection — no URL, no secret;
 *  the platform's integration-level webhook receives, verifies, and dedupes every delivery. */
const notionTriggerSchema = z
  .strictObject({
    kind: z.literal("notion"),
    event: z.enum(NOTION_TRIGGER_EVENTS).describe("Which Notion event fires the workflow."),
  })
  .describe(
    "Run on a Notion event, delivered through the org's Notion connection. Payloads carry ids " +
      "rather than content, so the workflow fetches what it needs with the org's own credential.",
  );

const triggerSchema = z.discriminatedUnion("kind", [
  cronTriggerSchema,
  webhookTriggerSchema,
  manualTriggerSchema,
  workflowRunTriggerSchema,
  githubTriggerSchema,
  linearTriggerSchema,
  jiraTriggerSchema,
  notionTriggerSchema,
]);

// ============================================================================
// Secrets and env
// ============================================================================

/** A secret ref is exactly `{ name }` — secrets + env vars are the entire credential story. */
const secretRefSchema = z.strictObject({ name: shortName });

/** The ONLY supported interpolation: a whole-value `${{ secrets.NAME }}` reference. */
const WHOLE_VALUE_SECRET_RE = /^\$\{\{\s*secrets\.[A-Za-z0-9_-]+\s*\}\}$/;

const envVarsSchema = z
  .record(z.string().min(1).max(120), z.string().max(32_768))
  .superRefine((vars, ctx) => {
    const keys = Object.keys(vars);
    if (keys.length > 100) {
      ctx.addIssue({ code: "custom", message: "at most 100 env vars are allowed" });
    }
    for (const key of keys) {
      // The program owns `process.env` outright: there are no reserved key prefixes. Platform
      // context + credentials reach the run out of band (never as env), so a user var named
      // `BOARDWALK_*` / `AWS_*` can't shadow anything.
      const value = vars[key];
      if (value !== undefined && value.includes("${{") && !WHOLE_VALUE_SECRET_RE.test(value)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            "only whole-value secret references are supported — write exactly " +
            '"${{ secrets.NAME }}" (no partial interpolation)',
        });
      }
    }
  });

// ============================================================================
// Workspace (program-level persistent directories; agent memory is separate + auto-persisted)
// ============================================================================

/** A relative, forward-slash path with no escapes: rejects absolute paths, backslashes,
 *  `..` and `.` segments. Shared by `workspace.persist`, `entry`, and `files` globs (a glob's
 *  `*` / `**` segments are ordinary segments here — only escapes are rejected). */
const relativePath = (label: string) =>
  z
    .string()
    .min(1)
    .max(512)
    .refine((p) => !p.startsWith("/") && !p.includes("\\"), {
      message: `${label} must be relative (no leading / or backslashes)`,
    })
    .refine((p) => p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."), {
      message: `${label} must not contain \`..\`, \`.\` or empty segments`,
    });

/** Workspace-relative, no escapes: rejects absolute paths, backslashes, `..` and `.` segments. */
const persistPath = relativePath("persist paths");

// `key` scopes the persistent workspace, so ONE workflow keeps N independent compounding states (per
// customer, per repo, per tenant). It is a RUNTIME-INTERPOLATED template over the input, using exactly
// the grammar of `concurrency.key` — `${input.<path>}` interpolations, each a restricted accessor rooted
// at `input`. Syntax is checked at deploy (`validateConcurrencyKeyTemplate`, descriptor.ts); value
// resolution happens at run creation on the control plane, never here.
//
// It is an INDEPENDENT axis from `concurrency.key`, sharing only the grammar. They answer different
// questions — which state do I compound into, versus how many runs may execute at once — and an author
// may legitimately set one, the other, both, or neither, with different templates. Persistence is made
// safe by the merge, never by serializing (docs/WORKSPACE_PERSISTENCE.md §4, §6.1).
const workspaceSchema = z.strictObject({
  persist: z
    .union([z.boolean(), z.array(persistPath).min(1).max(50)])
    .optional()
    .describe(
      "Keep `/workspace` between runs so state compounds: `true` for the whole directory, or a " +
        "list of workspace-relative paths. Omitted: every run starts with an empty workspace.",
    ),
  key: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Scope the persistent workspace so one workflow keeps several independent states, for " +
        "example per customer or per repo. A template over the run input, like " +
        "`${input.customerId}`, resolved when the run is created.",
    )
    .optional(),
});

// ============================================================================
// Budget and concurrency
// ============================================================================

// Every budget dimension is metered and PAUSABLE: a breach parks the run for approve-resume,
// never a hard kill. There is deliberately NO `deadline_seconds` wall-clock cap.
const budgetSchema = z.strictObject({
  max_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on total model tokens across every `agent()` call in the run."),
  max_usd: z
    .number()
    .positive()
    .finite()
    .optional()
    .describe(
      "Cap on inference spend in USD. Approximate by design (a guardrail, not the invoice).",
    ),
  // ACTIVE COMPUTE time — only on-CPU execution counts; a run parked in a long sleep, a
  // human-input gate, or a child-wait does NOT burn this (a run intentionally suspended for a day
  // must not blow its compute budget on resume). This is the runaway / cost cap.
  max_compute_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Cap on active compute seconds. Only on-CPU execution counts: a run parked in a sleep, a " +
        "human-input gate, or a child wait does not burn it.",
    ),
});

// `serial` with no `key` = one run globally; with `key` = one run per resolved key (subsumes the
// old `serial_by_key`). `key` is a RUNTIME-INTERPOLATED template over the input — `${input.<path>}`
// interpolations, each path a restricted accessor rooted at `input` (dotted fields + [index] only).
// The template SYNTAX is checked at deploy (`validateConcurrencyKeyTemplate`, descriptor.ts);
// value resolution happens at run creation on the control plane, never here.
const concurrencySchema = z.union([
  z
    .strictObject({
      mode: z.literal("serial"),
      key: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Template over the run input, like `${input.repo}`, resolved when the run is created. " +
            "Omitted: one run at a time for the whole workflow.",
        )
        .optional(),
    })
    .describe("One run at a time. With `key`, one run at a time per resolved key."),
  // Same lane as `serial`, different queue discipline. `serial` is FIFO: a burst of 20 events runs
  // all 20 in order, most of them against state the next event already invalidated. `latest_wins`
  // keeps only the newest waiting run per lane, which is what a level-triggered consumer (rebuild
  // this repo, re-sync this customer) actually wants — the work is idempotent and the freshest
  // input subsumes every stale one. A RUNNING run is never touched: it is already doing work, and
  // killing in-flight work is a different decision the author makes in their own code.
  z
    .strictObject({
      mode: z.literal("latest_wins"),
      key: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Template over the run input, like `${input.repo}`, resolved when the run is created. " +
            "Omitted: one lane for the whole workflow.",
        )
        .optional(),
    })
    .describe(
      "One run at a time, and a new run replaces the ones still waiting in its lane rather than " +
        "queueing behind them. A run already executing is left alone.",
    ),
  z.strictObject({ mode: z.literal("unlimited") }).describe("No concurrency limit."),
]);

// ============================================================================
// Runner selection
// ============================================================================

const hostedRunsOnLabel = z.enum([
  "boardwalk/linux",
  "boardwalk/linux-node",
  "boardwalk/linux-python",
]);

const hostedRunnerSize = z.enum(["small", "medium", "large", "xlarge"]);

const selfHostedRunsOnSchema = z
  .strictObject({
    kind: z.literal("self-hosted"),
    /** Pool name; omitted ⇒ `"default"` — the pool `boardwalk runner start` creates. */
    pool: z
      .string()
      .min(1)
      .max(120)
      .default("default")
      .describe("Runner pool to claim from. Default: the pool `boardwalk runner start` creates."),
    labels: z
      .array(z.string().min(1).max(120))
      .optional()
      .describe("Narrow to runners in the pool carrying all of these labels."),
  })
  .describe("Run on your own runners rather than Boardwalk's hosted fleet.");

const hostedRunsOnObjectSchema = z
  .strictObject({
    label: hostedRunsOnLabel.describe("Hosted runner image the run executes on."),
    size: hostedRunnerSize
      .optional()
      .describe("Machine size for the run. Omitted: the platform default."),
  })
  .describe("Run on Boardwalk's hosted fleet, choosing the image and the machine size.");

const runsOnSchema = z.union([selfHostedRunsOnSchema, hostedRunsOnObjectSchema, hostedRunsOnLabel]);

// ============================================================================
// Platform-extension fields (validated everywhere, enforced where the capability exists)
// ============================================================================

const containerSchema = z.strictObject({ image: z.string().min(1).max(512) });

const permissionAccess = z.enum(["none", "read", "write"]);

// `permissions` is the run's access-grant surface: what the workflow is ALLOWED to access or do.
// Access-level knobs (id_token/artifacts/contents) plus the SECRET allowlist — a secret a program
// may read is a grant, so it lives here, not as a top-level field (a top-level `secrets` next to
// `env` reads like injection; it isn't). There is NO `tools` grant: tool selection is per-agent
// (AgentOptions.tools), declared on the `agent()` call that uses it — one place, no run-level ceiling.
const permissionsSchema = z.strictObject({
  id_token: z
    .enum(["none", "write"])
    .optional()
    .describe(
      "Grant the run an OIDC id token (`runtime.idToken`) for keyless auth to third-party clouds.",
    ),
  artifacts: permissionAccess
    .optional()
    .describe("Access the run has to the org's artifact storage."),
  contents: permissionAccess
    .optional()
    .describe(
      "Access the run's auto-injected API token has to the org's own workflows, versions, and " +
        "runs. Omitted: read.",
    ),
  secrets: z
    .array(secretRefSchema)
    .optional()
    .describe(
      "Secrets the program may read with `secrets.get`, and reference from `env` as " +
        "`${{ secrets.NAME }}`. A secret not listed here is unreadable.",
    ),
});

const orgRole = z.enum(["owner", "admin", "member", "viewer"]);

const callableBySchema = z.union([
  z
    .strictObject({ roles: z.array(orgRole).min(1).describe("Org roles allowed to start a run.") })
    .describe("Only members holding one of these org roles may start a run."),
  z
    .strictObject({
      workflows: z
        .array(workflowSlug)
        .min(1)
        .describe("Slugs of the workflows allowed to call this one."),
    })
    .describe("Only these workflows may call this one through `workflows.call`."),
  z
    .enum(["anyone_in_org", "users_only", "workflows_only"])
    .describe("Who may start a run: anyone in the org, people only, or other workflows only."),
]);

const egressSchema = z.union([
  z
    .strictObject({
      level: z.literal("custom"),
      allow: z
        .array(z.string().min(1).max(256))
        .min(1)
        .describe("Hosts the run may reach. Everything else is blocked."),
    })
    .describe("Allow outbound network access to an explicit list of hosts."),
  z
    .strictObject({ level: z.enum(["none", "full"]) })
    .describe("Block all outbound network access, or allow it unrestricted."),
]);

const notificationSchema = z.union([
  z
    .strictObject({
      on: z.enum(["completion", "failure", "cancelled"]).describe("Run outcome that notifies."),
      channel: z.enum(["email", "webhook"]).describe("How to deliver the notification."),
      target: z
        .string()
        .min(1)
        .max(2048)
        .describe("Email address or webhook URL the notification goes to."),
      template: z
        .string()
        .max(10_000)
        .optional()
        .describe("Custom message body. Omitted: the platform's default."),
    })
    .describe("Notify when a run reaches an outcome."),
  z
    .strictObject({
      on: z.literal("budget_exceeded"),
      channel: z.literal("email"),
      target: z.string().min(1).max(2048).describe("Email address the notification goes to."),
    })
    .describe(
      "Notify by email when a run parks on a budget cap, so someone can approve resuming it.",
    ),
]);

// ============================================================================
// The manifest
// ============================================================================

export const workflowManifestSchema = z.strictObject({
  slug: workflowSlug.describe(
    "The workflow's identity: a URL-safe slug of letters, digits, and hyphens, stable for the " +
      "life of the program. Referenced by the CLI, `workflows.call`, and the API.",
  ),
  title: workflowTitle
    .optional()
    .describe(
      "Display label, one line of free text. Omitted: interfaces fall back to a title-cased slug.",
    ),
  description: z
    .string()
    .max(1000)
    .optional()
    .describe("What this workflow does, shown next to the title in listings."),
  // The package-relative file exporting `run`. Omitted ⇒ the language default — `src/index.ts`
  // for TypeScript, `main.py` for Python. Deliberately NOT defaulted in-schema: the default is
  // per-language, and the deploy surface resolves it against the uploaded package.
  entry: relativePath("entry")
    .optional()
    .describe(
      "Package-relative file that exports `run`. Omitted: the language default, `src/index.ts` " +
        "for TypeScript and `main.py` for Python.",
    ),
  triggers: z
    .array(triggerSchema)
    .min(1)
    .describe(
      'How runs of this workflow start. At least one is required; `{ "kind": "manual" }` ' +
        "covers on-demand runs from the CLI, the console, the API, and other workflows.",
    ),
  // NO top-level `secrets` — the secret allowlist is `permissions.secrets` (a secret you may read
  // is an access grant). `env` is for value injection (incl. `${{ secrets.NAME }}` of a permitted secret).
  env: envVarsSchema
    .optional()
    .describe(
      "Environment variables set on the run's process. A value may be a whole-value secret " +
        "reference, written exactly `${{ secrets.NAME }}`, for any secret granted in " +
        "`permissions.secrets`. Partial interpolation is not supported.",
    ),
  input_schema: jsonSchemaObject
    .optional()
    .describe(
      "Derived at build time from `run`'s input signature. Never written in `workflow.jsonc`.",
    ),
  output_schema: jsonSchemaObject
    .optional()
    .describe(
      "Derived at build time from `run`'s return signature. Never written in `workflow.jsonc`.",
    ),
  workspace: workspaceSchema
    .optional()
    .describe("Persistent `/workspace` state that compounds across runs."),
  // Session recording (docs/SCREEN_CAPTURE.md §4.5) is ON by default for every hosted run — the
  // scrub-able history of the run's desktop. The only knob is this opt-out: set `recording: false` to
  // disable it for the whole run (the recording spans the whole run, so a per-session option is the
  // wrong shape). Omitted ⇒ recorded.
  recording: z
    .boolean()
    .optional()
    .describe(
      "Session recording of the run's desktop, a scrub-able history of what the run did. On for " +
        "every hosted run; set false to disable it.",
    ),
  budget: budgetSchema
    .optional()
    .describe(
      "Per-run spend caps. Every dimension is pausable: a breach parks the run for " +
        "approve-resume rather than killing it.",
    ),
  concurrency: concurrencySchema
    .describe("How many runs of this workflow may execute at once.")
    .default({ mode: "unlimited" }),
  // NO capability fields (tools/mcp/skills/memory) — all per-agent via AgentOptions.
  runs_on: runsOnSchema.describe("Which runner executes the run.").default("boardwalk/linux"),
  // Platform-extension fields.
  container: containerSchema
    .optional()
    .describe("Run inside a custom container image instead of the runner's default."),
  permissions: permissionsSchema
    .optional()
    .describe(
      "What the run is allowed to reach: its id token, artifacts, the org's own resources, and " +
        "the allowlist of secrets the program may read.",
    ),
  callable_by: callableBySchema
    .describe("Who may start a run of this workflow.")
    .default("anyone_in_org"),
  egress: egressSchema
    .optional()
    .describe("Outbound network policy for the run. Omitted: outbound access is open."),
  notifications: z
    .array(notificationSchema)
    .optional()
    .describe("Where to send word when a run finishes or parks."),
  // The non-code asset ALLOWLIST: glob patterns (relative, forward-slash) naming files the
  // package ships beyond what the entry imports (prompt templates, fixtures, data files).
  // `skills/**` and `README.md` ride by convention without being listed; `node_modules`,
  // `.git`, `.env*`, and dotfiles are never packaged regardless of any glob.
  files: z
    .array(relativePath("files globs"))
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Glob allowlist of non-code files the package ships beyond what the entry imports: prompt " +
        "templates, fixtures, data files. `skills/**` and `README.md` ride along without being " +
        "listed. `node_modules`, `.git`, `.env*`, and dotfiles are never packaged.",
    ),
});

/** The fully-defaulted, validated manifest — the contract every engine consumes. */
export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;

// ============================================================================
// Derived component types (from the schema, never hand-written)
// ============================================================================

export type Trigger = z.infer<typeof triggerSchema>;
export type CronTrigger = z.infer<typeof cronTriggerSchema>;
export type WebhookTrigger = z.infer<typeof webhookTriggerSchema>;
export type ManualTrigger = z.infer<typeof manualTriggerSchema>;
export type WorkflowRunTrigger = z.infer<typeof workflowRunTriggerSchema>;
export type GithubTrigger = z.infer<typeof githubTriggerSchema>;
export type GithubTriggerEvent = (typeof GITHUB_TRIGGER_EVENTS)[number];
export type LinearTrigger = z.infer<typeof linearTriggerSchema>;
export type LinearTriggerEvent = (typeof LINEAR_TRIGGER_EVENTS)[number];
export type JiraTrigger = z.infer<typeof jiraTriggerSchema>;
export type JiraTriggerEvent = (typeof JIRA_TRIGGER_EVENTS)[number];
export type NotionTrigger = z.infer<typeof notionTriggerSchema>;
export type NotionTriggerEvent = (typeof NOTION_TRIGGER_EVENTS)[number];
export type Concurrency = z.infer<typeof concurrencySchema>;
export type Budget = z.infer<typeof budgetSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type EnvVars = z.infer<typeof envVarsSchema>;
export type SecretRef = z.infer<typeof secretRefSchema>;
export type RunPermissions = z.infer<typeof permissionsSchema>;
export type RunPermissionAccess = z.infer<typeof permissionAccess>;
export type OrgRole = z.infer<typeof orgRole>;
export type CallableBy = z.infer<typeof callableBySchema>;
export type RunsOn = z.infer<typeof runsOnSchema>;
export type HostedRunsOn = z.infer<typeof hostedRunsOnLabel>;
export type HostedRunnerSize = z.infer<typeof hostedRunnerSize>;
export type HostedRunsOnObject = z.infer<typeof hostedRunsOnObjectSchema>;
export type SelfHostedRunsOn = z.infer<typeof selfHostedRunsOnSchema>;
export type Container = z.infer<typeof containerSchema>;
export type EgressPolicy = z.infer<typeof egressSchema>;
export type Notification = z.infer<typeof notificationSchema>;
