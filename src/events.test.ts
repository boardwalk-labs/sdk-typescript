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
    { ...ENVELOPE, kind: "phase", name: "plan", id: "p1" },
    { ...ENVELOPE, kind: "output", value: { answer: 42 } },
    { ...ENVELOPE, kind: "program_output", stream: "stdout", text: "hello\n" },
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
