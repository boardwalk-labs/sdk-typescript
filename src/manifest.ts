// SPDX-License-Identifier: MIT

// workflowManifestSchema — the validator of record for a workflow's `meta`.
//
// One Zod schema, consumed by every engine (local `dev`, the self-hosted server, Boardwalk
// hosted platform) and by `extract.ts` after pure-literal extraction. The TS manifest type is derived
// from the schema, never hand-written. Unknown fields are validation errors — no silent drift.
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

const webhookTriggerSchema = z.strictObject({
  kind: z.literal("webhook"),
  auth: z.enum(["token", "signature"]),
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

const triggerSchema = z.discriminatedUnion("kind", [
  cronTriggerSchema,
  webhookTriggerSchema,
  manualTriggerSchema,
  workflowRunTriggerSchema,
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

/** Workspace-relative, no escapes: rejects absolute paths, backslashes, `..` and `.` segments. */
const persistPath = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !p.startsWith("/") && !p.includes("\\"), {
    message: "persist paths must be workspace-relative (no leading / or backslashes)",
  })
  .refine((p) => p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."), {
    message: "persist paths must not contain `..`, `.` or empty segments",
  });

const workspaceSchema = z.strictObject({
  persist: z.union([z.boolean(), z.array(persistPath).min(1).max(50)]).optional(),
});

// ============================================================================
// Budget and concurrency
// ============================================================================

const budgetSchema = z.strictObject({
  max_tokens: z.number().int().positive().optional(),
  max_usd: z.number().positive().finite().optional(),
  // ACTIVE COMPUTE time — only on-CPU execution counts; a run parked in a long sleep, a
  // human-input gate, or a child-wait does NOT burn this (a run intentionally suspended for a day
  // must not blow its compute budget on resume). This is the runaway / cost cap.
  max_duration_seconds: z.number().int().positive().optional(),
  // WALL-CLOCK time from the run's start, INCLUDING suspended idle — the staleness / SLA cap:
  // "give up if this run hasn't finished within N real-world seconds, even if it has just been
  // waiting." Orthogonal to max_duration_seconds (e.g. an approval that legitimately waits hours
  // but is pointless after a day: a small max_duration_seconds + a large deadline_seconds).
  deadline_seconds: z.number().int().positive().optional(),
});

const concurrencySchema = z.union([
  z.strictObject({ mode: z.literal("serial_by_key"), key: z.string().min(1).max(200) }),
  z.strictObject({ mode: z.literal("serial") }),
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

const runsOnSchema = z.union([
  z.strictObject({
    kind: z.literal("self-hosted"),
    /** Pool name; omitted ⇒ `"default"` — the pool `boardwalk runner start` creates. */
    pool: z.string().min(1).max(120).default("default"),
    labels: z.array(z.string().min(1).max(120)).optional(),
  }),
  z.strictObject({
    label: hostedRunsOnLabel,
    size: z.enum(["small", "medium", "large", "xlarge"]).optional(),
  }),
  hostedRunsOnLabel,
]);

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

const callableBySchema = z.union([
  z.strictObject({ roles: z.array(z.enum(["owner", "admin", "member", "viewer"])).min(1) }),
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
});

/** The fully-defaulted, validated manifest — the contract every engine consumes. */
export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;

/**
 * Validate an already-extracted `meta` object (e.g. from `extract.ts` or a test fixture) and
 * return the manifest, or throw a `MetaValidationError` listing every issue with its path.
 */
export function validateMeta(meta: unknown): WorkflowManifest {
  const result = workflowManifestSchema.safeParse(meta);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("\n");
    throw new MetaValidationError(`Workflow \`meta\` failed manifest validation:\n${issues}`);
  }
  return result.data;
}

/** Thrown by {@link validateMeta} when a `meta` object violates the manifest schema. */
export class MetaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaValidationError";
  }
}
