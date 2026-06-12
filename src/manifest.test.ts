import { describe, expect, it } from "vitest";
import { MetaValidationError, validateMeta, workflowManifestSchema } from "./manifest.js";

const MINIMAL = { name: "hello", triggers: [{ kind: "manual" }] };

describe("workflowManifestSchema — core", () => {
  it("accepts a minimal manifest and applies defaults", () => {
    const m = validateMeta(MINIMAL);
    expect(m.name).toBe("hello");
    expect(m.triggers).toEqual([{ kind: "manual" }]);
    expect(m.concurrency).toEqual({ mode: "unlimited" });
    expect(m.runs_on).toBe("boardwalk/linux");
    expect(m.callable_by).toBe("anyone_in_org");
  });

  it("round-trips a full manifest without stripping fields", () => {
    const full = {
      name: "morning-digest",
      description: "Summarize my open issues",
      triggers: [
        { kind: "cron", expr: "0 9 * * 1-5", timezone: "America/Anchorage" },
        { kind: "webhook", auth: "token" },
      ],
      secrets: [{ name: "GITHUB_TOKEN" }],
      env: { LOG_LEVEL: "info", GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      workspace: { persist: ["memory/triager", "cache"] },
      budget: { max_usd: 2.5, max_duration_seconds: 600 },
      concurrency: { mode: "serial" },
    };
    const m = workflowManifestSchema.parse(full);
    expect(m.secrets).toEqual([{ name: "GITHUB_TOKEN" }]);
    expect(m.workspace).toEqual({ persist: ["memory/triager", "cache"] });
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
  });

  it("rejects bad names and missing triggers", () => {
    expect(() => validateMeta({ name: "has space", triggers: [{ kind: "manual" }] })).toThrow();
    expect(() => validateMeta({ name: "x", triggers: [] })).toThrow(/triggers/);
  });

  it("collects every issue with its path in the error message", () => {
    try {
      validateMeta({ name: "", triggers: [{ kind: "cron", expr: "bad" }] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MetaValidationError);
      expect((e as Error).message).toContain("name");
      expect((e as Error).message).toContain("triggers");
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
      validateMeta({ ...MINIMAL, secrets: [{ name: "T", integration: "github" }] }),
    ).toThrow(MetaValidationError);
    expect(() => validateMeta({ ...MINIMAL, secrets: [{ name: "T", from_role: "r" }] })).toThrow(
      MetaValidationError,
    );
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

describe("cloud-extension fields", () => {
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
    expect(m.notifications).toHaveLength(2);
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
