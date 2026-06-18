// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { normalizeReasoning } from "./reasoning.js";

describe("normalizeReasoning", () => {
  it("expands a bare effort string to { effort }", () => {
    expect(normalizeReasoning("high")).toEqual({ effort: "high" });
    expect(normalizeReasoning("xhigh")).toEqual({ effort: "xhigh" });
    expect(normalizeReasoning("none")).toEqual({ effort: "none" });
  });

  it("keeps an effort given as an object", () => {
    expect(normalizeReasoning({ effort: "medium" })).toEqual({ effort: "medium" });
  });

  it("keeps a bare maxTokens budget", () => {
    expect(normalizeReasoning({ maxTokens: 4096 })).toEqual({ maxTokens: 4096 });
  });

  it("prefers effort over maxTokens when both are set (they are mutually exclusive)", () => {
    expect(normalizeReasoning({ effort: "low", maxTokens: 4096 })).toEqual({ effort: "low" });
  });

  it("carries exclude:true alongside an effort", () => {
    expect(normalizeReasoning({ effort: "high", exclude: true })).toEqual({
      effort: "high",
      exclude: true,
    });
  });

  it("preserves exclude:true on its own (default reasoning, hidden trace)", () => {
    expect(normalizeReasoning({ exclude: true })).toEqual({ exclude: true });
  });

  it("drops exclude:false as a no-op", () => {
    expect(normalizeReasoning({ effort: "high", exclude: false })).toEqual({ effort: "high" });
  });

  it("collapses empty / no-op inputs to undefined", () => {
    expect(normalizeReasoning(undefined)).toBeUndefined();
    expect(normalizeReasoning({})).toBeUndefined();
    expect(normalizeReasoning({ exclude: false })).toBeUndefined();
  });

  it("does not validate the effort enum — a stray value passes through to fail at the provider", () => {
    // @ts-expect-error — runtime-only garbage a JS caller could pass; TS rejects it.
    expect(normalizeReasoning("ultra")).toEqual({ effort: "ultra" });
  });
});
