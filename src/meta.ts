// SPDX-License-Identifier: MIT

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
// Agent capabilities
//
// ALL capabilities are PER-AGENT, not per-workflow (decided 2026-06-11): each agent() call
// brings its own tools, MCP servers, skills, and memory via AgentOptions — the manifest
// declares none of them.
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

/**
 * An MCP server an `agent()` call connects to (inline in `AgentOptions.mcp` — per-agent, no
 * meta declaration). The program is the trusted layer: put credentials in `env`/`headers`
 * directly (e.g. from `secrets.get`) — no interpolation syntax.
 */
export type McpServerRef =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: readonly string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "http";
      url: string;
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
 * Persistent directories for the PROGRAM (not the same thing as agent memory).
 *
 * Every run gets a writable workspace directory that exists before your program runs; without
 * `persist` it is scratch space, discarded at run end. `persist: true` persists the whole
 * workspace across runs; a list persists exactly those WORKSPACE-RELATIVE subdirectories
 * (`"cache"`, `"index"`, …) — `..` or absolute paths are validation errors. Persisted
 * directories are hydrated at run start and written back at successful run end; concurrent
 * runs sharing one are last-writer-wins, so prefer `concurrency: { mode: "serial" }`.
 *
 * Agent **memory** is separate and needs no declaration here: `agent(prompt, { memory: "<dir>" })`
 * names any workspace-relative directory and the engine auto-persists it across runs (see
 * {@link import("./types.js").AgentOptions}.memory). Use `workspace.persist` for non-memory
 * state your program code manages directly.
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
  // NOTE: there are NO workflow-level capability fields (tools/mcp/skills/memory). All agent
  // capabilities are per-agent — each `agent()` call brings its own (see AgentOptions).
  runs_on?: RunsOn;
  // Platform-extension fields — validated everywhere, enforced where the capability exists.
  container?: Container;
  permissions?: RunPermissions;
  callable_by?: CallableBy;
  egress?: EgressPolicy;
  notifications?: readonly Notification[];
}
