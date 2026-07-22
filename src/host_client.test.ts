// SPDX-License-Identifier: MIT

// Client ↔ fake-host tests over a REAL socket (net.createServer on a temp path), covering the
// P0 acceptance criteria: capability round-trips, concurrent request multiplexing, tool_invoke
// dispatch (incl. concurrent invocations and a handler throw → error response), cancel →
// signal abort, bootstrap/report_return, and late-response discard.

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectHost, getHost, resetHost } from "./host_client.js";
import type { HostClient } from "./host_client.js";
import { HostError, isRunFatal, type ContextData } from "./protocol.js";
import { agent, workflows } from "./index.js";
import type { ToolDef } from "./types.js";

// Unix socket paths are length-limited (~104 bytes on darwin), so use the system tmpdir —
// deliberately not the (long-pathed) scratchpad dir.
function tmpSockPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\bw-sdk-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-sdk-"));
  return path.join(dir, "host.sock");
}

interface ReceivedFrame {
  id?: number | string;
  method: string;
  params: unknown;
}

/**
 * A minimal fake host: serves methods from a handler map, records everything it receives,
 * and can push host→client requests (tool_invoke) and notifications (cancel).
 */
class FakeHost {
  readonly sockPath = tmpSockPath();
  readonly received: ReceivedFrame[] = [];
  handlers: Record<string, (params: unknown) => unknown> = {};

  private readonly server: net.Server;
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 1000;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  constructor() {
    this.server = net.createServer((socket) => {
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        let nl = this.buffer.indexOf("\n");
        while (nl !== -1) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          if (line.trim() !== "") this.onFrame(JSON.parse(line) as Record<string, unknown>);
          nl = this.buffer.indexOf("\n");
        }
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.sockPath, resolve);
    });
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  send(frame: unknown): void {
    if (this.socket === null) throw new Error("no client connected");
    this.socket.write(JSON.stringify(frame) + "\n");
  }

  /** Host → client request (e.g. tool_invoke); resolves with the client's result frame. */
  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  private onFrame(frame: Record<string, unknown>): void {
    if (typeof frame["method"] === "string") {
      const id = frame["id"] as number | string | undefined;
      const method = frame["method"];
      const params = frame["params"];
      this.received.push(id !== undefined ? { id, method, params } : { method, params });
      if (id === undefined) return; // notification
      const handler = this.handlers[method];
      if (handler === undefined) {
        this.send({
          jsonrpc: "2.0",
          id,
          error: { code: "METHOD_NOT_FOUND", message: `no fake handler for ${method}` },
        });
        return;
      }
      void (async () => {
        try {
          this.send({ jsonrpc: "2.0", id, result: await handler(params) });
        } catch (err: unknown) {
          const e = err as { code?: string; message?: string; data?: unknown };
          this.send({
            jsonrpc: "2.0",
            id,
            error: {
              code: e.code ?? "FAKE_ERROR",
              message: e.message ?? String(err),
              ...(e.data !== undefined ? { data: e.data } : {}),
            },
          });
        }
      })();
      return;
    }
    // A response to a host→client request.
    const id = frame["id"];
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if ("error" in frame) entry.reject(frame["error"]);
    else entry.resolve(frame["result"]);
  }
}

const CONTEXT_DATA: ContextData = {
  runId: "01J0000000000000000000RUN0",
  workflowId: "01J000000000000000000000WF",
  workflowVersion: 2,
  orgId: "01J00000000000000000000ORG",
  environment: null,
  actor: { type: "cron", rule: "0 9 * * MON" },
  attempt: 1,
  trigger: { kind: "cron", firedAt: 1750000000000, source: "sched_1" },
  workspaceDir: "/workspace",
};

let host: FakeHost;
let client: HostClient;
let savedSock: string | undefined;

beforeEach(async () => {
  savedSock = process.env.BOARDWALK_HOST_SOCK;
  resetHost();
  host = new FakeHost();
  await host.listen();
  process.env.BOARDWALK_HOST_SOCK = host.sockPath;
  client = await connectHost();
});

afterEach(async () => {
  client.close();
  await host.close();
  if (savedSock === undefined) delete process.env.BOARDWALK_HOST_SOCK;
  else process.env.BOARDWALK_HOST_SOCK = savedSock;
  resetHost();
});

describe("capability round-trips", () => {
  it("secrets.get round-trips over the socket", async () => {
    host.handlers["secrets.get"] = (params) => {
      expect(params).toEqual({ name: "GH_TOKEN" });
      return { value: "s3cret" };
    };
    await expect(client.getSecret("GH_TOKEN")).resolves.toBe("s3cret");
  });

  it("sleep normalizes a Date `until` to an ISO string on the wire", async () => {
    host.handlers["sleep"] = () => ({});
    await client.sleep({ until: new Date("2026-07-01T00:00:00.000Z") });
    expect(host.received.at(-1)?.params).toEqual({ arg: { until: "2026-07-01T00:00:00.000Z" } });
  });

  it("artifacts.write sends bytes as base64 and text as utf8", async () => {
    host.handlers["artifacts.write"] = () => ({
      ref: { id: "art_1", name: "a.bin", url: "https://cdn/a.bin" },
    });
    await client.writeArtifact("a.bin", "application/octet-stream", new Uint8Array([1, 2]), {
      k: "v",
    });
    expect(host.received.at(-1)?.params).toEqual({
      name: "a.bin",
      contentType: "application/octet-stream",
      body: { encoding: "base64", data: Buffer.from([1, 2]).toString("base64") },
      metadata: { k: "v" },
    });

    await client.writeArtifact("a.txt", "text/plain", "hi", undefined);
    expect(host.received.at(-1)?.params).toEqual({
      name: "a.txt",
      contentType: "text/plain",
      body: { encoding: "utf8", data: "hi" },
    });
  });

  it("shell resolves the completed command", async () => {
    host.handlers["shell"] = () => ({ exitCode: 3, stdout: "", stderr: "boom" });
    await expect(client.shell("exit 3", undefined)).resolves.toEqual({
      exitCode: 3,
      stdout: "",
      stderr: "boom",
    });
  });

  it("usage.get validates and returns the snapshot", async () => {
    const snapshot = {
      usd: { spent: 1, cap: 10, remaining: 9 },
      tokens: { spent: 0, cap: null, remaining: null },
      compute_seconds: { spent: 5, cap: null, remaining: null },
    };
    host.handlers["usage.get"] = () => snapshot;
    await expect(client.usage()).resolves.toEqual(snapshot);
  });

  it("phase goes out as a notification (no id) and blocks nothing", async () => {
    host.handlers["secrets.get"] = () => ({ value: "x" });
    client.phase("analyze", { id: "p1" });
    await client.getSecret("A"); // a later request flushes + orders the pipe
    const phaseFrame = host.received.find((f) => f.method === "phase");
    expect(phaseFrame).toEqual({
      method: "phase",
      params: { name: "analyze", opts: { id: "p1" } },
    });
  });

  it("a browser session's sub-namespace calls are keyed by its sessionId", async () => {
    host.handlers["computer.openBrowser"] = () => ({ sessionId: "sess_9" });
    host.handlers["computer.browser.navigate"] = (params) => {
      expect(params).toEqual({ sessionId: "sess_9", url: "https://example.com" });
      return {};
    };
    host.handlers["computer.browser.url"] = () => ({ url: "https://example.com/" });
    const session = await client.openBrowser({ startUrl: "about:blank" });
    expect(session.id).toBe("sess_9");
    await session.navigate("https://example.com");
    await expect(session.url()).resolves.toBe("https://example.com/");
  });

  it("a host error response rejects with a HostError carrying the taxonomy code", async () => {
    host.handlers["secrets.get"] = () => {
      throw Object.assign(new Error("budget exhausted"), { code: "BUDGET_EXCEEDED" });
    };
    const err = await client.getSecret("A").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).code).toBe("BUDGET_EXCEEDED");
    expect(isRunFatal(err)).toBe(true);
  });

  it("a malformed result rejects with PROTOCOL_ERROR instead of returning garbage", async () => {
    host.handlers["secrets.get"] = () => ({ nope: true });
    const err = await client.getSecret("A").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).code).toBe("PROTOCOL_ERROR");
  });
});

describe("multiplexing", () => {
  it("concurrent requests resolve to their own results even when answered out of order", async () => {
    const gate: { release?: () => void } = {};
    host.handlers["secrets.get"] = async (params) => {
      const { name } = params as { name: string };
      if (name === "SLOW") {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return { value: "slow-value" };
      }
      return { value: `fast:${name}` };
    };
    const slow = client.getSecret("SLOW");
    const fast = client.getSecret("FAST");
    await expect(fast).resolves.toBe("fast:FAST"); // FAST answered first
    gate.release?.();
    await expect(slow).resolves.toBe("slow-value");
  });

  it("discards a response for an unknown id and keeps working", async () => {
    host.handlers["secrets.get"] = () => ({ value: "ok" });
    host.send({ jsonrpc: "2.0", id: 999_999, result: { value: "stray" } });
    await expect(client.getSecret("A")).resolves.toBe("ok");
  });
});

describe("tool_invoke (the callback lane)", () => {
  function tool(name: string, execute: ToolDef["execute"]): ToolDef {
    return { name, description: `${name} tool`, inputSchema: { type: "object" }, execute };
  }

  it("dispatches to the calling agent's handler, keyed by the agent request's id", async () => {
    host.handlers["agent"] = async (params) => {
      const opts = (params as { opts: { tools: unknown } }).opts;
      // Declarations only — no executable code on the wire.
      expect(opts.tools).toEqual([
        { name: "lookup", description: "lookup tool", input_schema: { type: "object" } },
      ]);
      const agentFrame = host.received.at(-1);
      const result = await host.request("tool_invoke", {
        call_id: String(agentFrame?.id),
        tool: "lookup",
        input: { id: "x" },
      });
      expect(result).toEqual({ output: { found: true } });
      return { output: "done" };
    };
    const out = await client.agent("find it", {
      tools: [
        tool("lookup", (input) => Promise.resolve({ found: (input as { id: string }).id === "x" })),
      ],
    });
    expect(out).toBe("done");
  });

  it("dispatches two concurrent invocations concurrently", async () => {
    let firstRelease: (() => void) | undefined;
    const first = new Promise<void>((resolve) => (firstRelease = resolve));
    const order: string[] = [];
    host.handlers["agent"] = async () => {
      const callId = String(host.received.at(-1)?.id);
      const [a, b] = await Promise.all([
        host.request("tool_invoke", { call_id: callId, tool: "slow", input: null }),
        host.request("tool_invoke", { call_id: callId, tool: "fast", input: null }),
      ]);
      expect(a).toEqual({ output: "slow-done" });
      expect(b).toEqual({ output: "fast-done" });
      return { output: "ok" };
    };
    await client.agent("go", {
      tools: [
        tool("slow", async () => {
          await first;
          order.push("slow");
          return "slow-done";
        }),
        tool("fast", () => {
          // `fast` completing while `slow` is parked proves concurrent dispatch...
          order.push("fast");
          firstRelease?.(); // ...and then unblocks `slow`.
          return Promise.resolve("fast-done");
        }),
      ],
    });
    expect(order).toEqual(["fast", "slow"]);
  });

  it("a handler throw becomes a JSON-RPC error response (tool-error, never run-fatal)", async () => {
    host.handlers["agent"] = async () => {
      const callId = String(host.received.at(-1)?.id);
      const err = await host
        .request("tool_invoke", { call_id: callId, tool: "boom", input: null })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "TOOL_ERROR", message: "kaboom" });
      expect(isRunFatal(err)).toBe(false);
      return { output: "survived" };
    };
    const out = await client.agent("go", {
      tools: [
        tool("boom", () => {
          throw new Error("kaboom");
        }),
      ],
    });
    expect(out).toBe("survived");
  });

  it("an unknown tool or an abandoned agent call gets an UNKNOWN_TOOL error response", async () => {
    host.handlers["agent"] = async () => {
      const callId = String(host.received.at(-1)?.id);
      const err = await host
        .request("tool_invoke", { call_id: callId, tool: "nope", input: null })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "UNKNOWN_TOOL" });
      return { output: "ok" };
    };
    await client.agent("go", { tools: [tool("real", () => Promise.resolve(null))] });

    // After the agent call settles, its handler map is unregistered.
    const late = await host
      .request("tool_invoke", { call_id: "1", tool: "real", input: null })
      .catch((e: unknown) => e);
    expect(late).toMatchObject({ code: "UNKNOWN_TOOL" });
  });
});

describe("bootstrap / report_return / cancel", () => {
  it("bootstrap returns the input and a live, frozen Context (signal synthesized locally)", async () => {
    host.handlers["bootstrap"] = () => ({
      input: { pr: 7 },
      input_schema: null,
      context: CONTEXT_DATA,
    });
    const { input, context } = await client.bootstrap();
    expect(input).toEqual({ pr: 7 });
    expect(context.runId).toBe(CONTEXT_DATA.runId);
    expect(context.trigger).toEqual(CONTEXT_DATA.trigger);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.signal.aborted).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.actor)).toBe(true);
  });

  it("bootstrap revives the input by the carried input_schema (typed workflow)", async () => {
    host.handlers["bootstrap"] = () => ({
      input: { at: "2026-07-22T00:00:00.000Z", tags: ["a", "b"] },
      input_schema: {
        type: "object",
        properties: {
          at: { type: "string", format: "date-time" },
          tags: { type: "array", items: { type: "string" }, uniqueItems: true },
        },
      },
      context: CONTEXT_DATA,
    });
    const { input } = await client.bootstrap();
    const typed = input as { at: Date; tags: Set<string> };
    expect(typed.at).toBeInstanceOf(Date);
    expect(typed.at.toISOString()).toBe("2026-07-22T00:00:00.000Z");
    expect(typed.tags).toBeInstanceOf(Set);
    expect([...typed.tags]).toEqual(["a", "b"]);
  });

  it("report_return sends the run's return value ({} result)", async () => {
    host.handlers["report_return"] = (params) => {
      expect(params).toEqual({ value: { tier: "hot" } });
      return {};
    };
    await client.reportReturn({ tier: "hot" });
  });

  it("the cancel notification aborts the client's signal (context.signal)", async () => {
    host.handlers["bootstrap"] = () => ({ input: null, input_schema: null, context: CONTEXT_DATA });
    const { context } = await client.bootstrap();
    const aborted = new Promise<void>((resolve) => {
      context.signal.addEventListener("abort", () => {
        resolve();
      });
    });
    host.notify("cancel", { reason: "user requested" });
    await aborted;
    expect(context.signal.aborted).toBe(true);
    expect(isRunFatal(context.signal.reason)).toBe(true);
  });
});

describe("the author-facing facades over a real socket", () => {
  it("agent() routes through the lazily-resolved connected client", async () => {
    host.handlers["agent"] = () => ({ output: "hi" });
    await expect(agent("hello")).resolves.toBe("hi");
  });

  it("workflows.call revives the child output per the callee's output_schema", async () => {
    host.handlers["workflows.call"] = () => ({
      output: { finishedAt: "2026-07-01T00:00:00.000Z", total: "12" },
      output_schema: {
        type: "object",
        properties: {
          finishedAt: { type: "string", format: "date-time" },
          total: { type: "string", pattern: "^-?\\d+$" },
        },
      },
    });
    const out = (await workflows.call("child", { a: 1 })) as { finishedAt: Date; total: bigint };
    expect(out.finishedAt).toBeInstanceOf(Date);
    expect(out.finishedAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(out.total).toBe(12n);
  });

  it("workflows.call passes an untyped callee's output through as plain JSON", async () => {
    host.handlers["workflows.call"] = () => ({
      output: { finishedAt: "2026-07-01T00:00:00.000Z" },
      output_schema: null,
    });
    await expect(workflows.call("child", {})).resolves.toEqual({
      finishedAt: "2026-07-01T00:00:00.000Z",
    });
  });
});

describe("lazy connect", () => {
  it("getHost() connects to BOARDWALK_HOST_SOCK when no host is active yet", async () => {
    resetHost(); // drop the eagerly-connected client; env still points at the fake host
    host.handlers["secrets.get"] = () => ({ value: "lazy" });
    const lazy = await getHost();
    await expect(lazy.getSecret("A")).resolves.toBe("lazy");
  });
});
