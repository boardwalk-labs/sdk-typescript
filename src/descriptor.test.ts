// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  DescriptorValidationError,
  parseJsonc,
  parseWorkflowDescriptor,
  splitFallback,
  validateConcurrencyKeyTemplate,
} from "./descriptor.js";

// ============================================================================
// parseJsonc
// ============================================================================

describe("parseJsonc", () => {
  it("parses plain JSON unchanged", () => {
    expect(parseJsonc('{"a": 1, "b": [true, null, "x"]}')).toEqual({
      a: 1,
      b: [true, null, "x"],
    });
  });

  it("strips // line comments", () => {
    const text = `{
      // the slug
      "slug": "hello" // trailing note
    }`;
    expect(parseJsonc(text)).toEqual({ slug: "hello" });
  });

  it("strips /* */ block comments, including multi-line ones", () => {
    const text = `{
      /* a block
         spanning lines */
      "a": /* inline */ 1
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1 });
  });

  it("leaves comment-looking sequences inside strings untouched", () => {
    expect(
      parseJsonc('{"url": "https://example.com/path", "note": "a /* not a comment */"}'),
    ).toEqual({ url: "https://example.com/path", note: "a /* not a comment */" });
  });

  it("handles escaped quotes inside strings", () => {
    expect(parseJsonc('{"a": "quote \\" then // not a comment"}')).toEqual({
      a: 'quote " then // not a comment',
    });
    // A string ending in an escaped backslash must not swallow the closing quote.
    expect(parseJsonc('{"a": "b\\\\"} // comment')).toEqual({ a: "b\\" });
  });

  it("strips trailing commas in objects and arrays (nested too)", () => {
    expect(parseJsonc('{"a": [1, 2, 3,], "b": {"c": 1,},}')).toEqual({
      a: [1, 2, 3],
      b: { c: 1 },
    });
  });

  it("keeps a comma inside a string when a bracket follows", () => {
    expect(parseJsonc('["a,", "b"]')).toEqual(["a,", "b"]);
    expect(parseJsonc('{"a": ",}"}')).toEqual({ a: ",}" });
  });

  it("strips a trailing comma separated from the bracket by comments and CRLF", () => {
    const text = '{\r\n  "a": 1, // note\r\n  "b": 2, /* last */\r\n}';
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });
  });

  it("handles CRLF line endings for line comments", () => {
    expect(parseJsonc('{\r\n// comment\r\n"a": 1\r\n}')).toEqual({ a: 1 });
  });

  it("throws on an unterminated block comment", () => {
    expect(() => parseJsonc('{"a": 1} /* never closed')).toThrow(/[Uu]nterminated block comment/);
  });

  it("throws SyntaxError on malformed JSON after stripping", () => {
    expect(() => parseJsonc('{"a": }')).toThrow(SyntaxError);
  });
});

// ============================================================================
// parseWorkflowDescriptor
// ============================================================================

const MINIMAL_TEXT = `{
  // Comments are author-facing only — stripped on parse, never stored.
  "slug": "hello",
  "triggers": [{ "kind": "manual" },],
}`;

describe("parseWorkflowDescriptor", () => {
  it("parses a commented, trailing-comma descriptor and applies schema defaults", () => {
    const d = parseWorkflowDescriptor(MINIMAL_TEXT);
    expect(d).toEqual({
      slug: "hello",
      triggers: [{ kind: "manual" }],
      concurrency: { mode: "unlimited" },
      runs_on: "boardwalk/linux",
      callable_by: "anyone_in_org",
    });
  });

  it("accepts the full descriptor surface (entry, files, budget, serial key)", () => {
    const d = parseWorkflowDescriptor(`{
      "slug": "refund-handler",
      "entry": "src/refunds.ts",
      "triggers": [{ "kind": "webhook", "name": "refunds" }],
      "budget": { "max_usd": 5, "max_compute_seconds": 1200 },
      "concurrency": { "mode": "serial", "key": "refund-\${input.customerId}" },
      "files": ["prompts/**"],
    }`);
    expect(d.entry).toBe("src/refunds.ts");
    expect(d.files).toEqual(["prompts/**"]);
    expect(d.budget).toEqual({ max_usd: 5, max_compute_seconds: 1200 });
    expect(d.concurrency).toEqual({ mode: "serial", key: "refund-${input.customerId}" });
  });

  it("accepts the latest_wins lane mode and validates ITS key template too", () => {
    const d = parseWorkflowDescriptor(`{
      "slug": "ci-watcher",
      "triggers": [{ "kind": "webhook", "name": "github" }],
      "concurrency": { "mode": "latest_wins", "key": "\${input.repository.full_name ?? 'none'}" },
    }`);
    expect(d.concurrency).toEqual({
      mode: "latest_wins",
      key: "${input.repository.full_name ?? 'none'}",
    });
    // A bad template under latest_wins is caught exactly as under serial — the check used to be
    // gated on mode === "serial", so a third mode would have skipped it silently.
    expect(() =>
      parseWorkflowDescriptor(`{
        "slug": "ci-watcher",
        "triggers": [{ "kind": "manual" }],
        "concurrency": { "mode": "latest_wins", "key": "\${repo}" },
      }`),
    ).toThrow(/concurrency.key template is invalid/);
  });

  it("rejects a hand-written input_schema with a build-derived message", () => {
    const text = '{"slug": "x", "triggers": [{"kind": "manual"}], "input_schema": {}}';
    expect(() => parseWorkflowDescriptor(text)).toThrow(DescriptorValidationError);
    expect(() => parseWorkflowDescriptor(text)).toThrow(/input_schema.*build-derived/s);
  });

  it("rejects a hand-written output_schema with a build-derived message", () => {
    const text = '{"slug": "x", "triggers": [{"kind": "manual"}], "output_schema": {}}';
    expect(() => parseWorkflowDescriptor(text)).toThrow(/output_schema.*build-derived/s);
  });

  it("rejects malformed JSONC with a syntax message", () => {
    expect(() => parseWorkflowDescriptor('{"slug": }')).toThrow(DescriptorValidationError);
    expect(() => parseWorkflowDescriptor('{"slug": }')).toThrow(/not valid JSONC/);
  });

  it("rejects a non-object root", () => {
    expect(() => parseWorkflowDescriptor('["not", "a", "descriptor"]')).toThrow(
      /single JSON object/,
    );
    expect(() => parseWorkflowDescriptor('"just a string"')).toThrow(/single JSON object/);
  });

  it("collects every schema issue with its path in the error message", () => {
    try {
      parseWorkflowDescriptor('{"slug": "", "triggers": [{"kind": "cron", "expr": "bad"}]}');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DescriptorValidationError);
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("slug");
      expect(message).toContain("triggers");
    }
  });

  it("rejects unknown fields (the deleted deadline_seconds included)", () => {
    expect(() =>
      parseWorkflowDescriptor(
        '{"slug": "x", "triggers": [{"kind": "manual"}], "budget": {"deadline_seconds": 60}}',
      ),
    ).toThrow(/deadline_seconds/);
  });

  it("rejects a serial concurrency key with bad template syntax", () => {
    const text =
      '{"slug": "x", "triggers": [{"kind": "manual"}], ' +
      '"concurrency": {"mode": "serial", "key": "${customerId}"}}';
    expect(() => parseWorkflowDescriptor(text)).toThrow(DescriptorValidationError);
    expect(() => parseWorkflowDescriptor(text)).toThrow(/rooted at `input`/);
  });

  it("accepts a serial concurrency key with valid template syntax", () => {
    const d = parseWorkflowDescriptor(
      '{"slug": "x", "triggers": [{"kind": "manual"}], ' +
        '"concurrency": {"mode": "serial", "key": "${input.items[0].sku}"}}',
    );
    expect(d.concurrency).toEqual({ mode: "serial", key: "${input.items[0].sku}" });
  });

  it("accepts a workspace key, which scopes persistent state", () => {
    const d = parseWorkflowDescriptor(
      '{"slug": "x", "triggers": [{"kind": "manual"}], ' +
        '"workspace": {"persist": ["index"], "key": "${input.repo}"}}',
    );
    expect(d.workspace).toEqual({ persist: ["index"], key: "${input.repo}" });
  });

  it("rejects a workspace key with bad template syntax, naming the field", () => {
    // An author with both keys set has to know WHICH one is wrong.
    const text = '{"slug": "x", "triggers": [{"kind": "manual"}], "workspace": {"key": "${repo}"}}';
    expect(() => parseWorkflowDescriptor(text)).toThrow(DescriptorValidationError);
    expect(() => parseWorkflowDescriptor(text)).toThrow(/workspace\.key/);
  });

  it("lets the two keys differ — they are independent axes", () => {
    // Serialized per customer for an external rate limit, scoped per repo for state. Requiring them to
    // match would collapse a scheduling knob and a scoping knob into one.
    const d = parseWorkflowDescriptor(
      '{"slug": "x", "triggers": [{"kind": "manual"}], ' +
        '"workspace": {"key": "${input.repo}"}, ' +
        '"concurrency": {"mode": "serial", "key": "${input.customer}"}}',
    );
    expect(d.workspace?.key).toBe("${input.repo}");
    expect(d.concurrency).toEqual({ mode: "serial", key: "${input.customer}" });
  });

  it("accepts a workspace key with no persist declaration (memory-only workflows)", () => {
    // `agent({ memory })` declares nothing, so a workflow can legitimately want a scope key without
    // ever naming a persist path.
    const d = parseWorkflowDescriptor(
      '{"slug": "x", "triggers": [{"kind": "manual"}], "workspace": {"key": "${input.tenant}"}}',
    );
    expect(d.workspace).toEqual({ key: "${input.tenant}" });
  });
});

// ============================================================================
// validateConcurrencyKeyTemplate
// ============================================================================

describe("validateConcurrencyKeyTemplate", () => {
  it("accepts valid templates", () => {
    for (const valid of [
      "refund-${input.customerId}",
      "${input.account.id}",
      "${input.items[0].sku}",
      "${input.a.b.c}",
      "${input[0]}",
      "${input.list[12].deep[0].field}",
      "${input._private.$dollar}",
      "a-${input.x}-b-${input.y}",
      "${ input.customerId }", // surrounding whitespace is tolerated
      "constant-key", // no interpolation at all is syntactically fine
      "price-in-$USD", // a bare `$` without `{` is literal text
    ]) {
      expect(validateConcurrencyKeyTemplate(valid)).toEqual([]);
    }
  });

  it("rejects a path not rooted at input", () => {
    const issues = validateConcurrencyKeyTemplate("${customerId}");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/rooted at `input`/);
    expect(issues[0]?.index).toBe(0);
    // `inputs` (a different identifier) is not the `input` root.
    expect(validateConcurrencyKeyTemplate("${inputs.a}")[0]?.message).toMatch(/rooted at `input`/);
  });

  it("rejects the bare whole-input reference", () => {
    expect(validateConcurrencyKeyTemplate("${input}")[0]?.message).toMatch(/whole input/);
    expect(validateConcurrencyKeyTemplate("${ input }")[0]?.message).toMatch(/whole input/);
  });

  it("rejects function calls", () => {
    expect(validateConcurrencyKeyTemplate("${input.f(x)}")[0]?.message).toMatch(/function calls/);
  });

  it("rejects operators", () => {
    for (const bad of ["${input.a+1}", "${input.a || input.b}", "${input.a ? 1 : 2}"]) {
      expect(validateConcurrencyKeyTemplate(bad)[0]?.message).toMatch(/operators/);
    }
  });

  it("rejects an unclosed interpolation and reports its index", () => {
    const issues = validateConcurrencyKeyTemplate("refund-${input.customerId");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/unclosed/);
    expect(issues[0]?.index).toBe(7);
  });

  it("rejects an empty path", () => {
    expect(validateConcurrencyKeyTemplate("${}")[0]?.message).toMatch(/empty interpolation/);
    expect(validateConcurrencyKeyTemplate("${  }")[0]?.message).toMatch(/empty interpolation/);
  });

  it("rejects malformed accessors", () => {
    expect(validateConcurrencyKeyTemplate("${input..a}")[0]?.message).toMatch(/empty field/);
    expect(validateConcurrencyKeyTemplate("${input.}")[0]?.message).toMatch(/empty field/);
    expect(validateConcurrencyKeyTemplate("${input.items[a]}")[0]?.message).toMatch(
      /not a valid index/,
    );
    expect(validateConcurrencyKeyTemplate("${input.items[-1]}")[0]?.message).toMatch(
      /not a valid index/,
    );
    expect(validateConcurrencyKeyTemplate("${input.items[01]}")[0]?.message).toMatch(
      /not a valid index/,
    );
    expect(validateConcurrencyKeyTemplate("${input.items[0}")[0]?.message).toMatch(/unclosed `\[`/);
    expect(validateConcurrencyKeyTemplate("${input.1field}")[0]?.message).toMatch(
      /not a valid field name/,
    );
  });

  it("collects one issue per bad interpolation", () => {
    const issues = validateConcurrencyKeyTemplate("${foo}-${input.f(x)}-${input.ok}");
    expect(issues).toHaveLength(2);
    expect(issues[0]?.message).toMatch(/rooted at `input`/);
    expect(issues[1]?.message).toMatch(/function calls/);
  });

  it("accepts a `?? 'literal'` fallback in either quote style", () => {
    for (const valid of [
      "${input.repo.full_name ?? 'none'}", // single quotes: what an author writes inside JSON
      '${input.repo.full_name ?? "none"}',
      "${input.a??'x'}", // no whitespace at all
      "${ input.items[0].sku ?? 'unknown sku' }",
      "repo-${input.repo ?? 'none'}-${input.branch ?? 'main'}",
    ]) {
      expect(validateConcurrencyKeyTemplate(valid)).toEqual([]);
    }
  });

  it("rejects a fallback that is not a plain quoted literal", () => {
    expect(validateConcurrencyKeyTemplate("${input.a ?? none}")[0]?.message).toMatch(
      /quoted literal/,
    );
    // A second path as the fallback would need value resolution of two paths; one is the contract.
    expect(validateConcurrencyKeyTemplate("${input.a ?? input.b}")[0]?.message).toMatch(
      /quoted literal/,
    );
    expect(validateConcurrencyKeyTemplate("${input.a ?? 'no\\'pe'}")[0]?.message).toMatch(
      /quoted literal/,
    );
  });

  it("rejects an empty or missing fallback value", () => {
    expect(validateConcurrencyKeyTemplate("${input.a ??}")[0]?.message).toMatch(
      /needs a fallback value/,
    );
    expect(validateConcurrencyKeyTemplate("${input.a ?? ''}")[0]?.message).toMatch(
      /cannot be empty/,
    );
  });

  it("still validates the PATH side of a fallback interpolation", () => {
    const issues = validateConcurrencyKeyTemplate("${customerId ?? 'none'}");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/rooted at `input`/);
  });

  it("keeps a single `?` an operator error, not a fallback", () => {
    expect(validateConcurrencyKeyTemplate("${input.a ? 1 : 2}")[0]?.message).toMatch(/operators/);
  });
});

describe("splitFallback", () => {
  it("splits at the first `??` and trims both sides", () => {
    expect(splitFallback(' input.a ?? "x" ')).toEqual({ path: "input.a", fallback: '"x"' });
    expect(splitFallback("input.a")).toEqual({ path: "input.a", fallback: null });
    // First `??` wins, so a fallback containing `??` keeps it verbatim (and fails the literal check).
    expect(splitFallback('input.a ?? "x" ?? "y"').fallback).toBe('"x" ?? "y"');
  });
});

describe("$schema tolerance", () => {
  it("strips the editor-validation $schema key instead of rejecting it", () => {
    const d = parseWorkflowDescriptor(`{
      "$schema": "https://boardwalk.sh/schemas/workflow.json",
      "slug": "with-schema-key",
      "triggers": [{ "kind": "manual" }],
    }`);
    expect(d.slug).toBe("with-schema-key");
    expect("$schema" in d).toBe(false);
  });
});
