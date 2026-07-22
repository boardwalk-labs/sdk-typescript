// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  HostError,
  RUN_FATAL_CODES,
  actorSchema,
  agentWireOptionsSchema,
  artifactWireBodySchema,
  clientToHostNotifications,
  clientToHostRequests,
  contextDataSchema,
  hostToClientNotifications,
  hostToClientRequests,
  humanInputResultSchema,
  isRunFatal,
  protocolErrorSchema,
  rpcFrameSchema,
  shellResultSchema,
  sleepWireArgSchema,
  usageSnapshotSchema,
  type Actor,
  type ContextData,
} from "./protocol.js";

/** Round-trip: parse must succeed AND return the exact value (no silent stripping). */
function roundTrip(schema: { parse: (v: unknown) => unknown }, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

describe("frames", () => {
  it("round-trips request / notification / success / error frames", () => {
    roundTrip(rpcFrameSchema, {
      jsonrpc: "2.0",
      id: 1,
      method: "secrets.get",
      params: { name: "A" },
    });
    roundTrip(rpcFrameSchema, { jsonrpc: "2.0", method: "phase", params: { name: "plan" } });
    roundTrip(rpcFrameSchema, { jsonrpc: "2.0", id: 1, result: { value: "s3cret" } });
    roundTrip(rpcFrameSchema, {
      jsonrpc: "2.0",
      id: 7,
      error: { code: "BUDGET_EXCEEDED", message: "out of budget", data: { dimension: "usd" } },
    });
    // Per JSON-RPC 2.0, an error for an unreadable frame carries id: null.
    roundTrip(rpcFrameSchema, {
      jsonrpc: "2.0",
      id: null,
      error: { code: "PARSE_ERROR", message: "bad frame" },
    });
  });

  it("rejects a frame with an unknown key or a missing jsonrpc tag", () => {
    expect(rpcFrameSchema.safeParse({ id: 1, method: "agent" }).success).toBe(false);
    expect(
      rpcFrameSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "agent", extra: true }).success,
    ).toBe(false);
  });

  it("error codes are strings from the taxonomy, not JSON-RPC integers", () => {
    expect(protocolErrorSchema.safeParse({ code: -32601, message: "x" }).success).toBe(false);
    roundTrip(protocolErrorSchema, { code: "CANCELLED", message: "the run was cancelled" });
  });
});

describe("isRunFatal (shared cross-SDK semantics)", () => {
  it("is fatal for the run-fatal codes and an explicit fatal flag", () => {
    for (const code of RUN_FATAL_CODES) {
      expect(isRunFatal(Object.assign(new Error("e"), { code }))).toBe(true);
      expect(isRunFatal(new HostError(code, "e"))).toBe(true);
    }
    expect(isRunFatal(Object.assign(new Error("e"), { fatal: true }))).toBe(true);
  });

  it("is not fatal for anything else", () => {
    expect(isRunFatal(new Error("boom"))).toBe(false);
    expect(isRunFatal(new HostError("PROVIDER_ERROR", "e"))).toBe(false);
    expect(isRunFatal(Object.assign(new Error("e"), { fatal: false, code: "OTHER" }))).toBe(false);
    expect(isRunFatal(null)).toBe(false);
    expect(isRunFatal(undefined)).toBe(false);
    expect(isRunFatal("BUDGET_EXCEEDED")).toBe(false); // a string is not an error carrying a code
  });
});

describe("loader-only methods", () => {
  const context: ContextData = {
    runId: "01J0000000000000000000RUN0",
    workflowId: "01J000000000000000000000WF",
    workflowVersion: 3,
    orgId: "01J00000000000000000000ORG",
    environment: { id: "01J00000000000000000000ENV", name: "production" },
    actor: { type: "user", user_id: "01J0000000000000000000USER" },
    attempt: 1,
    trigger: { kind: "webhook", firedAt: 1750000000000, source: "wh_1" },
    workspaceDir: "/workspace",
  };

  it("bootstrap round-trips { input, context } — context is DATA only (no signal field)", () => {
    roundTrip(clientToHostRequests.bootstrap.result, {
      input: { pr: 7 },
      input_schema: null,
      context,
    });
    roundTrip(clientToHostRequests.bootstrap.result, {
      input: { at: "2026-07-22T00:00:00.000Z" },
      input_schema: { type: "object", properties: { at: { type: "string" } } },
      context,
    });
    expect(
      clientToHostRequests.bootstrap.result.safeParse({
        input: null,
        input_schema: null,
        context: { ...context, signal: {} },
      }).success,
    ).toBe(false);
  });

  it("context round-trips every actor variant", () => {
    const actors: Actor[] = [
      { type: "user", user_id: "01JUSER" },
      {
        type: "workflow",
        parent_run_id: "01JPRUN",
        parent_workflow_id: "01JPWF",
        user_id: "workflow:01JPWF",
      },
      { type: "webhook", source: "wh_1" },
      { type: "cron", rule: "0 9 * * MON" },
      {
        type: "event",
        subscription_id: "01JSUB",
        source_run_id: "01JSRUN",
        source_workflow_id: "01JSWF",
        event_type: "run.completed",
        event_chain_depth: 1,
      },
    ];
    for (const actor of actors) {
      roundTrip(actorSchema, actor);
      roundTrip(contextDataSchema, { ...context, actor });
    }
  });

  it("context rejects a fourth trigger kind (the two-axis rule: actor says the rest)", () => {
    expect(
      contextDataSchema.safeParse({
        ...context,
        trigger: { kind: "workflow_call", firedAt: 1 },
      }).success,
    ).toBe(false);
  });

  it("report_return takes any JSON value (void runs report null)", () => {
    roundTrip(clientToHostRequests.report_return.params, { value: null });
    roundTrip(clientToHostRequests.report_return.params, { value: { items: [1, "a", false] } });
  });
});

describe("capability methods", () => {
  it("agent params round-trip with declaration-only tools (input_schema, no execute)", () => {
    roundTrip(clientToHostRequests.agent.params, {
      prompt: "triage",
      opts: {
        name: "triager",
        model: "anthropic/claude-sonnet-4.5",
        reasoning: "high",
        schema: { type: "object" },
        tools: [
          { name: "lookup", description: "Look a thing up", input_schema: { type: "object" } },
        ],
        builtins: "read-only",
        mcp: [{ name: "gh", transport: "http", url: "https://mcp.example" }],
        skills: ["review"],
        humanInput: true,
        sessionId: "sess_1",
      },
    });
    // A ToolDef with its handler attached must NOT cross the wire.
    expect(
      agentWireOptionsSchema.safeParse({
        tools: [
          {
            name: "t",
            description: "d",
            input_schema: {},
            execute: () => Promise.resolve(null),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("workflows.call result carries the callee's output_schema, nullable for untyped callees", () => {
    roundTrip(clientToHostRequests["workflows.call"].result, {
      output: { finishedAt: "2026-07-01T00:00:00Z" },
      output_schema: {
        type: "object",
        properties: { finishedAt: { type: "string", format: "date-time" } },
      },
    });
    roundTrip(clientToHostRequests["workflows.call"].result, {
      output: "plain",
      output_schema: null,
    });
    // output_schema is REQUIRED (nullable, never absent) — an omission is a protocol bug.
    expect(clientToHostRequests["workflows.call"].result.safeParse({ output: "x" }).success).toBe(
      false,
    );
  });

  it("workflows.run / workflows.schedule round-trip their ids", () => {
    roundTrip(clientToHostRequests["workflows.run"].result, { runId: "01JRUN" });
    roundTrip(clientToHostRequests["workflows.schedule"].params, {
      slug: "report",
      input: { team: "growth" },
      opts: { cron: "0 9 * * MON", timezone: "America/Anchorage" },
    });
    roundTrip(clientToHostRequests["workflows.schedule"].result, { scheduleId: "01JSCHED" });
  });

  it("sleep accepts all three wire arg forms (until is a string — Dates normalize client-side)", () => {
    roundTrip(sleepWireArgSchema, 1500);
    roundTrip(sleepWireArgSchema, { durationMs: 1500 });
    roundTrip(sleepWireArgSchema, { until: "2026-07-01T00:00:00Z" });
    expect(sleepWireArgSchema.safeParse({ until: 1750000000000 }).success).toBe(false);
  });

  it("humanInput results keep their per-kind fields (union is most-specific-first)", () => {
    roundTrip(humanInputResultSchema, { value: "Approve", isOther: false });
    roundTrip(humanInputResultSchema, { values: ["a", "b"], other: "c" });
    roundTrip(humanInputResultSchema, { value: "free text" });
    roundTrip(clientToHostRequests.humanInput.params, {
      opts: {
        prompt: "Approve?",
        input: { kind: "choice", options: ["Approve", "Reject"] },
        onTimeout: { value: { value: "Reject", isOther: false } },
      },
    });
  });

  it("artifacts.write bodies are utf8 or base64, exclusively", () => {
    roundTrip(artifactWireBodySchema, { encoding: "utf8", data: "hello" });
    roundTrip(artifactWireBodySchema, { encoding: "base64", data: "aGVsbG8=" });
    expect(artifactWireBodySchema.safeParse({ encoding: "hex", data: "00" }).success).toBe(false);
  });

  it("computer.openBrowser yields a sessionId; the browser sub-namespace is keyed by it", () => {
    roundTrip(clientToHostRequests["computer.openBrowser"].result, { sessionId: "sess_1" });
    roundTrip(clientToHostRequests["computer.browser.navigate"].params, {
      sessionId: "sess_1",
      url: "https://example.com",
    });
    roundTrip(clientToHostRequests["computer.browser.screenshot"].result, {
      ref: { id: "art_1", name: "shot.png", url: "https://cdn/shot.png" },
    });
    roundTrip(clientToHostRequests["computer.browser.console"].result, {
      entries: [{ level: "warn", text: "careful", timestamp: 1750000000000 }],
    });
  });

  it("shell results carry exitCode + stdout + stderr", () => {
    roundTrip(shellResultSchema, { exitCode: 0, stdout: "ok", stderr: "" });
    roundTrip(shellResultSchema, { exitCode: 3, stdout: "", stderr: "boom" });
  });

  it("auth methods round-trip tokens", () => {
    roundTrip(clientToHostRequests["auth.idToken"].params, { audience: "sts.amazonaws.com" });
    roundTrip(clientToHostRequests["auth.idToken"].result, { token: "jwt" });
    roundTrip(clientToHostRequests["auth.apiToken"].params, {});
    roundTrip(clientToHostRequests["auth.apiToken"].result, { token: "bearer" });
  });

  it("usage.get: every dimension always present as { spent, cap, remaining }, null = uncapped", () => {
    roundTrip(usageSnapshotSchema, {
      usd: { spent: 1.25, cap: 10, remaining: 8.75 },
      tokens: { spent: 52000, cap: null, remaining: null },
      compute_seconds: { spent: 42, cap: 3600, remaining: 3558 },
    });
    // A missing dimension is a protocol bug, not "uncapped".
    expect(
      usageSnapshotSchema.safeParse({
        usd: { spent: 0, cap: null, remaining: null },
        tokens: { spent: 0, cap: null, remaining: null },
      }).success,
    ).toBe(false);
  });
});

describe("the callback lane and notifications", () => {
  it("tool_invoke round-trips { call_id, tool, input } → { output }", () => {
    roundTrip(hostToClientRequests.tool_invoke.params, {
      call_id: "4",
      tool: "lookup",
      input: { id: "x" },
    });
    roundTrip(hostToClientRequests.tool_invoke.result, { output: { found: true } });
  });

  it("phase is a notification payload; cancel may carry an optional reason", () => {
    roundTrip(clientToHostNotifications.phase.params, { name: "plan", opts: { id: "p1" } });
    roundTrip(clientToHostNotifications.phase.params, { name: "plan" });
    roundTrip(hostToClientNotifications.cancel.params, {});
    roundTrip(hostToClientNotifications.cancel.params, { reason: "user requested" });
  });
});
