// SPDX-License-Identifier: MIT

// The program↔host protocol — the wire contract between a workflow program and the runner.
//
// JSON-RPC 2.0 over a local stream socket (the path in `BOARDWALK_HOST_SOCK`: a Unix domain
// socket, or a named pipe on win32), framed as newline-delimited JSON — one frame per line,
// no embedded newlines. **Runner = server, SDK = client**, localhost-only inside the microVM.
// One contract, spoken by both the TypeScript and Python SDKs; a new capability lands HERE
// first, then in both SDKs — never SDK-first.
//
// The protocol is FULL-DUPLEX. Method categories:
//  - Loader-only (SDK infrastructure, never author API): `bootstrap` and `report_return`
//    bracket the run — the loader fetches `{input, context}`, invokes `run(input, context)`,
//    and reports the return value. There is no `output()` the program calls.
//  - Author capabilities (client → host requests): `agent`, `workflows.*`, `sleep`,
//    `humanInput`, `secrets.get`, `artifacts.write`, `computer.*`, `shell`, `auth.*`,
//    `usage.get`.
//  - Client → host notification: `phase` (a fire-and-forget timeline marker).
//  - Host → client request: `tool_invoke` — how an inline `agent()` tool declared in the
//    program runs. The leaf loop stays host-side; the handler executes in the program process.
//  - Host → client notification: `cancel` — the SDK aborts `context.signal`.
//
// The context payload on the wire is DATA ONLY (plain JSON — no `signal` field, ever). The
// client synthesizes the live `AbortSignal` locally from the `cancel` notification.
//
// Errors are JSON-RPC `{code, message, data?}` with one deliberate deviation from the base
// spec: `code` is a STRING from the engine error taxonomy (`BUDGET_EXCEEDED`, `CANCELLED`,
// `PROGRAM_ERROR`, …), not an integer — the codes are the contract consumers branch on (see
// {@link isRunFatal}), and both ends ship pinned together via the release chain, so there is
// no third-party JSON-RPC interop to preserve.
//
// Compat: the host ships in the runner image; the SDK ships in the artifact. They stay
// compatible via the pinned release chain (engine → runner → rootfs → SDK), not a wire-version
// negotiation.

import { z } from "zod";
import type { JsonValue } from "./types.js";

// ============================================================================
// JSON helpers
// ============================================================================

/** Any JSON value — what capability payloads are made of on the wire. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** Loosely-typed JSON Schema objects (agent `schema`, tool `input_schema`, `output_schema`). */
const jsonSchemaObject = z.record(z.string(), z.unknown());

const emptyParams = z.strictObject({});
const emptyResult = z.strictObject({});

// ============================================================================
// Errors and run-fatality
// ============================================================================

/**
 * The JSON-RPC error shape. `code` is a string from the engine error taxonomy (see the module
 * header for why it deviates from the base spec's integer codes).
 */
export const protocolErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  data: z.unknown().optional(),
});
export type ProtocolErrorShape = z.infer<typeof protocolErrorSchema>;

/** Error codes that must abort the whole run rather than be isolated (see {@link isRunFatal}). */
export const RUN_FATAL_CODES = ["BUDGET_EXCEEDED", "CANCELLED"] as const;

/**
 * A rejection that must abort the whole run rather than be isolated by `parallel()`: the
 * run-terminating engine conditions (budget exhausted, cancellation). Duck-typed — the SDK is
 * the lower layer and doesn't import the engine's error type — so it reads the stable `code`
 * string (and an explicit `fatal` flag if a future engine sets one). Both SDKs (TS and Python)
 * implement this exact set; it is covered by the shared cross-language conformance suite.
 */
export function isRunFatal(reason: unknown): boolean {
  const r = reason as { code?: unknown; fatal?: unknown } | null;
  if (r?.fatal === true) return true;
  return r?.code === "BUDGET_EXCEEDED" || r?.code === "CANCELLED";
}

/**
 * A host-reported protocol error, thrown by the client when a request comes back as a JSON-RPC
 * error response. Carries the taxonomy `code` (so {@link isRunFatal} and author `catch` blocks
 * can branch on it) and the optional structured `data`.
 */
export class HostError extends Error {
  /** Machine-readable error code from the engine taxonomy (`BUDGET_EXCEEDED`, `CANCELLED`, …). */
  readonly code: string;
  /** Optional structured detail from the host. */
  readonly data?: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "HostError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// ============================================================================
// Frames (newline-delimited JSON-RPC 2.0)
// ============================================================================

const rpcIdSchema = z.union([z.number().int(), z.string().min(1)]);
export type RpcId = z.infer<typeof rpcIdSchema>;

export const rpcRequestFrameSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequestFrame = z.infer<typeof rpcRequestFrameSchema>;

export const rpcNotificationFrameSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcNotificationFrame = z.infer<typeof rpcNotificationFrameSchema>;

export const rpcSuccessFrameSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema,
  result: z.unknown(),
});
export type RpcSuccessFrame = z.infer<typeof rpcSuccessFrameSchema>;

export const rpcErrorFrameSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  /** `null` when the offending frame's id could not be read (per JSON-RPC 2.0). */
  id: rpcIdSchema.nullable(),
  error: protocolErrorSchema,
});
export type RpcErrorFrame = z.infer<typeof rpcErrorFrameSchema>;

/** Any protocol frame. Union ordered most-specific-first (repo schema rule). */
export const rpcFrameSchema = z.union([
  rpcErrorFrameSchema,
  rpcRequestFrameSchema,
  rpcSuccessFrameSchema,
  rpcNotificationFrameSchema,
]);
export type RpcFrame = z.infer<typeof rpcFrameSchema>;

// ============================================================================
// Context data (the `bootstrap` payload)
// ============================================================================

/**
 * Who/what invoked the run, discriminated on `type`. Mirrors the control plane's run-actor
 * record (snake_case field names are the stored shape).
 *
 * `user_id` semantics differ per variant: on a `user` actor it is a real human; on a
 * `workflow` actor (a `workflows.call` child) it is the synthetic `workflow:<workflowId>`
 * principal of the immediate parent — NOT a human, and not the root user of a deep call
 * chain. To attribute a deep child to a person, walk `parent_run_id` up to the root `user`
 * actor.
 */
export const actorSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("user"), user_id: z.string().min(1) }),
  z.strictObject({
    type: z.literal("workflow"),
    parent_run_id: z.string().min(1),
    parent_workflow_id: z.string().min(1),
    /** The synthetic `workflow:<workflowId>` principal — never a human user id. */
    user_id: z.string().min(1),
  }),
  z.strictObject({ type: z.literal("webhook"), source: z.string().min(1) }),
  z.strictObject({ type: z.literal("cron"), rule: z.string().min(1) }),
  z.strictObject({
    type: z.literal("event"),
    subscription_id: z.string().min(1),
    source_run_id: z.string().min(1),
    source_workflow_id: z.string().min(1),
    event_type: z.string().min(1),
    event_chain_depth: z.number().int().nonnegative(),
  }),
]);
export type Actor = z.infer<typeof actorSchema>;

/**
 * How and when the run fired. The two-axis rule: `kind` is the TRANSPORT (a cron timer, a
 * webhook delivery, or a direct invocation = `manual`); `actor` is the INITIATOR. A
 * `workflows.call` child arrives as `manual` + `actor.type: "workflow"`; a `workflow_run`
 * subscription firing arrives as `manual` + `actor.type: "event"`. The kind enum never grows
 * to restate what `actor` already says.
 */
export const triggerInfoSchema = z.strictObject({
  kind: z.enum(["cron", "webhook", "manual"]),
  /** When the platform fired this run, ms since epoch. */
  firedAt: z.number().int().nonnegative(),
  /** Trigger-specific source (e.g. the webhook id / cron schedule id / subscription id). */
  source: z.string().min(1).optional(),
});
export type TriggerInfo = z.infer<typeof triggerInfoSchema>;

/**
 * The context DATA carried by `bootstrap` — plain JSON, no `signal` (the client synthesizes
 * the live `AbortSignal` from the `cancel` notification; it is never a wire field).
 */
export const contextDataSchema = z.strictObject({
  /** This run's id — a bare 26-char ULID, like all entity ids. */
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  /** Sequential int (1, 2, 3, …) — the version this run pinned to. */
  workflowVersion: z.number().int().positive(),
  orgId: z.string().min(1),
  /** The environment this run selected at its trigger; `null` = the org base. */
  environment: z.strictObject({ id: z.string().min(1), name: z.string().min(1) }).nullable(),
  actor: actorSchema,
  /** 1-based crash-restart-from-top count. Side effects re-run on restart; branch on this. */
  attempt: z.number().int().min(1),
  trigger: triggerInfoSchema,
  /** Absolute `/workspace` root (also cwd + HOME). */
  workspaceDir: z.string().min(1),
});
export type ContextData = z.infer<typeof contextDataSchema>;

/**
 * The read-only run metadata passed to `run(input, context)` — the frozen v1 field set,
 * append-only forever (fields are added, never removed or renamed). Pure invocation identity:
 * no budget, no deadline, no time — live budget state is the `usage.get()` import, and the
 * credential mints are the imported `auth` namespace. `signal` aborts when the run is
 * cancelled (synthesized client-side from the host's `cancel` notification).
 */
export interface Context extends Readonly<ContextData> {
  readonly signal: AbortSignal;
}

// ============================================================================
// Agent (wire shape of AgentOptions)
// ============================================================================

/**
 * An inline program tool as it crosses the wire: DECLARATION ONLY. The `execute` handler
 * stays in the program process and is called back via `tool_invoke` — code never crosses.
 */
export const toolDeclarationSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  input_schema: jsonSchemaObject,
});
export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>;

const reasoningEffortEnum = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);

const reasoningWireSchema = z.union([
  z.strictObject({
    effort: reasoningEffortEnum.optional(),
    maxTokens: z.number().int().positive().optional(),
    exclude: z.boolean().optional(),
  }),
  reasoningEffortEnum,
]);

const mcpServerWireSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    name: z.string().min(1),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).readonly().optional(),
    env: z.record(z.string(), z.string()).optional(),
    excludeTools: z.array(z.string()).readonly().optional(),
  }),
  z.strictObject({
    name: z.string().min(1),
    transport: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    excludeTools: z.array(z.string()).readonly().optional(),
  }),
]);

const attachmentWireSchema = z.strictObject({
  mimeType: z.string().min(1),
  data: z.string().optional(),
  url: z.string().optional(),
  filename: z.string().optional(),
});

/**
 * `AgentOptions` as it crosses the wire. Two translations from the author surface:
 * `tools` carries {@link ToolDeclaration}s (handlers stay in the program; `inputSchema`
 * becomes `input_schema`), and a computer-use `session` handle becomes its `sessionId`.
 * Everything else is plain data, passed verbatim.
 */
export const agentWireOptionsSchema = z.strictObject({
  name: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  reasoning: reasoningWireSchema.optional(),
  schema: jsonSchemaObject.optional(),
  tools: z.array(toolDeclarationSchema).readonly().optional(),
  builtins: z
    .union([z.array(z.string()).readonly(), z.enum(["all", "read-only", "none"])])
    .optional(),
  cwd: z.string().optional(),
  mcp: z.array(mcpServerWireSchema).readonly().optional(),
  skills: z.array(z.string()).readonly().optional(),
  memory: z.string().optional(),
  humanInput: z.boolean().optional(),
  maxIterations: z.number().optional(),
  /** The wire form of `AgentOptions.session` — the session's id. */
  sessionId: z.string().optional(),
  attachments: z.array(attachmentWireSchema).readonly().optional(),
});
export type AgentWireOptions = z.infer<typeof agentWireOptionsSchema>;

// ============================================================================
// Other capability payload shapes
// ============================================================================

const callWireOptionsSchema = z.strictObject({ idempotencyKey: z.string().optional() });

const scheduleWireOptionsSchema = z.strictObject({
  cron: z.string().optional(),
  rate: z.string().optional(),
  /** One-shot instant as an ISO-8601 string (the client normalizes a `Date` before sending). */
  at: z.string().optional(),
  timezone: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

/** `SleepArg` on the wire — a `Date` in `until` is normalized to an ISO string by the client. */
export const sleepWireArgSchema = z.union([
  z.strictObject({ durationMs: z.number().nonnegative() }),
  z.strictObject({ until: z.string().min(1) }),
  z.number().nonnegative(),
]);
export type SleepWireArg = z.infer<typeof sleepWireArgSchema>;

// Human-input results: union ordered most-specific-first (multiselect, choice, text).
const humanMultiSelectResultSchema = z.strictObject({
  values: z.array(z.string()),
  other: z.string().optional(),
});
const humanChoiceResultSchema = z.strictObject({ value: z.string(), isOther: z.boolean() });
const humanTextResultSchema = z.strictObject({ value: z.string() });
export const humanInputResultSchema = z.union([
  humanMultiSelectResultSchema,
  humanChoiceResultSchema,
  humanTextResultSchema,
]);

const humanInputSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    multiline: z.boolean().optional(),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("choice"),
    options: z.array(z.string()).readonly(),
    allowOther: z.boolean().optional(),
    otherLabel: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("multiselect"),
    options: z.array(z.string()).readonly(),
    allowOther: z.boolean().optional(),
    otherLabel: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
]);

export const humanInputWireOptionsSchema = z.strictObject({
  key: z.string().optional(),
  prompt: z.string(),
  input: humanInputSpecSchema,
  assignees: z.array(z.string()).readonly().optional(),
  timeout: z.string().optional(),
  onTimeout: z
    .union([z.strictObject({ value: humanInputResultSchema }), z.literal("fail")])
    .optional(),
});

/** `ArtifactBody` on the wire: UTF-8 text as-is, raw bytes as base64. */
export const artifactWireBodySchema = z.discriminatedUnion("encoding", [
  z.strictObject({ encoding: z.literal("utf8"), data: z.string() }),
  z.strictObject({ encoding: z.literal("base64"), data: z.string() }),
]);
export type ArtifactWireBody = z.infer<typeof artifactWireBodySchema>;

export const artifactRefSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
});

const browserSessionOptionsWireSchema = z.strictObject({
  startUrl: z.string().optional(),
  viewport: z
    .strictObject({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),
  grounding: z.enum(["auto", "a11y", "vision", "none"]).optional(),
});

const consoleEntryWireSchema = z.strictObject({
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  text: z.string(),
  timestamp: z.number(),
});

const networkEntryWireSchema = z.strictObject({
  method: z.string(),
  url: z.string(),
  status: z.number().optional(),
  timestamp: z.number(),
});

const shellWireOptionsSchema = z.strictObject({
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().optional(),
  maxBuffer: z.number().optional(),
});

/** What `shell` resolves to — the completed command, exit code included (never thrown). */
export const shellResultSchema = z.strictObject({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});
export type ShellResult = z.infer<typeof shellResultSchema>;

const usageDimensionSchema = z.strictObject({
  /** What the run has consumed so far in this dimension. */
  spent: z.number().nonnegative(),
  /** The configured cap; `null` = uncapped (spent is still always reported). */
  cap: z.number().positive().nullable(),
  /** `cap - spent`; `null` = uncapped. */
  remaining: z.number().nullable(),
});
export type UsageDimension = z.infer<typeof usageDimensionSchema>;

/**
 * Live budget state, one entry per budget dimension — every dimension always present, with
 * `cap`/`remaining` null when uncapped. For authors who want to self-govern gracefully before
 * the platform's budget pause kicks in. (There is no budget push notification on this
 * protocol — a program that wants to self-govern polls `usage.get()`.)
 */
export const usageSnapshotSchema = z.strictObject({
  usd: usageDimensionSchema,
  tokens: usageDimensionSchema,
  compute_seconds: usageDimensionSchema,
});
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;

// ============================================================================
// Method registries
// ============================================================================

const sessionScoped = { sessionId: z.string().min(1) } as const;

/**
 * Client → host REQUESTS: params/result schema per method.
 *
 * `bootstrap` and `report_return` are LOADER-ONLY (SDK infrastructure that brackets the run —
 * never author API); everything else backs an author capability import.
 */
export const clientToHostRequests = {
  /**
   * Loader-only: the loader's first call; it then invokes `run(input, context)`. The wire
   * carries the raw JSON input plus the stored `input_schema` (`null` for an untyped
   * workflow) so the CLIENT applies the schema-guided revival pass — revival must happen in
   * the program process, because a revived value (`Date`, `bigint`, `Set`, `Uint8Array`) is
   * not JSON-serializable and could never cross the wire itself.
   */
  bootstrap: {
    params: emptyParams,
    result: z.strictObject({
      input: jsonValueSchema,
      input_schema: jsonSchemaObject.nullable(),
      context: contextDataSchema,
    }),
  },
  /** Loader-only: `run`'s return value; the host validates + persists it. `void` ⇒ `null`. */
  report_return: {
    params: z.strictObject({ value: jsonValueSchema }),
    result: emptyResult,
  },
  /**
   * Run an agent leaf to completion; the host runs the loop + emits run-events, the client
   * awaits the final value. `opts.tools` crosses as declarations only — the handlers stay in
   * the program and are called back via `tool_invoke`, correlated by `call_id` = this
   * request's own JSON-RPC id, as a string.
   */
  agent: {
    params: z.strictObject({ prompt: z.string(), opts: agentWireOptionsSchema.optional() }),
    result: z.strictObject({ output: jsonValueSchema }),
  },
  /**
   * Durable child run; the parent holds/snapshots until it ends. `output_schema` is the
   * CALLEE's declared output schema (`null` for an untyped callee) — the client applies the
   * generic schema-guided revival pass to `output` with it, so a child returning a `Date`
   * hands its parent a `Date`.
   */
  "workflows.call": {
    params: z.strictObject({
      slug: z.string().min(1),
      input: jsonValueSchema,
      opts: callWireOptionsSchema.optional(),
    }),
    result: z.strictObject({ output: jsonValueSchema, output_schema: jsonSchemaObject.nullable() }),
  },
  "workflows.run": {
    params: z.strictObject({
      slug: z.string().min(1),
      input: jsonValueSchema,
      opts: callWireOptionsSchema.optional(),
    }),
    result: z.strictObject({ runId: z.string().min(1) }),
  },
  "workflows.schedule": {
    params: z.strictObject({
      slug: z.string().min(1),
      input: jsonValueSchema,
      opts: scheduleWireOptionsSchema,
    }),
    result: z.strictObject({ scheduleId: z.string().min(1) }),
  },
  /** Resolves once the time has elapsed (the host may suspend/hold through the wait). */
  sleep: {
    params: z.strictObject({ arg: sleepWireArgSchema }),
    result: emptyResult,
  },
  /** Register-without-release + brokered answer poll; resolves with the validated response. */
  humanInput: {
    params: z.strictObject({ opts: humanInputWireOptionsSchema }),
    result: z.strictObject({ result: humanInputResultSchema }),
  },
  /** Broker-resolved; the manifest allowlist is enforced HOST-side (fail-closed). */
  "secrets.get": {
    params: z.strictObject({ name: z.string().min(1) }),
    result: z.strictObject({ value: z.string() }),
  },
  "artifacts.write": {
    params: z.strictObject({
      name: z.string().min(1),
      contentType: z.string().min(1),
      body: artifactWireBodySchema,
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    result: z.strictObject({ ref: artifactRefSchema }),
  },
  /** Opens a session; subsequent browser ops are the `computer.browser.*` sub-namespace, keyed by `sessionId`. */
  "computer.openBrowser": {
    params: z.strictObject({ opts: browserSessionOptionsWireSchema.optional() }),
    result: z.strictObject({ sessionId: z.string().min(1) }),
  },
  "computer.browser.navigate": {
    params: z.strictObject({ ...sessionScoped, url: z.string().min(1) }),
    result: emptyResult,
  },
  "computer.browser.url": {
    params: z.strictObject(sessionScoped),
    result: z.strictObject({ url: z.string() }),
  },
  "computer.browser.title": {
    params: z.strictObject(sessionScoped),
    result: z.strictObject({ title: z.string() }),
  },
  "computer.browser.screenshot": {
    params: z.strictObject({ ...sessionScoped, fullPage: z.boolean().optional() }),
    result: z.strictObject({ ref: artifactRefSchema }),
  },
  "computer.browser.console": {
    params: z.strictObject({ ...sessionScoped, since: z.number().optional() }),
    result: z.strictObject({ entries: z.array(consoleEntryWireSchema).readonly() }),
  },
  "computer.browser.network": {
    params: z.strictObject({ ...sessionScoped, since: z.number().optional() }),
    result: z.strictObject({ entries: z.array(networkEntryWireSchema).readonly() }),
  },
  /** Program-only page eval (deliberately never an agent tool). */
  "computer.browser.eval": {
    params: z.strictObject({ ...sessionScoped, expression: z.string() }),
    result: z.strictObject({ value: jsonValueSchema }),
  },
  "computer.browser.close": {
    params: z.strictObject(sessionScoped),
    result: emptyResult,
  },
  shell: {
    params: z.strictObject({ cmd: z.string().min(1), opts: shellWireOptionsSchema.optional() }),
    result: shellResultSchema,
  },
  /** Mint a short-lived OIDC id-token asserting this run's identity for `audience`. */
  "auth.idToken": {
    params: z.strictObject({ audience: z.string().min(1) }),
    result: z.strictObject({ token: z.string().min(1) }),
  },
  /** Mint a short-lived, manifest-scoped public-API bearer. */
  "auth.apiToken": {
    params: emptyParams,
    result: z.strictObject({ token: z.string().min(1) }),
  },
  "usage.get": {
    params: emptyParams,
    result: usageSnapshotSchema,
  },
} as const;

export type HostMethod = keyof typeof clientToHostRequests;
export type HostMethodParams<M extends HostMethod> = z.infer<
  (typeof clientToHostRequests)[M]["params"]
>;
export type HostMethodResult<M extends HostMethod> = z.infer<
  (typeof clientToHostRequests)[M]["result"]
>;

/** Client → host NOTIFICATIONS (no id, no response). */
export const clientToHostNotifications = {
  /** A run-timeline phase marker. Fire-and-forget; observability-only. */
  phase: {
    params: z.strictObject({
      name: z.string().min(1),
      opts: z.strictObject({ id: z.string().min(1).optional() }).optional(),
    }),
  },
} as const;

/**
 * Host → client REQUESTS (the callback lane — the protocol is full-duplex).
 *
 * `tool_invoke` is how an inline `agent()` tool declared in the program runs: the leaf loop
 * stays host-side (one engine, never reimplemented per language); the handler executes in the
 * program process, where it can close over program state and imports.
 *
 *  - `call_id` names the ORIGINATING `agent` call: it is that agent request's own JSON-RPC id,
 *    as a string — the client keys its per-agent-call handler map by it, so two concurrent
 *    `agent()` calls with same-named tools dispatch correctly.
 *  - Invocations multiplex by the `tool_invoke` request's own JSON-RPC id; multiple must be
 *    dispatchable concurrently (parallel tool calls in a turn + concurrent `agent()` calls).
 *  - A handler throw returns a JSON-RPC ERROR response, which the host feeds to the model as
 *    an ordinary tool-error result — NEVER run-fatal.
 *  - Tool timeouts are enforced host-side (the leaf's existing timeout); a late response to an
 *    abandoned invocation is discarded by id.
 */
export const hostToClientRequests = {
  tool_invoke: {
    params: z.strictObject({
      call_id: z.string().min(1),
      tool: z.string().min(1),
      input: jsonValueSchema,
    }),
    result: z.strictObject({ output: jsonValueSchema }),
  },
} as const;

export type ToolInvokeParams = z.infer<(typeof hostToClientRequests)["tool_invoke"]["params"]>;

/** Host → client NOTIFICATIONS. */
export const hostToClientNotifications = {
  /**
   * The run is being cancelled: the SDK aborts `context.signal`. (Backed by the runner's
   * brokered cancel poll; pushed to the program as a notification.)
   */
  cancel: {
    params: z.strictObject({ reason: z.string().min(1).optional() }),
  },
} as const;
