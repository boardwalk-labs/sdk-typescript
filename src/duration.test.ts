import { describe, expect, it } from "vitest";

import { parseDurationMs } from "./duration.js";

describe("parseDurationMs", () => {
  it("parses every unit", () => {
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("90s")).toBe(90_000);
    expect(parseDurationMs("15m")).toBe(900_000);
    expect(parseDurationMs("48h")).toBe(172_800_000);
    expect(parseDurationMs("7d")).toBe(604_800_000);
  });

  it("accepts decimals, whitespace, and uppercase units", () => {
    expect(parseDurationMs("1.5h")).toBe(5_400_000);
    expect(parseDurationMs(" 7 d ")).toBe(604_800_000);
    expect(parseDurationMs("30M")).toBe(1_800_000);
  });

  it("returns null for anything else", () => {
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("soon")).toBeNull();
    expect(parseDurationMs("15")).toBeNull();
    expect(parseDurationMs("m15")).toBeNull();
    expect(parseDurationMs("15 minutes")).toBeNull();
    expect(parseDurationMs("-5m")).toBeNull();
    expect(parseDurationMs("1h30m")).toBeNull();
  });
});
