// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  channelOf,
  CHANNELS,
  DEFAULT_CHANNELS,
  makeCursor,
  matchesChannels,
  runEventSchema,
  TURN_CURSOR_STRIDE,
  type RunEvent,
} from "./events.js";

const ENVELOPE = { runId: "run_1", turnId: "turn_1", seq: 1, t: 1_770_000_000_000 };

describe("cursor", () => {
  it("derives a run-global monotonic cursor from (turn, seq)", () => {
    expect(makeCursor(0, 1)).toBe(1);
    expect(makeCursor(0, 999_999)).toBe(999_999);
    expect(makeCursor(1, 1)).toBe(TURN_CURSOR_STRIDE + 1);
    expect(makeCursor(2, 5)).toBeGreaterThan(makeCursor(1, 999_999));
  });

  it("rejects out-of-range inputs (seq is 1-based)", () => {
    expect(() => makeCursor(0, 0)).toThrow(RangeError);
    expect(() => makeCursor(-1, 1)).toThrow(RangeError);
    expect(() => makeCursor(0, TURN_CURSOR_STRIDE)).toThrow(RangeError);
    expect(() => makeCursor(0.5, 1)).toThrow(RangeError);
  });
});

describe("schema round-trips", () => {
  const samples: RunEvent[] = [
    { ...ENVELOPE, kind: "run_status", status: "running" },
    {
      ...ENVELOPE,
      kind: "run_status",
      status: "failed",
      error: { code: "BUDGET_EXCEEDED", message: "max_usd reached" },
    },
    {
      ...ENVELOPE,
      kind: "run_status",
      status: "failed",
      error: {
        code: "VALIDATION",
        message: 'agent() got a string ("bash") in `tools`.',
        hint: 'Built-in tools are on by default — write `builtins: ["bash"]`.',
      },
    },
    { ...ENVELOPE, kind: "phase", name: "plan", id: "p1" },
    { ...ENVELOPE, kind: "output", value: { answer: 42 } },
    { ...ENVELOPE, kind: "program_output", stream: "stdout", text: "hello\n" },
    {
      ...ENVELOPE,
      kind: "egress_denied",
      host: "api.example.com",
      method: "CONNECT",
      reason: "not in this run's egress allowlist",
    },
    { ...ENVELOPE, kind: "turn_started", agentId: "agt_1" },
    { ...ENVELOPE, kind: "turn_started", agentId: "agt_2", agentName: "reviewer" },
    {
      ...ENVELOPE,
      kind: "turn_ended",
      agentId: "agt_1",
      reason: "complete",
      usage: { inputTokens: 100, outputTokens: 20 },
    },
    {
      ...ENVELOPE,
      kind: "turn_ended",
      agentId: "agt_2",
      agentName: "reviewer",
      reason: "complete",
      usage: { inputTokens: 100, outputTokens: 20 },
    },
    { ...ENVELOPE, kind: "text_start", blockId: "b1" },
    { ...ENVELOPE, kind: "text_delta", blockId: "b1", text: "chunk" },
    { ...ENVELOPE, kind: "text_end", blockId: "b1" },
    { ...ENVELOPE, kind: "tool_call_start", toolCallId: "tc1", toolName: "web_search" },
    { ...ENVELOPE, kind: "tool_call_input_delta", toolCallId: "tc1", partialJson: '{"q":"bo' },
    {
      ...ENVELOPE,
      kind: "tool_call_input_complete",
      toolCallId: "tc1",
      input: { q: "boardwalk" },
    },
    { ...ENVELOPE, kind: "tool_call_executing", toolCallId: "tc1" },
    {
      ...ENVELOPE,
      kind: "tool_output_delta",
      toolCallId: "tc1",
      stream: "stdout",
      text: "PASS src/foo.test.ts\n",
    },
    {
      ...ENVELOPE,
      kind: "tool_call_result",
      toolCallId: "tc1",
      result: { kind: "search", humanSummary: "3 hits", data: { hits: 3 } },
    },
    {
      ...ENVELOPE,
      kind: "tool_call_error",
      toolCallId: "tc1",
      error: { code: "TOOL_FAILED", message: "boom" },
    },
    { ...ENVELOPE, kind: "reasoning_delta", text: "thinking…" },
    { ...ENVELOPE, kind: "suspended", reason: "human_input" },
    { ...ENVELOPE, kind: "suspended", reason: "sleep", wakeAt: 1_770_000_100_000 },
    { ...ENVELOPE, kind: "resumed" },
    {
      ...ENVELOPE,
      kind: "human_input_requested",
      requestId: "hir_1",
      key: "approve-send",
      prompt: "Approve sending this email?",
    },
    { ...ENVELOPE, kind: "human_input_resolved", requestId: "hir_1", key: "approve-send" },
    {
      ...ENVELOPE,
      kind: "compaction_started",
      agentId: "a1",
      tokens: 940_000,
      budget: 936_000,
      contextTokens: 1_000_000,
    },
    {
      ...ENVELOPE,
      kind: "compaction_ended",
      agentId: "a1",
      tokens: 536_000,
      reclaimed: 404_000,
      method: "summarized",
    },
  ];

  it.each(samples.map((s) => [s.kind, s] as const))("round-trips %s with toEqual", (_kind, ev) => {
    expect(runEventSchema.parse(ev)).toEqual(ev);
  });

  it("has a round-trip sample for every event kind (no kind left untested)", () => {
    const schemaKinds = new Set(runEventSchema.options.map((o) => o.shape.kind.value));
    const sampleKinds = new Set(samples.map((s) => s.kind));
    expect(sampleKinds).toEqual(schemaKinds);
  });

  it("rejects unknown kinds and extra fields", () => {
    expect(() => runEventSchema.parse({ ...ENVELOPE, kind: "nope" })).toThrow();
    expect(() =>
      runEventSchema.parse({ ...ENVELOPE, kind: "turn_started", agentId: "a", extra: 1 }),
    ).toThrow();
    // agentId is required on turn_started/turn_ended.
    expect(() => runEventSchema.parse({ ...ENVELOPE, kind: "turn_started" })).toThrow();
  });
});

describe("compaction events", () => {
  const IDENT = { agentId: "a1" };

  it("round-trips a started frame with the window that sized the budget", () => {
    const ev = {
      ...ENVELOPE,
      kind: "compaction_started",
      ...IDENT,
      tokens: 940_000,
      budget: 936_000,
      contextTokens: 1_000_000,
    };
    expect(runEventSchema.parse(ev)).toEqual(ev);
  });

  it("allows an absent window — the leaf may not have learned one (BYO, dev, turn 1)", () => {
    const ev = {
      ...ENVELOPE,
      kind: "compaction_started",
      ...IDENT,
      tokens: 160_000,
      budget: 150_000,
    };
    expect(runEventSchema.parse(ev)).toEqual(ev);
  });

  it("round-trips each ended method, including the ones that reclaim nothing", () => {
    for (const [method, reclaimed] of [
      ["summarized", 400_000],
      ["deduped", 90_000],
      ["none", 0], // bailed: nothing compressible, or the digest wasn't smaller
    ] as const) {
      const ev = {
        ...ENVELOPE,
        kind: "compaction_ended",
        ...IDENT,
        tokens: 536_000,
        reclaimed,
        method,
      };
      expect(runEventSchema.parse(ev)).toEqual(ev);
    }
  });

  it("rejects an unknown method rather than passing it to a viewer", () => {
    expect(() =>
      runEventSchema.parse({
        ...ENVELOPE,
        kind: "compaction_ended",
        ...IDENT,
        tokens: 1,
        reclaimed: 0,
        method: "truncated",
      }),
    ).toThrow();
  });

  it("requires the agent identity — concurrent leaves compact independently", () => {
    expect(() =>
      runEventSchema.parse({ ...ENVELOPE, kind: "compaction_started", tokens: 1, budget: 1 }),
    ).toThrow();
  });

  it("puts both frames on the agent channel, beside the turn frames they sit between", () => {
    expect(channelOf({ kind: "compaction_started" })).toBe("agent");
    expect(channelOf({ kind: "compaction_ended" })).toBe("agent");
  });
});

describe("channels", () => {
  it("maps every event kind to exactly one channel", () => {
    const kinds = runEventSchema.options.map((o) => o.shape.kind.value);
    for (const kind of kinds) {
      expect(CHANNELS).toContain(channelOf({ kind }));
    }
  });

  it("classifies the load-bearing kinds correctly", () => {
    expect(channelOf({ kind: "run_status" })).toBe("lifecycle");
    expect(channelOf({ kind: "phase" })).toBe("phase");
    expect(channelOf({ kind: "output" })).toBe("output");
    expect(channelOf({ kind: "program_output" })).toBe("log");
    expect(channelOf({ kind: "text_delta" })).toBe("agent");
    expect(channelOf({ kind: "tool_call_result" })).toBe("agent");
  });

  it("matchesChannels implements the subscription filter; defaults are quiet", () => {
    const statusEv = { kind: "run_status" } as const;
    const agentEv = { kind: "text_delta" } as const;
    expect(matchesChannels(statusEv, DEFAULT_CHANNELS)).toBe(true);
    expect(matchesChannels(agentEv, DEFAULT_CHANNELS)).toBe(false);
    expect(matchesChannels(agentEv, [...CHANNELS])).toBe(true);
    expect(matchesChannels(statusEv, ["output"])).toBe(false);
  });
});

// The wire contract is STRICT: an unknown key fails the whole event, so a `safeParse` consumer drops
// it entirely rather than ignoring the field. That is not hypothetical — the control plane shipped
// `error.hint` before this schema knew the key, and the CLI silently stopped printing the terminal
// `workflow failed` line for every hinted failure. These tests pin both halves of that lesson.
describe("event error — `hint` is part of the wire contract", () => {
  const failed = (error: Record<string, unknown>): unknown => ({
    kind: "run_status",
    status: "failed",
    error,
    runId: "r",
    turnId: "r",
    seq: 1,
    t: 1,
  });

  it("accepts an error carrying a hint, and KEEPS the hint (a strip would lose the fix)", () => {
    const parsed = runEventSchema.safeParse(
      failed({ code: "VALIDATION", message: "bad tools", hint: 'write `builtins: ["bash"]`' }),
    );
    expect(parsed.success).toBe(true);
    const ev = parsed.success ? parsed.data : null;
    expect(ev?.kind === "run_status" ? ev.error?.hint : undefined).toBe(
      'write `builtins: ["bash"]`',
    );
  });

  it("still accepts an error with no hint (most failures have none)", () => {
    expect(runEventSchema.safeParse(failed({ code: "E", message: "m" })).success).toBe(true);
  });

  it("still REJECTS a genuinely unknown key — strictness is deliberate", () => {
    // The point of strictObject: a producer typo can't slip onto the wire unnoticed. The cost is
    // that a new field must be published HERE before any producer emits it.
    expect(
      runEventSchema.safeParse(failed({ code: "E", message: "m", hnit: "typo" })).success,
    ).toBe(false);
  });
});
