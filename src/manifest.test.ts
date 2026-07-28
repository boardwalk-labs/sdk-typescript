// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { workflowManifestSchema } from "./manifest.js";

const MINIMAL = { slug: "hello", triggers: [{ kind: "manual" }] };

/** Parse via the schema (throws ZodError). Descriptor-level message formatting is descriptor.test.ts. */
const parse = (value: unknown) => workflowManifestSchema.parse(value);

describe("workflowManifestSchema — core", () => {
  it("accepts a minimal manifest and applies defaults", () => {
    const m = parse(MINIMAL);
    expect(m.slug).toBe("hello");
    expect(m.title).toBeUndefined();
    expect(m.triggers).toEqual([{ kind: "manual" }]);
    expect(m.concurrency).toEqual({ mode: "unlimited" });
    expect(m.runs_on).toBe("boardwalk/linux");
    expect(m.callable_by).toBe("anyone_in_org");
  });

  it("round-trips a full manifest without stripping fields", () => {
    const full = {
      slug: "morning-digest",
      title: "Morning Digest",
      description: "Summarize my open issues",
      entry: "src/digest.ts",
      triggers: [
        { kind: "cron", expr: "0 9 * * 1-5", timezone: "America/Anchorage" },
        { kind: "webhook", name: "stripe-prod" },
      ],
      permissions: { secrets: [{ name: "GITHUB_TOKEN" }] },
      env: { LOG_LEVEL: "info", GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      workspace: { persist: ["memory/triager", "cache"] },
      budget: { max_usd: 2.5, max_compute_seconds: 600 },
      concurrency: { mode: "serial", key: "digest-${input.userId}" },
      files: ["prompts/**", "data/seed.json"],
    };
    // toEqual on the WHOLE object — the union-stripping failure mode this repo guards against drops
    // fields silently, so assert every input field survives AND the schema defaults land exactly.
    expect(parse(full)).toEqual({
      ...full,
      runs_on: "boardwalk/linux",
      callable_by: "anyone_in_org",
    });
  });

  it("rejects unknown fields (no silent drift)", () => {
    expect(() => parse({ ...MINIMAL, scripts: ["x"] })).toThrow(/scripts/);
    expect(() => parse({ ...MINIMAL, memory: true })).toThrow(/memory/);
    expect(() => parse({ ...MINIMAL, instructions: "hi" })).toThrow(/instructions/);
    // Dropped 2026-06-11: capabilities (tools/mcp/skills) are per-agent (AgentOptions),
    // never manifest fields.
    expect(() => parse({ ...MINIMAL, tools: [{ name: "web_search" }] })).toThrow(/tools/);
    expect(() => parse({ ...MINIMAL, skills: ["triage-style"] })).toThrow(/skills/);
    expect(() =>
      parse({
        ...MINIMAL,
        mcp: [{ name: "m", transport: "http", url: "https://mcp.example.com" }],
      }),
    ).toThrow(/mcp/);
    // Secrets moved into `permissions.secrets` — a top-level `secrets` is now an unknown field.
    expect(() => parse({ ...MINIMAL, secrets: [{ name: "GH" }] })).toThrow(/secrets/);
    // `permissions.tools` was removed — tools are per-agent only.
    expect(() => parse({ ...MINIMAL, permissions: { tools: [{ name: "web_search" }] } })).toThrow(
      /tools/,
    );
  });

  it("rejects bad slugs and missing triggers", () => {
    expect(() => parse({ slug: "has space", triggers: [{ kind: "manual" }] })).toThrow();
    expect(() => parse({ slug: "x", triggers: [] })).toThrow(/triggers/);
  });

  it("rejects a top-level `name` (renamed to `slug`) and a multi-line title", () => {
    expect(() => parse({ ...MINIMAL, name: "morning-digest" })).toThrow(/name/);
    expect(() => parse({ ...MINIMAL, title: "line one\nline two" })).toThrow(/single line/);
  });
});

describe("budget", () => {
  it("accepts max_compute_seconds (active compute, not wall clock)", () => {
    const m = parse({ ...MINIMAL, budget: { max_compute_seconds: 900 } });
    expect(m.budget).toEqual({ max_compute_seconds: 900 });
  });

  it("rejects the deleted deadline_seconds as an unknown key", () => {
    expect(() => parse({ ...MINIMAL, budget: { deadline_seconds: 86_400 } })).toThrow(
      /deadline_seconds/,
    );
  });

  it("rejects the renamed max_duration_seconds as an unknown key", () => {
    expect(() => parse({ ...MINIMAL, budget: { max_duration_seconds: 600 } })).toThrow(
      /max_duration_seconds/,
    );
  });
});

describe("concurrency", () => {
  it("accepts serial without a key (one run globally)", () => {
    expect(parse({ ...MINIMAL, concurrency: { mode: "serial" } }).concurrency).toEqual({
      mode: "serial",
    });
  });

  it("accepts serial with a runtime-interpolated key (one run per resolved key)", () => {
    const m = parse({
      ...MINIMAL,
      concurrency: { mode: "serial", key: "refund-${input.customerId}" },
    });
    expect(m.concurrency).toEqual({ mode: "serial", key: "refund-${input.customerId}" });
  });

  it("rejects the deleted serial_by_key mode", () => {
    expect(() =>
      parse({ ...MINIMAL, concurrency: { mode: "serial_by_key", key: "${input.id}" } }),
    ).toThrow();
  });

  it("rejects a key on unlimited mode", () => {
    expect(() => parse({ ...MINIMAL, concurrency: { mode: "unlimited", key: "x" } })).toThrow();
  });

  it("defaults to unlimited", () => {
    expect(parse(MINIMAL).concurrency).toEqual({ mode: "unlimited" });
  });
});

describe("entry and files", () => {
  it("accepts a package-relative entry", () => {
    expect(parse({ ...MINIMAL, entry: "src/main.ts" }).entry).toBe("src/main.ts");
  });

  it("defaults entry to undefined (per-language default resolved at deploy)", () => {
    expect(parse(MINIMAL).entry).toBeUndefined();
  });

  it("rejects an absolute or escaping entry", () => {
    for (const bad of ["/abs/index.ts", "../outside.ts", "src\\index.ts", "src/./index.ts"]) {
      expect(() => parse({ ...MINIMAL, entry: bad })).toThrow();
    }
  });

  it("accepts an allowlist of relative globs", () => {
    const m = parse({ ...MINIMAL, files: ["prompts/**", "data/seed.json", "*.csv"] });
    expect(m.files).toEqual(["prompts/**", "data/seed.json", "*.csv"]);
  });

  it("rejects empty, absolute, or escaping files globs", () => {
    expect(() => parse({ ...MINIMAL, files: [] })).toThrow();
    for (const bad of ["/etc/passwd", "../secrets/**", "a//b", ""]) {
      expect(() => parse({ ...MINIMAL, files: [bad] })).toThrow();
    }
  });
});

describe("triggers", () => {
  it("accepts 5- and 6-field cron expressions, rejects others", () => {
    const cron = (expr: string) => parse({ ...MINIMAL, triggers: [{ kind: "cron", expr }] });
    expect(cron("0 9 * * 1-5").triggers[0]).toEqual({ kind: "cron", expr: "0 9 * * 1-5" });
    expect(cron("0 0 9 * * 1").triggers).toHaveLength(1);
    expect(() => cron("9 * *")).toThrow(/5 fields/);
  });

  it("rejects generic event triggers (only the specific workflow_run kind exists)", () => {
    expect(() => parse({ ...MINIMAL, triggers: [{ kind: "event", event_name: "x" }] })).toThrow();
  });

  it("attaches a webhook trigger to a named org webhook", () => {
    const m = parse({ ...MINIMAL, triggers: [{ kind: "webhook", name: "stripe-prod" }] });
    expect(m.triggers[0]).toEqual({ kind: "webhook", name: "stripe-prod" });
  });

  it("rejects a webhook trigger with no name, a bad name, or the deleted auth field", () => {
    const webhook = (t: unknown) => () => parse({ ...MINIMAL, triggers: [t] });
    expect(webhook({ kind: "webhook" })).toThrow();
    expect(webhook({ kind: "webhook", name: "has space" })).toThrow(/alphanumeric/);
    // `auth` moved to the webhook object in the console; a stale descriptor must fail loudly.
    expect(webhook({ kind: "webhook", name: "ok", auth: "token" })).toThrow();
  });

  it("carries a cron trigger's static input through validation", () => {
    const m = parse({
      ...MINIMAL,
      triggers: [{ kind: "cron", expr: "0 9 * * *", input: { mode: "full", limit: 10 } }],
    });
    expect(m.triggers[0]).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      input: { mode: "full", limit: 10 },
    });
  });

  it("rejects a non-object cron input", () => {
    expect(() =>
      parse({ ...MINIMAL, triggers: [{ kind: "cron", expr: "0 9 * * *", input: "full" }] }),
    ).toThrow();
  });

  it("accepts a workflow_run trigger reacting to upstream workflows", () => {
    const m = parse({
      ...MINIMAL,
      triggers: [{ kind: "workflow_run", workflows: ["ci", "lint"] }],
    });
    expect(m.triggers[0]).toEqual({ kind: "workflow_run", workflows: ["ci", "lint"] });
  });

  it("accepts a workflow_run conclusions filter", () => {
    const m = parse({
      ...MINIMAL,
      triggers: [{ kind: "workflow_run", workflows: ["ci"], conclusions: ["success"] }],
    });
    expect(m.triggers[0]).toEqual({
      kind: "workflow_run",
      workflows: ["ci"],
      conclusions: ["success"],
    });
  });

  it("accepts a github trigger, with and without a repos narrowing", () => {
    const m = parse({
      ...MINIMAL,
      triggers: [
        { kind: "github", event: "pr.merged", repos: ["acme/api", "acme/web-app"] },
        { kind: "github", event: "issue.opened" },
      ],
    });
    expect(m.triggers[0]).toEqual({
      kind: "github",
      event: "pr.merged",
      repos: ["acme/api", "acme/web-app"],
    });
    expect(m.triggers[1]).toEqual({ kind: "github", event: "issue.opened" });
  });

  it("accepts every semantic github event", () => {
    for (const event of [
      "pr.opened",
      "pr.merged",
      "issue.opened",
      "issue.commented",
      "ci.completed",
    ]) {
      expect(parse({ ...MINIMAL, triggers: [{ kind: "github", event }] }).triggers).toHaveLength(1);
    }
  });

  it("rejects a github trigger with a raw provider action, an empty/bad repos list, or extras", () => {
    // Raw provider actions are NOT the vocabulary — semantic names only.
    expect(() =>
      parse({ ...MINIMAL, triggers: [{ kind: "github", event: "pull_request.closed" }] }),
    ).toThrow();
    expect(() => parse({ ...MINIMAL, triggers: [{ kind: "github" }] })).toThrow();
    expect(() =>
      parse({ ...MINIMAL, triggers: [{ kind: "github", event: "pr.merged", repos: [] }] }),
    ).toThrow();
    // A bare repo name is ambiguous — owner/name is required.
    expect(() =>
      parse({ ...MINIMAL, triggers: [{ kind: "github", event: "pr.merged", repos: ["api"] }] }),
    ).toThrow(/owner\/name/);
    // No inline filter escape hatch — filtering beyond repos is the semantic event's job.
    expect(() =>
      parse({
        ...MINIMAL,
        triggers: [{ kind: "github", event: "pr.merged", filter: { merged: true } }],
      }),
    ).toThrow();
  });

  it("accepts every semantic linear event and rejects raw actions/extras", () => {
    for (const event of ["issue.created", "issue.status_changed", "issue.commented"]) {
      expect(parse({ ...MINIMAL, triggers: [{ kind: "linear", event }] }).triggers).toEqual([
        { kind: "linear", event },
      ]);
    }
    expect(() =>
      parse({ ...MINIMAL, triggers: [{ kind: "linear", event: "Issue.create" }] }),
    ).toThrow();
    expect(() => parse({ ...MINIMAL, triggers: [{ kind: "linear" }] })).toThrow();
    expect(() =>
      parse({
        ...MINIMAL,
        triggers: [{ kind: "linear", event: "issue.created", teams: ["ENG"] }],
      }),
    ).toThrow();
  });

  it("accepts every semantic notion event and rejects raw event names/extras", () => {
    for (const event of ["page.created", "page.updated", "comment.created"]) {
      expect(parse({ ...MINIMAL, triggers: [{ kind: "notion", event }] }).triggers).toEqual([
        { kind: "notion", event },
      ]);
    }
    expect(() =>
      parse({ ...MINIMAL, triggers: [{ kind: "notion", event: "page.content_updated" }] }),
    ).toThrow();
    expect(() => parse({ ...MINIMAL, triggers: [{ kind: "notion" }] })).toThrow();
    expect(() =>
      parse({
        ...MINIMAL,
        triggers: [{ kind: "notion", event: "page.created", pages: ["abc"] }],
      }),
    ).toThrow();
  });

  it("accepts every semantic jira event and rejects raw actions/extras", () => {
    for (const event of ["issue.created", "issue.status_changed", "issue.commented"]) {
      expect(parse({ ...MINIMAL, triggers: [{ kind: "jira", event }] }).triggers).toEqual([
        { kind: "jira", event },
      ]);
    }
    expect(() =>
      parse({ ...MINIMAL, triggers: [{ kind: "jira", event: "jira:issue_created" }] }),
    ).toThrow();
    expect(() => parse({ ...MINIMAL, triggers: [{ kind: "jira" }] })).toThrow();
    expect(() =>
      parse({
        ...MINIMAL,
        triggers: [{ kind: "jira", event: "issue.created", jql: "project = ENG" }],
      }),
    ).toThrow();
  });

  it("rejects a workflow_run with no upstream workflows, a bad conclusion, or an invalid slug", () => {
    expect(() =>
      parse({ ...MINIMAL, triggers: [{ kind: "workflow_run", workflows: [] }] }),
    ).toThrow();
    expect(() =>
      parse({
        ...MINIMAL,
        triggers: [{ kind: "workflow_run", workflows: ["ci"], conclusions: ["merged"] }],
      }),
    ).toThrow();
    expect(() =>
      parse({ ...MINIMAL, triggers: [{ kind: "workflow_run", workflows: ["has space"] }] }),
    ).toThrow();
  });
});

describe("secrets and env", () => {
  it("a secret ref is exactly { name } — integration variants are rejected", () => {
    expect(() =>
      parse({ ...MINIMAL, permissions: { secrets: [{ name: "T", integration: "github" }] } }),
    ).toThrow();
    expect(() =>
      parse({ ...MINIMAL, permissions: { secrets: [{ name: "T", from_role: "r" }] } }),
    ).toThrow();
  });

  it("the secret allowlist lives at permissions.secrets", () => {
    const m = parse({ ...MINIMAL, permissions: { secrets: [{ name: "GITHUB_TOKEN" }] } });
    expect(m.permissions?.secrets).toEqual([{ name: "GITHUB_TOKEN" }]);
  });

  it("allows any env var name — no reserved prefixes (the program owns process.env)", () => {
    expect(parse({ ...MINIMAL, env: { BOARDWALK_X: "1" } }).env).toEqual({ BOARDWALK_X: "1" });
    expect(parse({ ...MINIMAL, env: { AWS_REGION: "us-east-1" } }).env).toEqual({
      AWS_REGION: "us-east-1",
    });
  });

  it("allows whole-value secret references only", () => {
    expect(parse({ ...MINIMAL, env: { T: "${{ secrets.GH }}" } }).env).toEqual({
      T: "${{ secrets.GH }}",
    });
    expect(() => parse({ ...MINIMAL, env: { T: "prefix-${{ secrets.GH }}" } })).toThrow(
      /whole-value/,
    );
  });
});

describe("workspace.persist", () => {
  it("accepts true, false, and workspace-relative directory lists", () => {
    expect(parse({ ...MINIMAL, workspace: { persist: true } }).workspace).toEqual({
      persist: true,
    });
    expect(parse({ ...MINIMAL, workspace: { persist: ["memory/a", "cache"] } }).workspace).toEqual({
      persist: ["memory/a", "cache"],
    });
  });

  it("rejects escaping or absolute paths", () => {
    for (const bad of ["../outside", "a/../b", "/abs", "a\\b", "a//b", "."]) {
      expect(() => parse({ ...MINIMAL, workspace: { persist: [bad] } })).toThrow();
    }
  });
});

describe("recording", () => {
  it("defaults to undefined (recorded) and accepts the false opt-out", () => {
    expect(parse({ ...MINIMAL }).recording).toBeUndefined();
    expect(parse({ ...MINIMAL, recording: false }).recording).toBe(false);
    expect(parse({ ...MINIMAL, recording: true }).recording).toBe(true);
  });

  it("rejects a non-boolean recording value", () => {
    expect(() => parse({ ...MINIMAL, recording: "off" })).toThrow();
  });
});

describe("platform-extension fields", () => {
  it("validates egress, callable_by, notifications round-trip with toEqual", () => {
    const m = parse({
      ...MINIMAL,
      egress: { level: "custom", allow: ["api.github.com"] },
      callable_by: { roles: ["admin", "member"] },
      notifications: [
        { on: "failure", channel: "email", target: "ops@example.com" },
        { on: "budget_exceeded", channel: "email", target: "ops@example.com" },
      ],
    });
    expect(m.egress).toEqual({ level: "custom", allow: ["api.github.com"] });
    expect(m.callable_by).toEqual({ roles: ["admin", "member"] });
    expect(m.notifications).toEqual([
      { on: "failure", channel: "email", target: "ops@example.com" },
      { on: "budget_exceeded", channel: "email", target: "ops@example.com" },
    ]);
  });

  it("rejects a template on budget_exceeded notifications", () => {
    expect(() =>
      parse({
        ...MINIMAL,
        notifications: [
          { on: "budget_exceeded", channel: "email", target: "x@y.z", template: "t" },
        ],
      }),
    ).toThrow();
  });
});

describe("runs_on self-hosted pool default", () => {
  it("fills pool with 'default' when omitted (the pool `boardwalk runner start` creates)", () => {
    const parsed = parse({
      slug: "on-my-metal",
      triggers: [{ kind: "manual" }],
      runs_on: { kind: "self-hosted" },
    });
    expect(parsed.runs_on).toEqual({ kind: "self-hosted", pool: "default" });
  });

  it("keeps an explicit pool + labels", () => {
    const parsed = parse({
      slug: "on-my-metal",
      triggers: [{ kind: "manual" }],
      runs_on: { kind: "self-hosted", pool: "gpu-fleet", labels: ["gpu"] },
    });
    expect(parsed.runs_on).toEqual({ kind: "self-hosted", pool: "gpu-fleet", labels: ["gpu"] });
  });
});

// The schema doubles as the published JSON Schema (https://boardwalk.sh/schemas/workflow.json),
// which is how an editor documents `workflow.jsonc` on hover. Descriptions are part of that
// contract: an undocumented field ships an empty tooltip.
interface Node {
  description?: string;
  const?: unknown;
  properties?: Record<string, Node | undefined>;
}

describe("field descriptions (the published JSON Schema)", () => {
  const jsonSchema = z.toJSONSchema(workflowManifestSchema, { target: "draft-7", io: "input" });
  const properties = jsonSchema.properties ?? {};

  it("documents every top-level field", () => {
    const undocumented = Object.entries(properties)
      .filter(([, value]) => typeof value !== "object" || !value.description)
      .map(([key]) => key);
    expect(undocumented).toEqual([]);
  });

  it("keeps descriptions through optional, default, and union wrappers", () => {
    // Each wrapper drops the description if `.describe()` lands on the wrong side of the chain.
    expect(properties.title).toHaveProperty("description"); // .optional()
    expect(properties.runs_on).toHaveProperty("description"); // .default() over a union
    expect(properties.concurrency).toHaveProperty("description"); // .default() over a union
    expect(properties.callable_by).toHaveProperty("description"); // .default() over a union
  });

  it("documents each trigger variant and the fields inside it", () => {
    const variants = (properties.triggers as unknown as { items: { oneOf: Node[] } }).items.oneOf;
    expect(variants.length).toBeGreaterThan(1);
    for (const variant of variants) {
      expect(variant.description).toBeTruthy();
    }
    const cron = variants.find((v) => v.properties?.kind?.const === "cron");
    expect(cron?.properties?.expr?.description).toBeTruthy();
    expect(cron?.properties?.timezone?.description).toBeTruthy();
  });

  it("writes no em dashes (these strings are product copy, not code comments)", () => {
    const offenders: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "description" && typeof value === "string" && /[—–]/.test(value)) {
          offenders.push(value);
        }
        walk(value);
      }
    };
    walk(jsonSchema);
    expect(offenders).toEqual([]);
  });
});
