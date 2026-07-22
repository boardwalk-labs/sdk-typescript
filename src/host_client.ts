// SPDX-License-Identifier: MIT

// The host client — the SDK side of the program↔host protocol (protocol.ts), plus the
// in-process test host that makes `run(input, context)` a plain unit-test call.
//
// Production flow (the runner's loader drives it):
//   1. The runner starts the protocol server and sets BOARDWALK_HOST_SOCK.
//   2. The loader calls `connectHost()`, then `client.bootstrap()` → { input, context }.
//   3. It imports the entry module and calls `run(input, context)`.
//   4. It reports the return via `client.reportReturn(value)`.
//
// The capability imports (index.ts) route through a module-level ACTIVE HOST: the connected
// client, or the fake installed by `installTestHost()`. If neither is present when a
// capability is first called, the SDK lazily connects to BOARDWALK_HOST_SOCK — so a program
// works whether the loader connected eagerly or not. Node ESM caches this module by resolved
// path, so the program and the loader share one instance and therefore one host.
//
// The socket is `node:net` — a Unix domain socket path, or a win32 named pipe
// (`\\.\pipe\...`) for local dev on Windows. Frames are newline-delimited JSON (one JSON-RPC
// frame per line). Requests multiplex concurrently by JSON-RPC id; incoming `tool_invoke`
// requests dispatch (concurrently) to the per-agent-call handler maps; the `cancel`
// notification aborts the client-held AbortController behind `context.signal`.

import * as net from "node:net";

import {
  HostError,
  clientToHostRequests,
  contextDataSchema,
  hostToClientRequests,
  rpcFrameSchema,
  type AgentWireOptions,
  type Context,
  type ContextData,
  type HostMethod,
  type HostMethodParams,
  type HostMethodResult,
  type RpcId,
  type ShellResult,
  type SleepWireArg,
  type ToolDeclaration,
  type UsageSnapshot,
} from "./protocol.js";
import { reviveBySchema } from "./revive.js";
import type { ShellOptions } from "./shell.js";
import type {
  AgentOptions,
  ArtifactBody,
  ArtifactRef,
  BrowserSession,
  BrowserSessionOptions,
  CallOptions,
  HumanInputOptions,
  HumanInputResult,
  JsonValue,
  NetworkEntry,
  PhaseOptions,
  ScheduleOptions,
  SleepArg,
  ToolDef,
} from "./types.js";

/** The env var naming the host socket: a Unix socket path, or a win32 named pipe. */
export const HOST_SOCK_ENV = "BOARDWALK_HOST_SOCK";

const NO_HOST_MESSAGE =
  "@boardwalk-labs/workflow capabilities were called with no host available. Under a " +
  `Boardwalk engine the runner sets ${HOST_SOCK_ENV} and the SDK connects automatically; ` +
  "in unit tests call installTestHost({ ... }) first.";

/** What `workflows.call` returns at the host seam — the raw output plus the CALLEE's schema
 *  (`null` for an untyped callee). The `workflows.call` facade applies the revival pass. */
export interface WorkflowCallResult {
  output: unknown;
  outputSchema: Record<string, unknown> | null;
}

/**
 * The capability seam both the socket-backed {@link HostClient} and the in-process test host
 * (from {@link installTestHost}) implement. The author-facing imports in index.ts are thin
 * facades over the active implementation of this interface.
 */
export interface HostInterface {
  /** Aborts when the run is cancelled — the backing of `context.signal`. */
  readonly signal: AbortSignal;
  agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown>;
  callWorkflow(
    slug: string,
    input: unknown,
    opts: CallOptions | undefined,
  ): Promise<WorkflowCallResult>;
  runWorkflow(slug: string, input: unknown, opts: CallOptions | undefined): Promise<string>;
  scheduleWorkflow(slug: string, input: unknown, opts: ScheduleOptions): Promise<string>;
  sleep(arg: SleepArg): Promise<void>;
  humanInput(opts: HumanInputOptions): Promise<HumanInputResult>;
  getSecret(name: string): Promise<string>;
  writeArtifact(
    name: string,
    contentType: string,
    body: ArtifactBody,
    metadata: Record<string, unknown> | undefined,
  ): Promise<ArtifactRef>;
  openBrowser(opts: BrowserSessionOptions | undefined): Promise<BrowserSession>;
  shell(cmd: string, opts: ShellOptions | undefined): Promise<ShellResult>;
  phase(name: string, opts: PhaseOptions | undefined): void;
  idToken(audience: string): Promise<string>;
  apiToken(): Promise<string>;
  usage(): Promise<UsageSnapshot>;
}

// A capability payload is serialized to JSON on the wire; anything non-JSON is dropped by
// JSON.stringify exactly as it always was at this boundary. The cast is confined here.
function asJsonValue(value: unknown): JsonValue {
  return (value === undefined ? null : value) as JsonValue;
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

// ============================================================================
// The socket-backed protocol client
// ============================================================================

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Connection options for {@link connectHost}. */
export interface ConnectOptions {
  /** Socket path override; defaults to `process.env.BOARDWALK_HOST_SOCK`. */
  sockPath?: string;
}

/**
 * The JSON-RPC protocol client (see protocol.ts for the wire contract). Construct via
 * {@link connectHost} (which also installs it as the active host) or {@link HostClient.connect}.
 */
export class HostClient implements HostInterface {
  private readonly socket: net.Socket;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Per-agent-call tool handler maps, keyed by the agent request's JSON-RPC id (as a string). */
  private readonly toolHandlers = new Map<string, ReadonlyMap<string, ToolDef>>();
  private readonly cancelController = new AbortController();
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.onData(chunk);
    });
    socket.on("error", (err) => {
      this.failAllPending(new HostError("CONNECTION_CLOSED", `host socket error: ${err.message}`));
    });
    socket.on("close", () => {
      this.closed = true;
      this.failAllPending(new HostError("CONNECTION_CLOSED", "the host closed the connection"));
    });
  }

  /** Connect to the host socket (a Unix socket path, or a win32 named pipe). */
  static async connect(sockPath: string): Promise<HostClient> {
    const socket = net.connect({ path: sockPath });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        reject(new Error(`could not connect to the Boardwalk host at ${sockPath}: ${err.message}`));
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve();
      });
    });
    return new HostClient(socket);
  }

  /** Aborts when the host sends the `cancel` notification. */
  get signal(): AbortSignal {
    return this.cancelController.signal;
  }

  /** Tear down the connection. In-flight requests reject with CONNECTION_CLOSED. */
  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  // -- loader-only surface ---------------------------------------------------

  /**
   * The loader's first call: fetch `{ input, context }`. The wire carries the context DATA;
   * this client builds the live, frozen `Context`, synthesizing `signal` from the host's
   * `cancel` notification (it is never a wire field).
   */
  async bootstrap(): Promise<{ input: unknown; context: Context }> {
    const { input, input_schema, context } = await this.request("bootstrap", {});
    // The revival pass runs HERE, client-side: a revived Date/bigint/Set/Uint8Array is not
    // JSON, so the host can only ever send the raw payload + the schema that guides revival.
    const revived = input_schema === null ? input : reviveBySchema(input, input_schema);
    return { input: revived, context: this.buildContext(context) };
  }

  /** The loader reports `run`'s return; the host validates + persists it. `void` ⇒ `null`. */
  async reportReturn(value: unknown): Promise<void> {
    await this.request("report_return", { value: asJsonValue(value) });
  }

  private buildContext(data: ContextData): Context {
    Object.freeze(data.environment);
    Object.freeze(data.actor);
    Object.freeze(data.trigger);
    return Object.freeze({ ...data, signal: this.cancelController.signal });
  }

  // -- capability surface (HostInterface) ------------------------------------

  async agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown> {
    const id = this.allocId();
    const tools = opts?.tools;
    if (tools !== undefined && tools.length > 0) {
      this.toolHandlers.set(String(id), new Map(tools.map((t) => [t.name, t])));
    }
    try {
      const { output } = await this.requestWithId(id, "agent", {
        prompt,
        opts: toWireAgentOptions(opts),
      });
      return output;
    } finally {
      this.toolHandlers.delete(String(id));
    }
  }

  async callWorkflow(
    slug: string,
    input: unknown,
    opts: CallOptions | undefined,
  ): Promise<WorkflowCallResult> {
    const result = await this.request("workflows.call", {
      slug,
      input: asJsonValue(input),
      opts: toWireCallOptions(opts),
    });
    return { output: result.output, outputSchema: result.output_schema };
  }

  async runWorkflow(slug: string, input: unknown, opts: CallOptions | undefined): Promise<string> {
    const { runId } = await this.request("workflows.run", {
      slug,
      input: asJsonValue(input),
      opts: toWireCallOptions(opts),
    });
    return runId;
  }

  async scheduleWorkflow(slug: string, input: unknown, opts: ScheduleOptions): Promise<string> {
    const { scheduleId } = await this.request("workflows.schedule", {
      slug,
      input: asJsonValue(input),
      opts: {
        ...(opts.cron !== undefined ? { cron: opts.cron } : {}),
        ...(opts.rate !== undefined ? { rate: opts.rate } : {}),
        ...(opts.at !== undefined
          ? { at: opts.at instanceof Date ? opts.at.toISOString() : opts.at }
          : {}),
        ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
        ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
    });
    return scheduleId;
  }

  async sleep(arg: SleepArg): Promise<void> {
    let wire: SleepWireArg;
    if (typeof arg === "number") {
      wire = arg;
    } else if ("until" in arg) {
      wire = { until: arg.until instanceof Date ? arg.until.toISOString() : arg.until };
    } else {
      wire = { durationMs: arg.durationMs };
    }
    await this.request("sleep", { arg: wire });
  }

  async humanInput(opts: HumanInputOptions): Promise<HumanInputResult> {
    const { result } = await this.request("humanInput", { opts });
    // Rebuild without explicit-undefined optionals (exactOptionalPropertyTypes).
    if ("values" in result) {
      return result.other !== undefined
        ? { values: result.values, other: result.other }
        : { values: result.values };
    }
    return result;
  }

  async getSecret(name: string): Promise<string> {
    const { value } = await this.request("secrets.get", { name });
    return value;
  }

  async writeArtifact(
    name: string,
    contentType: string,
    body: ArtifactBody,
    metadata: Record<string, unknown> | undefined,
  ): Promise<ArtifactRef> {
    const wireBody =
      typeof body === "string"
        ? ({ encoding: "utf8", data: body } as const)
        : ({ encoding: "base64", data: Buffer.from(body).toString("base64") } as const);
    const { ref } = await this.request("artifacts.write", {
      name,
      contentType,
      body: wireBody,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    return ref;
  }

  async openBrowser(opts: BrowserSessionOptions | undefined): Promise<BrowserSession> {
    const { sessionId } = await this.request("computer.openBrowser", {
      ...(opts !== undefined ? { opts } : {}),
    });
    return this.makeBrowserSession(sessionId);
  }

  async shell(cmd: string, opts: ShellOptions | undefined): Promise<ShellResult> {
    return await this.request("shell", { cmd, ...(opts !== undefined ? { opts } : {}) });
  }

  phase(name: string, opts: PhaseOptions | undefined): void {
    this.sendFrame({
      jsonrpc: "2.0",
      method: "phase",
      params: { name, ...(opts !== undefined ? { opts } : {}) },
    });
  }

  async idToken(audience: string): Promise<string> {
    const { token } = await this.request("auth.idToken", { audience });
    return token;
  }

  async apiToken(): Promise<string> {
    const { token } = await this.request("auth.apiToken", {});
    return token;
  }

  async usage(): Promise<UsageSnapshot> {
    return await this.request("usage.get", {});
  }

  private makeBrowserSession(sessionId: string): BrowserSession {
    const request = this.request.bind(this);
    return {
      id: sessionId,
      async navigate(url: string): Promise<void> {
        await request("computer.browser.navigate", { sessionId, url });
      },
      async url(): Promise<string> {
        return (await request("computer.browser.url", { sessionId })).url;
      },
      async title(): Promise<string> {
        return (await request("computer.browser.title", { sessionId })).title;
      },
      async screenshot(opts?: { fullPage?: boolean }): Promise<ArtifactRef> {
        return (
          await request("computer.browser.screenshot", {
            sessionId,
            ...(opts?.fullPage !== undefined ? { fullPage: opts.fullPage } : {}),
          })
        ).ref;
      },
      async console(opts?: { since?: number }) {
        return (
          await request("computer.browser.console", {
            sessionId,
            ...(opts?.since !== undefined ? { since: opts.since } : {}),
          })
        ).entries;
      },
      async network(opts?: { since?: number }) {
        const { entries } = await request("computer.browser.network", {
          sessionId,
          ...(opts?.since !== undefined ? { since: opts.since } : {}),
        });
        // Rebuild without explicit-undefined optionals (exactOptionalPropertyTypes).
        return entries.map(
          (e): NetworkEntry => ({
            method: e.method,
            url: e.url,
            timestamp: e.timestamp,
            ...(e.status !== undefined ? { status: e.status } : {}),
          }),
        );
      },
      async eval<T = unknown>(expression: string): Promise<T> {
        // The page-eval result is whatever JSON the page produced; T is the caller's assertion,
        // same boundary cast as agent()'s schema-typed overload.
        return (await request("computer.browser.eval", { sessionId, expression })).value as T;
      },
      async close(): Promise<void> {
        await request("computer.browser.close", { sessionId });
      },
    };
  }

  // -- wire plumbing ---------------------------------------------------------

  private allocId(): number {
    return this.nextId++;
  }

  private async request<M extends HostMethod>(
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    return await this.requestWithId(this.allocId(), method, params);
  }

  private async requestWithId<M extends HostMethod>(
    id: number,
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    if (this.closed) {
      throw new HostError(
        "CONNECTION_CLOSED",
        `cannot call ${method}: the host connection is closed`,
      );
    }
    const raw = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendFrame({ jsonrpc: "2.0", id, method, params });
    });
    const parsed = clientToHostRequests[method].result.safeParse(raw);
    if (!parsed.success) {
      throw new HostError("PROTOCOL_ERROR", `malformed ${method} result: ${parsed.error.message}`);
    }
    // The registry is indexed by a generic M, so parse() types as the union of all results;
    // the schema that ran IS clientToHostRequests[M].result, making this cast exact.
    return parsed.data as HostMethodResult<M>;
  }

  private sendFrame(frame: unknown): void {
    this.socket.write(JSON.stringify(frame) + "\n");
  }

  private failAllPending(reason: HostError): void {
    for (const entry of this.pending.values()) entry.reject(reason);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return; // not JSON — a protocol violation we can't even respond to; drop the line
    }
    const parsed = rpcFrameSchema.safeParse(value);
    if (!parsed.success) return; // malformed frame — drop
    const frame = parsed.data;
    if ("method" in frame) {
      if ("id" in frame) this.onIncomingRequest(frame.id, frame.method, frame.params);
      else this.onIncomingNotification(frame.method);
      return;
    }
    if ("error" in frame) {
      if (frame.id === null) return;
      this.settle(frame.id, (entry) => {
        entry.reject(new HostError(frame.error.code, frame.error.message, frame.error.data));
      });
      return;
    }
    this.settle(frame.id, (entry) => {
      entry.resolve(frame.result);
    });
  }

  /** A response for an unknown/abandoned id is discarded (the spec'd late-response rule). */
  private settle(id: RpcId, apply: (entry: Pending) => void): void {
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    apply(entry);
  }

  private onIncomingNotification(method: string): void {
    if (method === "cancel") {
      this.cancelController.abort(new HostError("CANCELLED", "the run was cancelled"));
    }
    // Unknown notifications are ignored (additive forward-compat).
  }

  private onIncomingRequest(id: RpcId, method: string, params: unknown): void {
    if (method !== "tool_invoke") {
      this.respondError(id, "METHOD_NOT_FOUND", `unknown host→program method "${method}"`);
      return;
    }
    const parsed = hostToClientRequests.tool_invoke.params.safeParse(params);
    if (!parsed.success) {
      this.respondError(
        id,
        "INVALID_PARAMS",
        `malformed tool_invoke params: ${parsed.error.message}`,
      );
      return;
    }
    const { call_id, tool, input } = parsed.data;
    const def = this.toolHandlers.get(call_id)?.get(tool);
    if (def === undefined) {
      this.respondError(
        id,
        "UNKNOWN_TOOL",
        `no handler registered for tool "${tool}" on agent call ${call_id}`,
      );
      return;
    }
    // Deliberately not awaited: multiple tool_invoke requests dispatch CONCURRENTLY (parallel
    // tool calls in a turn + concurrent agent() calls). A handler throw becomes a JSON-RPC
    // error response — the host feeds it to the model as a tool-error result, never run-fatal.
    void (async () => {
      try {
        const output = await def.execute(input);
        this.sendFrame({ jsonrpc: "2.0", id, result: { output: asJsonValue(output) } });
      } catch (err: unknown) {
        this.respondError(id, "TOOL_ERROR", reasonText(err));
      }
    })();
  }

  private respondError(id: RpcId, code: string, message: string): void {
    this.sendFrame({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

/** AgentOptions → the wire shape: tools become declarations, a session becomes its id. */
function toWireAgentOptions(opts: AgentOptions | undefined): AgentWireOptions | undefined {
  if (opts === undefined) return undefined;
  const { tools, session, ...rest } = opts;
  return {
    ...rest,
    ...(tools !== undefined
      ? {
          tools: tools.map(
            (t): ToolDeclaration => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            }),
          ),
        }
      : {}),
    ...(session !== undefined ? { sessionId: session.id } : {}),
  };
}

function toWireCallOptions(opts: CallOptions | undefined): { idempotencyKey?: string } | undefined {
  if (opts === undefined) return undefined;
  return opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {};
}

// ============================================================================
// The active host (module singleton)
// ============================================================================

let activeHost: HostInterface | null = null;
let pendingConnect: Promise<HostInterface> | null = null;

/** The active host without connecting or throwing (null if none). */
export function peekHost(): HostInterface | null {
  return activeHost;
}

/**
 * The active host, connecting lazily to `BOARDWALK_HOST_SOCK` when no host is installed yet.
 * Rejects with a clear error when there is no test host and no socket to connect to.
 */
export function getHost(): Promise<HostInterface> {
  if (activeHost !== null) return Promise.resolve(activeHost);
  pendingConnect ??= connectHost().catch((err: unknown) => {
    pendingConnect = null; // a failed lazy connect must not poison every later call
    throw err;
  });
  return pendingConnect;
}

/**
 * Connect to the host socket and install the client as the active host. Called by the
 * runner's loader before the program module is imported; author programs never call it —
 * their capability imports connect lazily if needed.
 */
export async function connectHost(options?: ConnectOptions): Promise<HostClient> {
  const sockPath = options?.sockPath ?? process.env[HOST_SOCK_ENV];
  if (sockPath === undefined || sockPath === "") throw new Error(NO_HOST_MESSAGE);
  const client = await HostClient.connect(sockPath);
  activeHost = client;
  return client;
}

/** Clear the active host + any pending lazy connect. Primarily for tests. */
export function resetHost(): void {
  activeHost = null;
  pendingConnect = null;
}

// ============================================================================
// The test host — run(input, context) as a plain unit-test call
// ============================================================================

type MaybePromise<T> = T | Promise<T>;

/**
 * Capability stubs for {@link installTestHost}, mirroring the author-facing import surface.
 * Every stub is optional: a called-but-unstubbed capability throws a clear error naming the
 * stub to pass; `sleep` defaults to resolving immediately, `phase` to a no-op, and `usage`
 * to zero-spend with no caps.
 */
export interface TestHostOverrides {
  agent?: (prompt: string, opts?: AgentOptions) => MaybePromise<unknown>;
  workflows?: {
    /** Returns the child's OUTPUT value (the test host reports no output schema). */
    call?: (slug: string, input: unknown, opts?: CallOptions) => MaybePromise<unknown>;
    run?: (slug: string, input: unknown, opts?: CallOptions) => MaybePromise<string>;
    schedule?: (slug: string, input: unknown, opts?: ScheduleOptions) => MaybePromise<string>;
  };
  sleep?: (arg: SleepArg) => MaybePromise<void>;
  humanInput?: (opts: HumanInputOptions) => MaybePromise<HumanInputResult>;
  /** A name→value map, or a resolver function. */
  secrets?: Record<string, string> | ((name: string) => MaybePromise<string>);
  artifacts?: {
    write?: (
      name: string,
      contentType: string,
      body: ArtifactBody,
      metadata?: Record<string, unknown>,
    ) => MaybePromise<ArtifactRef>;
  };
  computer?: {
    openBrowser?: (opts?: BrowserSessionOptions) => MaybePromise<BrowserSession>;
  };
  shell?: (cmd: string, opts?: ShellOptions) => MaybePromise<ShellResult>;
  phase?: (name: string, opts?: PhaseOptions) => void;
  auth?: {
    idToken?: (audience: string) => MaybePromise<string>;
    apiToken?: () => MaybePromise<string>;
  };
  usage?: () => MaybePromise<UsageSnapshot>;
}

/** Handle returned by {@link installTestHost}. */
export interface TestHostHandle {
  /** The signal `context({...}).signal` carries; aborts on {@link TestHostHandle.cancel}. */
  readonly signal: AbortSignal;
  /** Simulate the run being cancelled (aborts the signal with a CANCELLED HostError). */
  cancel(reason?: unknown): void;
  /** Remove this test host (a later `installTestHost` also replaces it). */
  uninstall(): void;
  /** A plausible frozen `Context` wired to this host's signal; override any field. */
  context(overrides?: Partial<Context>): Context;
}

function notStubbed(what: string): never {
  throw new Error(`${what} is not stubbed — pass an implementation to installTestHost({ ... })`);
}

const ZERO_USAGE: UsageSnapshot = {
  usd: { spent: 0, cap: null, remaining: null },
  tokens: { spent: 0, cap: null, remaining: null },
  compute_seconds: { spent: 0, cap: null, remaining: null },
};

/**
 * Install an in-process fake host implementing the same {@link HostInterface} the socket
 * client does, so `run(input, context)` is unit-testable as a plain call — no socket, no
 * engine. Stub only what the code under test uses; anything else throws a clear error.
 *
 *   const host = installTestHost({ agent: async () => "LGTM", secrets: { GH_TOKEN: "t" } });
 *   const out = await run({ pr: 7 }, host.context());
 */
export function installTestHost(overrides: TestHostOverrides = {}): TestHostHandle {
  const controller = new AbortController();

  const host: HostInterface = {
    signal: controller.signal,
    async agent(prompt, opts) {
      const fn = overrides.agent;
      if (fn === undefined) notStubbed("agent");
      return await fn(prompt, opts);
    },
    async callWorkflow(slug, input, opts) {
      const fn = overrides.workflows?.call;
      if (fn === undefined) notStubbed("workflows.call");
      return { output: await fn(slug, input, opts), outputSchema: null };
    },
    async runWorkflow(slug, input, opts) {
      const fn = overrides.workflows?.run;
      if (fn === undefined) notStubbed("workflows.run");
      return await fn(slug, input, opts);
    },
    async scheduleWorkflow(slug, input, opts) {
      const fn = overrides.workflows?.schedule;
      if (fn === undefined) notStubbed("workflows.schedule");
      return await fn(slug, input, opts);
    },
    async sleep(arg) {
      await overrides.sleep?.(arg);
    },
    async humanInput(opts) {
      const fn = overrides.humanInput;
      if (fn === undefined) notStubbed("humanInput");
      return await fn(opts);
    },
    async getSecret(name) {
      const stub = overrides.secrets;
      if (stub === undefined) notStubbed(`secrets.get("${name}")`);
      if (typeof stub === "function") return await stub(name);
      const value = stub[name];
      if (value === undefined) notStubbed(`secret "${name}"`);
      return value;
    },
    async writeArtifact(name, contentType, body, metadata) {
      const fn = overrides.artifacts?.write;
      if (fn === undefined) notStubbed("artifacts.write");
      return await fn(name, contentType, body, metadata);
    },
    async openBrowser(opts) {
      const fn = overrides.computer?.openBrowser;
      if (fn === undefined) notStubbed("computer.openBrowser");
      return await fn(opts);
    },
    async shell(cmd, opts) {
      const fn = overrides.shell;
      if (fn === undefined) notStubbed("shell");
      return await fn(cmd, opts);
    },
    phase(name, opts) {
      overrides.phase?.(name, opts);
    },
    async idToken(audience) {
      const fn = overrides.auth?.idToken;
      if (fn === undefined) notStubbed("auth.idToken");
      return await fn(audience);
    },
    async apiToken() {
      const fn = overrides.auth?.apiToken;
      if (fn === undefined) notStubbed("auth.apiToken");
      return await fn();
    },
    async usage() {
      return (await overrides.usage?.()) ?? ZERO_USAGE;
    },
  };

  activeHost = host;
  pendingConnect = null;

  return {
    signal: controller.signal,
    cancel(reason?: unknown) {
      controller.abort(reason ?? new HostError("CANCELLED", "the run was cancelled"));
    },
    uninstall() {
      if (activeHost === host) activeHost = null;
    },
    context(overrides?: Partial<Context>): Context {
      const defaults: ContextData = contextDataSchema.parse({
        runId: "01TESTRUN00000000000000000",
        workflowId: "01TESTWORKFLOW000000000000",
        workflowVersion: 1,
        orgId: "01TESTORG00000000000000000",
        environment: null,
        actor: { type: "user", user_id: "01TESTUSER0000000000000000" },
        attempt: 1,
        trigger: { kind: "manual", firedAt: Date.now() },
        workspaceDir: process.cwd(),
      } satisfies ContextData);
      return Object.freeze({ ...defaults, signal: controller.signal, ...overrides });
    },
  };
}
