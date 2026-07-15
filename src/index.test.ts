// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agent,
  artifacts,
  computer,
  humanInput,
  output,
  parallel,
  phase,
  runtime,
  secrets,
  sleep,
  workflows,
} from "./index.js";
import type { BrowserSession } from "./index.js";
import {
  installConfig,
  installHost,
  installInput,
  resetRuntime,
  takeDeclaredOutput,
  type WorkflowHost,
} from "./runtime.js";

function makeHost(overrides: Partial<WorkflowHost> = {}): WorkflowHost {
  return {
    agent: vi.fn().mockResolvedValue("agent-result"),
    callWorkflow: vi.fn().mockResolvedValue({ ok: true }),
    sleep: vi.fn().mockResolvedValue(undefined),
    getSecret: vi.fn().mockResolvedValue("s3cret"),
    ...overrides,
  };
}

beforeEach(() => {
  resetRuntime();
});

describe("host installation", () => {
  it("throws a clear error when a hook is called with no host installed", async () => {
    await expect(agent("hi")).rejects.toThrow(/no host installed/);
  });
});

describe("agent", () => {
  it("delegates to the host and returns its result", async () => {
    const agentFn = vi.fn().mockResolvedValue("agent-result");
    installHost(makeHost({ agent: agentFn }));
    await expect(agent("summarize")).resolves.toBe("agent-result");
    expect(agentFn).toHaveBeenCalledWith("summarize", undefined);
  });

  it("passes options through verbatim (model optional)", async () => {
    const agentFn = vi.fn().mockResolvedValue("r");
    installHost(makeHost({ agent: agentFn }));
    const opts = { model: "anthropic/claude-sonnet-4.5", memory: "memory/triager" };
    await agent("p", opts);
    expect(agentFn).toHaveBeenCalledWith("p", opts);
  });
});

describe("workflows", () => {
  it("call delegates and resolves the child output", async () => {
    const callWorkflow = vi.fn().mockResolvedValue({ ok: true });
    installHost(makeHost({ callWorkflow }));
    await expect(workflows.call("child", { a: 1 })).resolves.toEqual({ ok: true });
    expect(callWorkflow).toHaveBeenCalledWith("child", { a: 1 }, undefined);
  });

  it("run requires host support and surfaces a clear error without it", async () => {
    installHost(makeHost());
    await expect(workflows.run("child", {})).rejects.toThrow(/not supported/);
  });

  it("run resolves the child run id when supported", async () => {
    const runWorkflow = vi.fn().mockResolvedValue("run_123");
    installHost(makeHost({ runWorkflow }));
    await expect(workflows.run("child", {}, { idempotencyKey: "k" })).resolves.toBe("run_123");
    expect(runWorkflow).toHaveBeenCalledWith("child", {}, { idempotencyKey: "k" });
  });

  it("schedule requires host support and surfaces a clear error without it", async () => {
    installHost(makeHost());
    await expect(workflows.schedule("child", {}, { at: "2026-07-01T00:00:00Z" })).rejects.toThrow(
      /not supported/,
    );
  });

  it("schedule resolves the schedule id and passes opts through", async () => {
    const scheduleWorkflow = vi.fn().mockResolvedValue("sched_123");
    installHost(makeHost({ scheduleWorkflow }));
    const opts = { cron: "0 9 * * MON", timezone: "America/Anchorage" };
    await expect(workflows.schedule("report", { team: "growth" }, opts)).resolves.toBe("sched_123");
    expect(scheduleWorkflow).toHaveBeenCalledWith("report", { team: "growth" }, opts);
  });

  it("schedule rejects when zero or multiple recurrences are given", async () => {
    const scheduleWorkflow = vi.fn().mockResolvedValue("sched_123");
    installHost(makeHost({ scheduleWorkflow }));
    await expect(workflows.schedule("x", {}, {})).rejects.toThrow(/exactly one/);
    await expect(
      workflows.schedule("x", {}, { cron: "* * * * *", rate: "5 minutes" }),
    ).rejects.toThrow(/exactly one/);
    expect(scheduleWorkflow).not.toHaveBeenCalled();
  });
});

describe("sleep / secrets / phase / artifacts", () => {
  it("sleep delegates every arg form", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    installHost(makeHost({ sleep: sleepFn }));
    await sleep(50);
    await sleep({ durationMs: 100 });
    await sleep({ until: "2026-07-01T00:00:00Z" });
    expect(sleepFn).toHaveBeenCalledTimes(3);
  });

  it("secrets.get resolves through the host", async () => {
    installHost(makeHost());
    await expect(secrets.get("GITHUB_TOKEN")).resolves.toBe("s3cret");
  });

  it("phase throws when the engine has no setPhase", () => {
    installHost(makeHost());
    expect(() => phase("plan")).toThrow(/not supported/);
  });

  it("phase delegates when supported", () => {
    const setPhase = vi.fn();
    installHost(makeHost({ setPhase }));
    phase("plan", { id: "p1" });
    expect(setPhase).toHaveBeenCalledWith("plan", { id: "p1" });
  });

  it("artifacts.write throws when unsupported and delegates when supported", async () => {
    installHost(makeHost());
    await expect(artifacts.write("a.txt", "text/plain", "hi")).rejects.toThrow(/not supported/);

    const writeArtifact = vi
      .fn()
      .mockResolvedValue({ id: "art_1", name: "a.txt", url: "file:///a.txt" });
    installHost(makeHost({ writeArtifact }));
    await expect(artifacts.write("a.txt", "text/plain", "hi")).resolves.toEqual({
      id: "art_1",
      name: "a.txt",
      url: "file:///a.txt",
    });
  });
});

describe("computer.openBrowser", () => {
  it("throws when unsupported and delegates (forwarding opts) when supported", async () => {
    installHost(makeHost());
    await expect(computer.openBrowser()).rejects.toThrow(/not supported/);

    const session = { id: "sess_1" } as unknown as BrowserSession;
    const openBrowserSession = vi.fn().mockResolvedValue(session);
    installHost(makeHost({ openBrowserSession }));

    await expect(computer.openBrowser({ startUrl: "https://example.com" })).resolves.toBe(session);
    expect(openBrowserSession).toHaveBeenCalledWith({ startUrl: "https://example.com" });
  });

  it("passes a returned session through agent({ session })", async () => {
    const session = { id: "sess_2" } as unknown as BrowserSession;
    const agentFn = vi.fn().mockResolvedValue("done");
    installHost(
      makeHost({ agent: agentFn, openBrowserSession: vi.fn().mockResolvedValue(session) }),
    );

    const s = await computer.openBrowser();
    await agent("drive it", { session: s });
    expect(agentFn).toHaveBeenCalledWith("drive it", { session });
  });
});

describe("runtime", () => {
  it("throws a clear error when the engine supplies no runtime context", async () => {
    installHost(makeHost());
    expect(() => runtime.runId).toThrow(/runtime context is not available/);
    await expect(runtime.apiToken()).rejects.toThrow(/runtime context is not available/);
    await expect(runtime.idToken("sts.amazonaws.com")).rejects.toThrow(
      /runtime context is not available/,
    );
  });

  it("exposes ids synchronously and resolves apiToken through the host", async () => {
    const apiToken = vi.fn().mockResolvedValue("run-api-token");
    installHost(
      makeHost({
        runtime: {
          runId: "run_1",
          workflowId: "wf_1",
          orgId: "org_1",
          apiUrl: "https://api.boardwalk.sh",
          apiToken,
          idToken: vi.fn().mockResolvedValue("oidc-jwt"),
        },
      }),
    );
    expect(runtime.runId).toBe("run_1");
    expect(runtime.workflowId).toBe("wf_1");
    expect(runtime.orgId).toBe("org_1");
    expect(runtime.apiUrl).toBe("https://api.boardwalk.sh");
    await expect(runtime.apiToken()).resolves.toBe("run-api-token");
    expect(apiToken).toHaveBeenCalledTimes(1);
  });

  it("resolves idToken through the host, forwarding the audience", async () => {
    const idToken = vi.fn().mockResolvedValue("oidc-jwt");
    installHost(
      makeHost({
        runtime: {
          runId: "run_1",
          workflowId: "wf_1",
          orgId: "org_1",
          apiUrl: "https://api.boardwalk.sh",
          apiToken: vi.fn().mockResolvedValue("run-api-token"),
          idToken,
        },
      }),
    );
    await expect(runtime.idToken("sts.amazonaws.com")).resolves.toBe("oidc-jwt");
    expect(idToken).toHaveBeenCalledWith("sts.amazonaws.com");
    await expect(runtime.idToken("  ")).rejects.toThrow(/non-empty audience/);
    expect(idToken).toHaveBeenCalledTimes(1);
  });
});

describe("humanInput", () => {
  it("requires host support and surfaces a clear error without it", async () => {
    installHost(makeHost());
    await expect(humanInput({ prompt: "ok?", input: { kind: "text" } })).rejects.toThrow(
      /not supported/,
    );
  });

  it("delegates the opts and resolves the validated result", async () => {
    const humanInputFn = vi.fn().mockResolvedValue({ value: "Approve", isOther: false });
    installHost(makeHost({ humanInput: humanInputFn }));
    const opts = {
      prompt: "Approve?",
      input: { kind: "choice", options: ["Approve", "Reject"] },
    } as const;
    await expect(humanInput(opts)).resolves.toEqual({ value: "Approve", isOther: false });
    expect(humanInputFn).toHaveBeenCalledWith(opts);
  });
});

describe("parallel", () => {
  it("runs thunks and preserves order", async () => {
    const result = await parallel([
      () => Promise.resolve(1),
      () => new Promise<number>((r) => setTimeout(() => r(2), 5)),
      () => Promise.resolve(3),
    ]);
    expect(result).toEqual([1, 2, 3]);
  });

  it("rejects on the first failure (Promise.all semantics)", async () => {
    await expect(
      parallel([() => Promise.resolve(1), () => Promise.reject(new Error("boom"))]),
    ).rejects.toThrow("boom");
  });
});

describe("output / input / config", () => {
  it("output records last-write-wins; explicit null is distinguishable from never-set", () => {
    expect(takeDeclaredOutput()).toBeNull();
    output({ a: 1 });
    output("final");
    expect(takeDeclaredOutput()).toEqual({ value: "final" });
    output(null);
    expect(takeDeclaredOutput()).toEqual({ value: null });
  });

  it("input and config are live bindings installed by the engine", async () => {
    installInput({ ticket: 42 });
    installConfig({ model: "x/y" });
    const mod = await import("./index.js");
    expect(mod.input).toEqual({ ticket: 42 });
    expect(mod.config).toEqual({ model: "x/y" });
    expect(Object.isFrozen(mod.config)).toBe(true);
  });
});
