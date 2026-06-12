import { describe, expect, it } from "vitest";
import { extractManifest, extractMetaLiteral, MetaExtractionError } from "./extract.js";

describe("extractMetaLiteral", () => {
  it("extracts a plain literal exactly as written (no defaults)", () => {
    const src = `
      export const meta = {
        name: "hello",
        triggers: [{ kind: "manual" }],
        budget: { max_usd: 2.5 },
      };
      export default async function run() {}
    `;
    expect(extractMetaLiteral(src)).toEqual({
      name: "hello",
      triggers: [{ kind: "manual" }],
      budget: { max_usd: 2.5 },
    });
  });

  it("unwraps `satisfies`, `as const`, and parentheses", () => {
    const src = `
      import type { WorkflowMeta } from "@boardwalk/workflow";
      export const meta = ({
        name: "x",
        triggers: [{ kind: "manual" }] as const,
      }) satisfies WorkflowMeta;
    `;
    expect(extractMetaLiteral(src)).toEqual({ name: "x", triggers: [{ kind: "manual" }] });
  });

  it("handles template strings, negative numbers, numeric separators, booleans, null", () => {
    const src =
      "export const meta = { name: `x`, n: -3, big: 1_000, on: true, off: false, nil: null };";
    expect(extractMetaLiteral(src, { fileName: "index.js" })).toEqual({
      name: "x",
      n: -3,
      big: 1000,
      on: true,
      off: false,
      nil: null,
    });
  });

  it("rejects variables, calls, spreads, shorthand, computed keys — with file:line:col", () => {
    const cases: [string, RegExp][] = [
      ['const m = {}; export const meta = { name: "x", extra: m };', /pure literals/],
      ['export const meta = defineMeta({ name: "x" });', /defineMeta/],
      ["const a = {}; export const meta = { ...a };", /spread/],
      ['const name = "x"; export const meta = { name };', /shorthand/],
      ['export const meta = { ["na" + "me"]: "x" };', /computed keys|pure literals/],
      ["export const meta = { name: `x${1}` };", /pure literals/],
      ["export const meta = { tags: [1, , 3] };", /array holes/],
    ];
    for (const [src, re] of cases) {
      expect(() => extractMetaLiteral(src)).toThrow(MetaExtractionError);
      expect(() => extractMetaLiteral(src)).toThrow(re);
      expect(() => extractMetaLiteral(src)).toThrow(/index\.ts:\d+:\d+/);
    }
  });

  it("rejects a program with no meta", () => {
    expect(() => extractMetaLiteral("export default async function run() {}")).toThrow(
      /No `meta` declaration/,
    );
  });
});

describe("extractManifest", () => {
  it("extracts and validates in one step, applying schema defaults", () => {
    const src = `export const meta = { name: "hello", triggers: [{ kind: "manual" }] };`;
    const manifest = extractManifest(src);
    expect(manifest.name).toBe("hello");
    expect(manifest.runs_on).toBe("boardwalk/linux");
    expect(manifest.concurrency).toEqual({ mode: "unlimited" });
  });

  it("surfaces schema violations from a valid literal", () => {
    const src = `export const meta = { name: "hello", triggers: [] };`;
    expect(() => extractManifest(src)).toThrow(/triggers/);
  });
});
