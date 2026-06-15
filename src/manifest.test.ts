// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { MetaValidationError, validateMeta, workflowManifestSchema } from "./manifest.js";

const MINIMAL = { slug: "hello", triggers: [{ kind: "manual" }] };

describe("workflowManifestSchema — core", () => {
  it("accepts a minimal manifest and applies defaults", () => {
    const m = validateMeta(MINIMAL);
    expect(m.slug).toBe("hello");
    expect(m.title).toBeUndefined();
    expect(m.triggers).toEqual([{ kind: "manual" }]);
    expect(m.concurrency).toEqual({ mode: "unlimited" });
    expect(m.runs_on).toBe("boardwalk/linux");
    expect(m.callable_by).toBe("anyone_in_org");
  });

  it("round-trips a full manifest (slug + title) without stripping fields", () => {
    const full = {
      slug: "morning-digest",
      title: "Morning Digest",
      description: "Summarize my open issues",
      triggers: [
        { kind: "cron", expr: "0 9 * * 1-5", timezone: "America/Anchorage" },
        { kind: "webhook", auth: "token" },
      ],
      permissions: { secrets: [{ name: "GITHUB_TOKEN" }] },
      env: { LOG_LEVEL: "info", GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      workspace: { persist: ["memory/triager", "cache"] },
      budget: { max_usd: 2.5, max_duration_seconds: 600 },
      concurrency: { mode: "serial" },
    };
    // toEqual on the WHOLE object — the union-stripping failure mode this repo guards against drops
    // fields silently, so assert every input field survives AND the schema defaults land exactly.
    expect(workflowManifestSchema.parse(full)).toEqual({
      ...full,
      runs_on: "boardwalk/linux",
      callable_by: "anyone_in_org",
    });
  });

  it("rejects unknown fields (no silent drift)", () => {
    expect(() => validateMeta({ ...MINIMAL, scripts: ["x"] })).toThrow(MetaValidationError);
    expect(() => validateMeta({ ...MINIMAL, memory: true })).toThrow(MetaValidationError);
    expect(() => validateMeta({ ...MINIMAL, instructions: "hi" })).toThrow(MetaValidationError);
    // Dropped 2026-06-11: capabilities (tools/mcp/skills) are per-agent (AgentOptions),
    // never manifest fields.
    expect(() => validateMeta({ ...MINIMAL, tools: [{ name: "web_search" }] })).toThrow(
      MetaValidationError,
    );
    expect(() => validateMeta({ ...MINIMAL, skills: ["triage-style"] })).toThrow(
      MetaValidationError,
    );
    expect(() =>
      validateMeta({
        ...MINIMAL,
        mcp: [{ name: "m", transport: "http", url: "https://mcp.example.com" }],
      }),
    ).toThrow(MetaValidationError);
    // Secrets moved into `permissions.secrets` — a top-level `secrets` is now an unknown field.
    expect(() => validateMeta({ ...MINIMAL, secrets: [{ name: "GH" }] })).toThrow(
      MetaValidationError,
    );
    // `permissions.tools` was removed — tools are per-agent only.
    expect(() =>
      validateMeta({ ...MINIMAL, permissions: { tools: [{ name: "web_search" }] } }),
    ).toThrow(MetaValidationError);
  });

  it("rejects bad slugs and missing triggers", () => {
    expect(() => validateMeta({ slug: "has space", triggers: [{ kind: "manual" }] })).toThrow();
    expect(() => validateMeta({ slug: "x", triggers: [] })).toThrow(/triggers/);
  });

  it("rejects a top-level `name` (renamed to `slug`) and a multi-line title", () => {
    expect(() => validateMeta({ ...MINIMAL, name: "morning-digest" })).toThrow(MetaValidationError);
    expect(() => validateMeta({ ...MINIMAL, title: "line one\nline two" })).toThrow(
      MetaValidationError,
    );
  });

  it("collects every issue with its path in the error message", () => {
    try {
      validateMeta({ slug: "", triggers: [{ kind: "cron", expr: "bad" }] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MetaValidationError);
      // Narrow via instanceof instead of an `as Error` cast (owner directive: no casts in tests).
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("slug");
      expect(message).toContain("triggers");
    }
  });
});

describe("triggers", () => {
  it("accepts 5- and 6-field cron expressions, rejects others", () => {
    const cron = (expr: string) => validateMeta({ ...MINIMAL, triggers: [{ kind: "cron", expr }] });
    expect(cron("0 9 * * 1-5").triggers[0]).toEqual({ kind: "cron", expr: "0 9 * * 1-5" });
    expect(cron("0 0 9 * * 1").triggers).toHaveLength(1);
    expect(() => cron("9 * *")).toThrow(/5 fields/);
  });

  it("rejects event triggers (not in v1)", () => {
    expect(() =>
      validateMeta({ ...MINIMAL, triggers: [{ kind: "event", event_name: "x" }] }),
    ).toThrow(MetaValidationError);
  });
});

describe("secrets and env", () => {
  it("a secret ref is exactly { name } — integration variants are rejected", () => {
    expect(() =>
      validateMeta({
        ...MINIMAL,
        permissions: { secrets: [{ name: "T", integration: "github" }] },
      }),
    ).toThrow(MetaValidationError);
    expect(() =>
      validateMeta({ ...MINIMAL, permissions: { secrets: [{ name: "T", from_role: "r" }] } }),
    ).toThrow(MetaValidationError);
  });

  it("the secret allowlist lives at permissions.secrets", () => {
    const m = validateMeta({ ...MINIMAL, permissions: { secrets: [{ name: "GITHUB_TOKEN" }] } });
    expect(m.permissions?.secrets).toEqual([{ name: "GITHUB_TOKEN" }]);
  });

  it("rejects reserved env prefixes", () => {
    expect(() => validateMeta({ ...MINIMAL, env: { BOARDWALK_X: "1" } })).toThrow(/reserved/);
    expect(() => validateMeta({ ...MINIMAL, env: { aws_region: "1" } })).toThrow(/reserved/);
  });

  it("allows whole-value secret references only", () => {
    expect(validateMeta({ ...MINIMAL, env: { T: "${{ secrets.GH }}" } }).env).toEqual({
      T: "${{ secrets.GH }}",
    });
    expect(() => validateMeta({ ...MINIMAL, env: { T: "prefix-${{ secrets.GH }}" } })).toThrow(
      /whole-value/,
    );
  });
});

describe("workspace.persist", () => {
  it("accepts true, false, and workspace-relative directory lists", () => {
    expect(validateMeta({ ...MINIMAL, workspace: { persist: true } }).workspace).toEqual({
      persist: true,
    });
    expect(
      validateMeta({ ...MINIMAL, workspace: { persist: ["memory/a", "cache"] } }).workspace,
    ).toEqual({ persist: ["memory/a", "cache"] });
  });

  it("rejects escaping or absolute paths", () => {
    for (const bad of ["../outside", "a/../b", "/abs", "a\\b", "a//b", "."]) {
      expect(() => validateMeta({ ...MINIMAL, workspace: { persist: [bad] } })).toThrow(
        MetaValidationError,
      );
    }
  });
});

describe("platform-extension fields", () => {
  it("validates egress, callable_by, notifications round-trip with toEqual", () => {
    const m = validateMeta({
      ...MINIMAL,
      egress: { level: "custom", allow: ["api.github.com"], include_defaults: true },
      callable_by: { roles: ["admin", "member"] },
      notifications: [
        { on: "failure", channel: "email", target: "ops@example.com" },
        { on: "budget_exceeded", channel: "email", target: "ops@example.com" },
      ],
    });
    expect(m.egress).toEqual({
      level: "custom",
      allow: ["api.github.com"],
      include_defaults: true,
    });
    expect(m.callable_by).toEqual({ roles: ["admin", "member"] });
    expect(m.notifications).toEqual([
      { on: "failure", channel: "email", target: "ops@example.com" },
      { on: "budget_exceeded", channel: "email", target: "ops@example.com" },
    ]);
  });

  it("rejects a template on budget_exceeded notifications", () => {
    expect(() =>
      validateMeta({
        ...MINIMAL,
        notifications: [
          { on: "budget_exceeded", channel: "email", target: "x@y.z", template: "t" },
        ],
      }),
    ).toThrow(MetaValidationError);
  });
});
