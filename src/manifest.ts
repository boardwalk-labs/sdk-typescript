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

const cronTriggerSchema = z.strictObject({
  kind: z.literal("cron"),
  expr: cronExpr,
  timezone: z.string().min(1).max(80).optional(),
  // Static input for each scheduled run (must satisfy the workflow's input_schema when declared).
  // Omitted ⇒ the run fires with no input. A JSON object, mirroring input_schema's `type: object`.
  input: jsonSchemaObject.optional(),
});

const webhookName = z
  .string()
  .min(1)
  .max(100)
  .regex(SLUG_RE, "webhook name must be alphanumeric with hyphens");

/** Attach to one of the org's webhooks. Any number of workflows may attach to the same one, and all
 *  of them run on every delivery — narrow with the sender's own event picker, not a filter here.
 *  Only the NAME is program logic; URL/secret/verification are console-owned deployment wiring. */
const webhookTriggerSchema = z.strictObject({
  kind: z.literal("webhook"),
  name: webhookName,
});

const manualTriggerSchema = z.strictObject({
  kind: z.literal("manual"),
});

/** React to ANOTHER workflow's run finishing (GitHub-Actions `on: workflow_run`). When any of the
 *  named upstream workflows (slugs in the same org) completes, this workflow runs with the run-event
 *  payload as its input. `conclusions` optionally narrows to specific outcomes; omitted = any. */
const workflowRunTriggerSchema = z.strictObject({
  kind: z.literal("workflow_run"),
  workflows: z.array(workflowSlug).min(1).max(20),
  conclusions: z
    .array(z.enum(["success", "failure", "cancelled"]))
    .min(1)
    .optional(),
});

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
const githubTriggerSchema = z.strictObject({
  kind: z.literal("github"),
  event: z.enum(GITHUB_TRIGGER_EVENTS),
  repos: z.array(githubRepoFullName).min(1).max(50).optional(),
});

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
const linearTriggerSchema = z.strictObject({
  kind: z.literal("linear"),
  event: z.enum(LINEAR_TRIGGER_EVENTS),
});

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
const jiraTriggerSchema = z.strictObject({
  kind: z.literal("jira"),
  event: z.enum(JIRA_TRIGGER_EVENTS),
});

/** Notion semantic trigger events — same discipline as the other providers: curated names the
 *  platform maps to provider events (`page.updated` covers both content and property updates;
 *  Notion aggregates rapid edits into one delivery), never raw event names. Payloads carry ids,
 *  not content — the workflow fetches what it needs with the org's own credential. */
export const NOTION_TRIGGER_EVENTS = ["page.created", "page.updated", "comment.created"] as const;

/** Fire on a Notion event, delivered through the org's Notion connection — no URL, no secret;
 *  the platform's integration-level webhook receives, verifies, and dedupes every delivery. */
const notionTriggerSchema = z.strictObject({
  kind: z.literal("notion"),
  event: z.enum(NOTION_TRIGGER_EVENTS),
});

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
  persist: z.union([z.boolean(), z.array(persistPath).min(1).max(50)]).optional(),
  key: z.string().min(1).max(200).optional(),
});

// ============================================================================
// Budget and concurrency
// ============================================================================

// Every budget dimension is metered and PAUSABLE: a breach parks the run for approve-resume,
// never a hard kill. There is deliberately NO `deadline_seconds` wall-clock cap.
const budgetSchema = z.strictObject({
  max_tokens: z.number().int().positive().optional(),
  max_usd: z.number().positive().finite().optional(),
  // ACTIVE COMPUTE time — only on-CPU execution counts; a run parked in a long sleep, a
  // human-input gate, or a child-wait does NOT burn this (a run intentionally suspended for a day
  // must not blow its compute budget on resume). This is the runaway / cost cap.
  max_compute_seconds: z.number().int().positive().optional(),
});

// `serial` with no `key` = one run globally; with `key` = one run per resolved key (subsumes the
// old `serial_by_key`). `key` is a RUNTIME-INTERPOLATED template over the input — `${input.<path>}`
// interpolations, each path a restricted accessor rooted at `input` (dotted fields + [index] only).
// The template SYNTAX is checked at deploy (`validateConcurrencyKeyTemplate`, descriptor.ts);
// value resolution happens at run creation on the control plane, never here.
const concurrencySchema = z.union([
  z.strictObject({ mode: z.literal("serial"), key: z.string().min(1).max(200).optional() }),
  z.strictObject({ mode: z.literal("unlimited") }),
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

const selfHostedRunsOnSchema = z.strictObject({
  kind: z.literal("self-hosted"),
  /** Pool name; omitted ⇒ `"default"` — the pool `boardwalk runner start` creates. */
  pool: z.string().min(1).max(120).default("default"),
  labels: z.array(z.string().min(1).max(120)).optional(),
});

const hostedRunsOnObjectSchema = z.strictObject({
  label: hostedRunsOnLabel,
  size: hostedRunnerSize.optional(),
});

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
  id_token: z.enum(["none", "write"]).optional(),
  artifacts: permissionAccess.optional(),
  contents: permissionAccess.optional(),
  secrets: z.array(secretRefSchema).optional(),
});

const orgRole = z.enum(["owner", "admin", "member", "viewer"]);

const callableBySchema = z.union([
  z.strictObject({ roles: z.array(orgRole).min(1) }),
  z.strictObject({ workflows: z.array(workflowSlug).min(1) }),
  z.enum(["anyone_in_org", "users_only", "workflows_only"]),
]);

const egressSchema = z.union([
  z.strictObject({
    level: z.literal("custom"),
    allow: z.array(z.string().min(1).max(256)).min(1),
  }),
  z.strictObject({ level: z.enum(["none", "full"]) }),
]);

const notificationSchema = z.union([
  z.strictObject({
    on: z.enum(["completion", "failure", "cancelled"]),
    channel: z.enum(["email", "webhook"]),
    target: z.string().min(1).max(2048),
    template: z.string().max(10_000).optional(),
  }),
  z.strictObject({
    on: z.literal("budget_exceeded"),
    channel: z.literal("email"),
    target: z.string().min(1).max(2048),
  }),
]);

// ============================================================================
// The manifest
// ============================================================================

export const workflowManifestSchema = z.strictObject({
  slug: workflowSlug,
  title: workflowTitle.optional(),
  description: z.string().max(1000).optional(),
  // The package-relative file exporting `run`. Omitted ⇒ the language default — `src/index.ts`
  // for TypeScript, `main.py` for Python. Deliberately NOT defaulted in-schema: the default is
  // per-language, and the deploy surface resolves it against the uploaded package.
  entry: relativePath("entry").optional(),
  triggers: z.array(triggerSchema).min(1),
  // NO top-level `secrets` — the secret allowlist is `permissions.secrets` (a secret you may read
  // is an access grant). `env` is for value injection (incl. `${{ secrets.NAME }}` of a permitted secret).
  env: envVarsSchema.optional(),
  input_schema: jsonSchemaObject.optional(),
  output_schema: jsonSchemaObject.optional(),
  workspace: workspaceSchema.optional(),
  // Session recording (docs/SCREEN_CAPTURE.md §4.5) is ON by default for every hosted run — the
  // scrub-able history of the run's desktop. The only knob is this opt-out: set `recording: false` to
  // disable it for the whole run (the recording spans the whole run, so a per-session option is the
  // wrong shape). Omitted ⇒ recorded.
  recording: z.boolean().optional(),
  budget: budgetSchema.optional(),
  concurrency: concurrencySchema.default({ mode: "unlimited" }),
  // NO capability fields (tools/mcp/skills/memory) — all per-agent via AgentOptions.
  runs_on: runsOnSchema.default("boardwalk/linux"),
  // Platform-extension fields.
  container: containerSchema.optional(),
  permissions: permissionsSchema.optional(),
  callable_by: callableBySchema.default("anyone_in_org"),
  egress: egressSchema.optional(),
  notifications: z.array(notificationSchema).optional(),
  // The non-code asset ALLOWLIST: glob patterns (relative, forward-slash) naming files the
  // package ships beyond what the entry imports (prompt templates, fixtures, data files).
  // `skills/**` and `README.md` ride by convention without being listed; `node_modules`,
  // `.git`, `.env*`, and dotfiles are never packaged regardless of any glob.
  files: z.array(relativePath("files globs")).min(1).max(100).optional(),
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
