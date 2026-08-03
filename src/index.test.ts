// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agent,
  artifacts,
  auth,
  computer,
  humanInput,
  installTestHost,
  parallel,
  phase,
  secrets,
  shell,
  sleep,
  usage,
  workflows,
} from "./index.js";
import type { BrowserSession, Context, ShellResult } from "./index.js";
import { resetHost } from "./host_client.js";

const HOST_SOCK_ENV = "BOARDWALK_HOST_SOCK";
let savedSock: string | undefined;

beforeEach(() => {
  savedSock = process.env[HOST_SOCK_ENV];
  delete process.env[HOST_SOCK_ENV]; // no ambient host — tests opt in via installTestHost
  resetHost();
});

afterEach(() => {
  if (savedSock === undefined) delete process.env[HOST_SOCK_ENV];
  else process.env[HOST_SOCK_ENV] = savedSock;
  resetHost();
});

describe("no host", () => {
  it("rejects with a clear error when no test host is installed and no socket is named", async () => {
    await expect(agent("hi")).rejects.toThrow(/no host available/);
    await expect(agent("hi")).rejects.toThrow(/installTestHost/);
  });
});

describe("agent", () => {
  it("delegates to the host and returns its result", async () => {
    const agentFn = vi.fn().mockResolvedValue("agent-result");
    installTestHost({ agent: agentFn });
    await expect(agent("summarize")).resolves.toBe("agent-result");
    expect(agentFn).toHaveBeenCalledWith("summarize", undefined);
  });

  it("passes options through verbatim (model optional)", async () => {
    const agentFn = vi.fn().mockResolvedValue("r");
    installTestHost({ agent: agentFn });
    const opts = { model: "anthropic/claude-sonnet-4.5", memory: "memory/triager" };
    await agent("p", opts);
    expect(agentFn).toHaveBeenCalledWith("p", opts);
  });

  it("throws the not-stubbed error when agent is not provided", async () => {
    installTestHost({});
    await expect(agent("p")).rejects.toThrow(/agent is not stubbed/);
  });
});

describe("workflows", () => {
  it("call delegates and resolves the child output", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    installTestHost({ workflows: { call } });
    await expect(workflows.call("child", { a: 1 })).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith("child", { a: 1 }, undefined);
  });

  it("run resolves the child run id and passes opts through", async () => {
    const run = vi.fn().mockResolvedValue("run_123");
    installTestHost({ workflows: { run } });
    await expect(workflows.run("child", {}, { idempotencyKey: "k" })).resolves.toBe("run_123");
    expect(run).toHaveBeenCalledWith("child", {}, { idempotencyKey: "k" });
  });

  it("schedule resolves the schedule id and passes opts through", async () => {
    const schedule = vi.fn().mockResolvedValue("sched_123");
    installTestHost({ workflows: { schedule } });
    const opts = { cron: "0 9 * * MON", timezone: "America/Anchorage" };
    await expect(workflows.schedule("report", { team: "growth" }, opts)).resolves.toBe("sched_123");
    expect(schedule).toHaveBeenCalledWith("report", { team: "growth" }, opts);
  });

  it("schedule rejects when zero or multiple recurrences are given", async () => {
    const schedule = vi.fn().mockResolvedValue("sched_123");
    installTestHost({ workflows: { schedule } });
    await expect(workflows.schedule("x", {}, {})).rejects.toThrow(/exactly one/);
    await expect(
      workflows.schedule("x", {}, { cron: "* * * * *", rate: "5 minutes" }),
    ).rejects.toThrow(/exactly one/);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("call/run/schedule throw the not-stubbed error when not provided", async () => {
    installTestHost({});
    await expect(workflows.call("c", {})).rejects.toThrow(/workflows.call is not stubbed/);
    await expect(workflows.run("c", {})).rejects.toThrow(/workflows.run is not stubbed/);
    await expect(workflows.schedule("c", {}, { at: "2026-07-01T00:00:00Z" })).rejects.toThrow(
      /workflows.schedule is not stubbed/,
    );
  });
});

describe("sleep / secrets / phase / artifacts / shell", () => {
  it("sleep delegates every arg form and defaults to resolving immediately", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    installTestHost({ sleep: sleepFn });
    await sleep(50);
    await sleep({ durationMs: 100 });
    await sleep({ until: "2026-07-01T00:00:00Z" });
    await sleep("15m"); // duration strings normalize before the stub sees them
    expect(sleepFn).toHaveBeenCalledTimes(4);
    expect(sleepFn).toHaveBeenLastCalledWith({ durationMs: 900_000 });

    // The test host validates like a real run: a malformed arg fails the unit test, not prod.
    await expect(sleep("soon")).rejects.toThrow(/duration/);

    installTestHost({}); // no stub: still resolves (a test never actually waits)
    await expect(sleep(10_000)).resolves.toBeUndefined();
  });

  it("secrets.get resolves from a record stub and errors on a missing name", async () => {
    installTestHost({ secrets: { GITHUB_TOKEN: "s3cret" } });
    await expect(secrets.get("GITHUB_TOKEN")).resolves.toBe("s3cret");
    await expect(secrets.get("MISSING")).rejects.toThrow(/secret "MISSING" is not stubbed/);
  });

  it("secrets.get resolves through a resolver-function stub", async () => {
    installTestHost({ secrets: (name) => `v:${name}` });
    await expect(secrets.get("A")).resolves.toBe("v:A");
  });

  it("phase delegates when stubbed and is a silent no-op otherwise", () => {
    const phaseFn = vi.fn();
    installTestHost({ phase: phaseFn });
    phase("plan", { id: "p1" });
    expect(phaseFn).toHaveBeenCalledWith("plan", { id: "p1" });

    installTestHost({});
    expect(() => {
      phase("plan");
    }).not.toThrow();
  });

  it("artifacts.write delegates and resolves the ref", async () => {
    const write = vi.fn().mockResolvedValue({ id: "art_1", name: "a.txt", url: "file:///a.txt" });
    installTestHost({ artifacts: { write } });
    await expect(artifacts.write("a.txt", "text/plain", "hi")).resolves.toEqual({
      id: "art_1",
      name: "a.txt",
      url: "file:///a.txt",
    });
    expect(write).toHaveBeenCalledWith("a.txt", "text/plain", "hi", undefined);
  });

  it("shell resolves the completed command, exit code included", async () => {
    const result: ShellResult = { exitCode: 3, stdout: "", stderr: "boom" };
    const shellFn = vi.fn().mockResolvedValue(result);
    installTestHost({ shell: shellFn });
    await expect(shell("exit 3", { cwd: "/workspace" })).resolves.toEqual(result);
    expect(shellFn).toHaveBeenCalledWith("exit 3", { cwd: "/workspace" });
  });
});

describe("computer.openBrowser", () => {
  it("delegates (forwarding opts) and passes the session through agent({ session })", async () => {
    const session = { id: "sess_1" } as unknown as BrowserSession;
    const openBrowser = vi.fn().mockResolvedValue(session);
    const agentFn = vi.fn().mockResolvedValue("done");
    installTestHost({ agent: agentFn, computer: { openBrowser } });

    const s = await computer.openBrowser({ startUrl: "https://example.com" });
    expect(openBrowser).toHaveBeenCalledWith({ startUrl: "https://example.com" });
    await agent("drive it", { session: s });
    expect(agentFn).toHaveBeenCalledWith("drive it", { session });
  });
});

describe("humanInput", () => {
  it("delegates the opts and resolves the validated result", async () => {
    const humanInputFn = vi.fn().mockResolvedValue({ value: "Approve", isOther: false });
    installTestHost({ humanInput: humanInputFn });
    const opts = {
      prompt: "Approve?",
      input: { kind: "choice", options: ["Approve", "Reject"] },
    } as const;
    await expect(humanInput(opts)).resolves.toEqual({ value: "Approve", isOther: false });
    expect(humanInputFn).toHaveBeenCalledWith(opts);
  });
});

describe("auth / usage", () => {
  it("auth.idToken forwards the audience and rejects a blank one without calling the host", async () => {
    const idToken = vi.fn().mockResolvedValue("oidc-jwt");
    installTestHost({ auth: { idToken } });
    await expect(auth.idToken("sts.amazonaws.com")).resolves.toBe("oidc-jwt");
    expect(idToken).toHaveBeenCalledWith("sts.amazonaws.com");
    await expect(auth.idToken("  ")).rejects.toThrow(/non-empty audience/);
    expect(idToken).toHaveBeenCalledTimes(1);
  });

  it("auth.apiToken delegates", async () => {
    installTestHost({ auth: { apiToken: () => "bearer-1" } });
    await expect(auth.apiToken()).resolves.toBe("bearer-1");
  });

  it("usage.get defaults to zero spend with no caps and delegates when stubbed", async () => {
    installTestHost({});
    await expect(usage.get()).resolves.toEqual({
      usd: { spent: 0, cap: null, remaining: null },
      tokens: { spent: 0, cap: null, remaining: null },
      compute_seconds: { spent: 0, cap: null, remaining: null },
    });

    const snapshot = {
      usd: { spent: 1.25, cap: 10, remaining: 8.75 },
      tokens: { spent: 5000, cap: null, remaining: null },
      compute_seconds: { spent: 42, cap: 3600, remaining: 3558 },
    };
    installTestHost({ usage: () => snapshot });
    await expect(usage.get()).resolves.toEqual(snapshot);
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

  it("isolates a failed thunk to null instead of rejecting the whole batch", async () => {
    const result = await parallel([
      () => Promise.resolve(1),
      () => Promise.reject(new Error("boom")),
      () => Promise.resolve(3),
    ]);
    // Order preserved; the failure is null, the siblings survive.
    expect(result).toEqual([1, null, 3]);
    expect(result.filter((r) => r !== null)).toEqual([1, 3]);
  });

  it("still rejects when a thunk fails with a run-fatal error (budget / cancel)", async () => {
    const budget = Object.assign(new Error("out of budget"), { code: "BUDGET_EXCEEDED" });
    await expect(
      parallel([() => Promise.resolve(1), () => Promise.reject(budget)]),
    ).rejects.toThrow("out of budget");

    const cancelled = Object.assign(new Error("cancelled"), { code: "CANCELLED" });
    await expect(
      parallel([() => Promise.reject(cancelled), () => Promise.resolve(2)]),
    ).rejects.toThrow("cancelled");
  });

  it("honors an explicit fatal flag on the rejection", async () => {
    const fatal = Object.assign(new Error("stop everything"), { fatal: true });
    await expect(parallel([() => Promise.reject(fatal)])).rejects.toThrow("stop everything");
  });
});

describe("the test-host handle", () => {
  it("builds a plausible frozen Context wired to the host's signal, with overrides", () => {
    const host = installTestHost({});
    const ctx = host.context({ runId: "01RUNOVERRIDE0000000000000", attempt: 3 });
    expect(ctx.runId).toBe("01RUNOVERRIDE0000000000000");
    expect(ctx.attempt).toBe(3);
    expect(ctx.workflowVersion).toBe(1);
    expect(ctx.environment).toBeNull();
    expect(ctx.actor.type).toBe("user");
    expect(ctx.trigger.kind).toBe("manual");
    expect(ctx.signal).toBe(host.signal);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("cancel() aborts the signal with a CANCELLED reason", () => {
    const host = installTestHost({});
    const ctx = host.context();
    expect(ctx.signal.aborted).toBe(false);
    host.cancel();
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.signal.reason).toMatchObject({ code: "CANCELLED" });
  });

  it("uninstall() removes the host", async () => {
    const host = installTestHost({ agent: () => "x" });
    await expect(agent("p")).resolves.toBe("x");
    host.uninstall();
    await expect(agent("p")).rejects.toThrow(/no host available/);
  });
});

describe("a sample run() as a plain unit-test call", () => {
  // The entry contract: authors write `export default async function run(input, context)`.
  interface Payment {
    id: string;
    amountUsd: number;
  }
  interface Triage {
    action: "retry" | "refund";
    note: string;
    by: string;
  }

  async function run(input: Payment, context: Context): Promise<Triage> {
    const key = await secrets.get("STRIPE_API_KEY");
    phase("analyze");
    const note = await agent(`Why did payment ${input.id} for $${input.amountUsd} fail? (${key})`);
    return { action: "retry", note, by: context.runId };
  }

  it("runs over stubs with no socket and no engine", async () => {
    const phases: string[] = [];
    const host = installTestHost({
      agent: (prompt) => `analysis of: ${prompt.slice(0, 19)}`,
      secrets: { STRIPE_API_KEY: "sk_test_1" },
      phase: (name) => phases.push(name),
    });

    const out = await run({ id: "pay_1", amountUsd: 12 }, host.context());
    expect(out).toEqual({
      action: "retry",
      note: "analysis of: Why did payment pay",
      by: "01TESTRUN00000000000000000",
    });
    expect(phases).toEqual(["analyze"]);
  });
});
