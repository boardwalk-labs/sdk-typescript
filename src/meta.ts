// WorkflowMeta — the TypeScript shape of a workflow's `meta` export.
//
// A workflow program declares `export const meta = { … } satisfies WorkflowMeta`. The
// `satisfies` operator is type-only and erased at compile time, so it does NOT break the
// pure-literal static extraction engines perform over the source (see extract.ts). This type
// is the author-facing typing; `workflowManifestSchema` (manifest.ts) is the validator of
// record — the two are kept faithful to each other.

// ============================================================================
// Triggers
// ============================================================================

export interface CronTrigger {
  kind: "cron";
  /** Cron expression (5-field standard or 6-field with seconds). */
  expr: string;
  /** IANA timezone (e.g. `America/Anchorage`). Defaults to UTC. */
  timezone?: string;
}

/** Server engines only (the self-hosted server and the hosted Boardwalk platform) — `dev` has no listener. */
export interface WebhookTrigger {
  kind: "webhook";
  auth: "token" | "signature";
}

export interface ManualTrigger {
  kind: "manual";
}

export type Trigger = CronTrigger | WebhookTrigger | ManualTrigger;

// ============================================================================
// Agent capabilities: MCP servers
//
// Tools, skills, and memory are PER-AGENT, not per-workflow (decided 2026-06-11): each
// agent() call brings its own (AgentOptions.tools/skills/memory) with no meta declaration.
// MCP servers stay on meta because they are deploy-time infrastructure (commands, URLs,
// secret-bearing env), still SELECTED per call by name.
// ============================================================================

/**
 * A built-in tool grant, with optional configuration. Used only by the platform-extension
 * `permissions.tools` (hosted run-permission scoping) — agent tool selection is per-call.
 */
export interface ToolGrant {
  name: string;
  config?: Record<string, unknown>;
  scope?: readonly string[];
}

/** An MCP server whose tools `agent()` loops may use (selected per call by `name`). */
export type McpServerRef =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: readonly string[];
      /** Values may be `"${{ secrets.NAME }}"` whole-value references, resolved at run time. */
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      /** Values may be `"${{ secrets.NAME }}"` whole-value references, resolved at run time. */
      headers?: Record<string, string>;
    };

// ============================================================================
// Concurrency
// ============================================================================

export type Concurrency =
  | { mode: "unlimited" }
  | { mode: "serial" }
  | { mode: "serial_by_key"; key: string };

// ============================================================================
// Runner selection (meaningful on hosted Boardwalk; local engines warn and ignore)
// ============================================================================

export type HostedRunsOn =
  | "boardwalk/linux"
  | "boardwalk/linux-node"
  | "boardwalk/linux-python"
  | "boardwalk/linux-large";

export type HostedRunnerSize = "small" | "medium" | "large" | "xlarge";

export interface HostedRunsOnObject {
  label: HostedRunsOn;
  size?: HostedRunnerSize;
}

export interface SelfHostedRunsOn {
  kind: "self-hosted";
  pool: string;
  labels?: readonly string[];
}

export type RunsOn = HostedRunsOn | HostedRunsOnObject | SelfHostedRunsOn;

export interface Container {
  /** Fully-qualified image reference. Hosted-platform capability. */
  image: string;
}

// ============================================================================
// Secrets and env
// ============================================================================

/**
 * A secret the program may read with `secrets.get(name)` — an allowlist entry, never a value.
 * Resolution is engine-dependent: environment/`.env` on local engines, the encrypted vault on
 * the Boardwalk platform. Secrets + env vars are the entire credential story.
 */
export interface SecretRef {
  name: string;
}

/**
 * Environment variables for the run. A value is either non-secret plaintext, or a whole-value
 * secret reference `"${{ secrets.NAME }}"` resolved at run time (never stored in the manifest).
 * Referencing a secret here also grants the run access to it. Reserved `BOARDWALK_*` / `AWS_*`
 * keys are not allowed.
 */
export type EnvVars = Record<string, string>;

// ============================================================================
// Platform-extension fields (validated everywhere, enforced where the capability exists)
// ============================================================================

export type EgressPolicy =
  | { level: "none" }
  | { level: "trusted" }
  | { level: "full" }
  | { level: "custom"; allow: readonly string[]; include_defaults?: boolean };

export type RunPermissionAccess = "none" | "read" | "write";

export interface RunPermissions {
  id_token?: "none" | "write";
  artifacts?: RunPermissionAccess;
  contents?: RunPermissionAccess;
  secrets?: readonly SecretRef[];
  tools?: readonly ToolGrant[];
}

export type OrgRole = "owner" | "admin" | "member" | "viewer";

export type CallableBy =
  | "anyone_in_org"
  | "users_only"
  | "workflows_only"
  | { roles: readonly OrgRole[] }
  | { workflows: readonly string[] };

export type Notification =
  | {
      on: "completion" | "failure" | "cancelled";
      channel: "email" | "webhook";
      target: string;
      template?: string;
    }
  | { on: "budget_exceeded"; channel: "email"; target: string };

// ============================================================================
// Budget and workspace
// ============================================================================

/** Enforced by engines — breaching a budget terminates the run, it doesn't truncate silently. */
export interface Budget {
  max_tokens?: number;
  max_usd?: number;
  max_duration_seconds?: number;
}

/**
 * Persistent directories — also the agent-memory mechanism.
 *
 * Every run gets a writable workspace directory that exists before your program runs; without
 * `persist` it is scratch space, discarded at run end. `persist: true` persists the whole
 * workspace across runs; a list persists exactly those WORKSPACE-RELATIVE subdirectories
 * (`"memory/triager"`, `"cache"`, …) — `..` or absolute paths are validation errors.
 *
 * `agent(prompt, { memory: "<dir>" })` points a loop's memory at a declared persistent
 * directory; the program may read/write the same files in plain code. Declared directories are
 * hydrated at run start and persisted back at successful run end. Concurrent runs sharing a
 * persistent directory are last-writer-wins — prefer `concurrency: { mode: "serial" }`.
 */
export interface Workspace {
  persist?: boolean | readonly string[];
}

// ============================================================================
// The workflow meta
// ============================================================================

/**
 * The pure-literal contract a workflow program exports. Must be a literal — no variables,
 * calls, spreads, or interpolation — so engines can statically extract it without executing
 * the program. Validated by `workflowManifestSchema`; unknown fields are errors.
 */
export interface WorkflowMeta {
  name: string;
  description?: string;
  // NOTE: there is NO workflow-level `model`/`provider`. A workflow needn't do any LLM work, so
  // it shouldn't have to declare a model. Each `agent()` call names its own model (or omits it
  // for engine-dependent resolution). See AgentOptions.
  /** At least one trigger is required. */
  triggers: readonly Trigger[];
  secrets?: readonly SecretRef[];
  env?: EnvVars;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  workspace?: Workspace;
  budget?: Budget;
  concurrency?: Concurrency;
  // NOTE: there are NO workflow-level `tools`/`skills` fields. Tools, skills, and memory are
  // per-agent — each `agent()` call brings its own (see AgentOptions). Only MCP servers are
  // declared here (deploy-time infrastructure), still selected per call by name.
  /** MCP servers available to `agent()` loops (selected per call by name). */
  mcp?: readonly McpServerRef[];
  runs_on?: RunsOn;
  // Platform-extension fields — validated everywhere, enforced where the capability exists.
  container?: Container;
  permissions?: RunPermissions;
  callable_by?: CallableBy;
  egress?: EgressPolicy;
  notifications?: readonly Notification[];
}
