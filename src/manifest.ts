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

const NAME_RE = /^[a-zA-Z0-9-]+$/;

const workflowName = z
  .string()
  .min(1)
  .max(100)
  .regex(NAME_RE, "name must be alphanumeric with hyphens");

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
});

const webhookTriggerSchema = z.strictObject({
  kind: z.literal("webhook"),
  auth: z.enum(["token", "signature"]),
});

const manualTriggerSchema = z.strictObject({
  kind: z.literal("manual"),
});

const triggerSchema = z.discriminatedUnion("kind", [
  cronTriggerSchema,
  webhookTriggerSchema,
  manualTriggerSchema,
]);

// ============================================================================
// Secrets and env
// ============================================================================

/** A secret ref is exactly `{ name }` — secrets + env vars are the entire credential story. */
const secretRefSchema = z.strictObject({ name: shortName });

const RESERVED_ENV_PREFIX_RE = /^(boardwalk_|aws_)/i;
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
      if (RESERVED_ENV_PREFIX_RE.test(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `"${key}" uses a reserved prefix (BOARDWALK_* / AWS_*)`,
        });
      }
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
// Workspace (persistent directories — also the agent-memory mechanism)
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
  max_duration_seconds: z.number().int().positive().optional(),
});

const concurrencySchema = z.union([
  z.strictObject({ mode: z.literal("serial_by_key"), key: z.string().min(1).max(200) }),
  z.strictObject({ mode: z.literal("serial") }),
  z.strictObject({ mode: z.literal("unlimited") }),
]);

// ============================================================================
// Agent capabilities: tools, MCP, skills
// ============================================================================

const toolGrantSchema = z.strictObject({
  name: shortName,
  config: z.record(z.string(), z.unknown()).optional(),
  scope: z.array(z.string().min(1).max(200)).optional(),
});

const mcpServerSchema = z.union([
  z.strictObject({
    name: shortName,
    transport: z.literal("stdio"),
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(1024)).optional(),
    env: z.record(z.string().min(1).max(120), z.string().max(4096)).optional(),
  }),
  z.strictObject({
    name: shortName,
    transport: z.literal("http"),
    url: z.string().url().max(2048),
    headers: z.record(z.string().min(1).max(120), z.string().max(4096)).optional(),
  }),
]);

// ============================================================================
// Runner selection
// ============================================================================

const hostedRunsOnLabel = z.enum([
  "boardwalk/linux",
  "boardwalk/linux-node",
  "boardwalk/linux-python",
  "boardwalk/linux-large",
]);

const runsOnSchema = z.union([
  z.strictObject({
    kind: z.literal("self-hosted"),
    pool: z.string().min(1).max(120),
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

const permissionsSchema = z.strictObject({
  id_token: z.enum(["none", "write"]).optional(),
  artifacts: permissionAccess.optional(),
  contents: permissionAccess.optional(),
  secrets: z.array(secretRefSchema).optional(),
  tools: z.array(toolGrantSchema).optional(),
});

const callableBySchema = z.union([
  z.strictObject({ roles: z.array(z.enum(["owner", "admin", "member", "viewer"])).min(1) }),
  z.strictObject({ workflows: z.array(workflowName).min(1) }),
  z.enum(["anyone_in_org", "users_only", "workflows_only"]),
]);

const egressSchema = z.union([
  z.strictObject({
    level: z.literal("custom"),
    allow: z.array(z.string().min(1).max(256)).min(1),
    include_defaults: z.boolean().optional(),
  }),
  z.strictObject({ level: z.enum(["none", "trusted", "full"]) }),
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
  name: workflowName,
  description: z.string().max(1000).optional(),
  triggers: z.array(triggerSchema).min(1),
  secrets: z.array(secretRefSchema).optional(),
  env: envVarsSchema.optional(),
  input_schema: jsonSchemaObject.optional(),
  output_schema: jsonSchemaObject.optional(),
  workspace: workspaceSchema.optional(),
  budget: budgetSchema.optional(),
  concurrency: concurrencySchema.default({ mode: "unlimited" }),
  tools: z.array(toolGrantSchema).default([]),
  mcp: z.array(mcpServerSchema).default([]),
  skills: z.array(shortName).default([]),
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
