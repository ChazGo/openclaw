import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MxcConfig } from "../src/config.js";
import { MxcPolicyAudit } from "../src/policy-audit.js";
import { MxcPolicyAuthorizationStore } from "../src/policy-authorization.js";
import { registerMxcPolicyHooks } from "../src/policy-hooks.js";
import { computeMxcPolicyArgsHash, MxcPolicyStore } from "../src/policy-store.js";
import { MemoryKeyedStore, MemorySyncKeyedStore } from "./policy-test-helpers.js";

type BeforeHook = (
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
) => Promise<PluginHookBeforeToolCallResult | void>;

const baseConfig: MxcConfig = {
  containment: "process",
  network: "none",
  timeoutSeconds: 120,
  debug: false,
  localPolicyEnabled: true,
  localPolicyAutoApprove: false,
  approvalTimeoutMs: 600_000,
  approvalSeverity: "warning",
};

const audits: MxcPolicyAudit[] = [];
const auditDirs: string[] = [];

afterEach(async () => {
  await Promise.all(audits.map((audit) => audit.flush()));
  for (const auditDir of auditDirs) {
    rmSync(auditDir, { recursive: true, force: true });
  }
  audits.length = 0;
  auditDirs.length = 0;
});

function setup(config: MxcConfig = baseConfig) {
  const hooks = new Map<string, (...args: never[]) => unknown>();
  const store = new MxcPolicyStore(new MemoryKeyedStore());
  const authorizationStore = new MxcPolicyAuthorizationStore(new MemorySyncKeyedStore());
  const api = {
    logger: { error: vi.fn() },
    on: vi.fn((name: string, handler: (...args: never[]) => unknown) => {
      hooks.set(name, handler);
    }),
  } as unknown as OpenClawPluginApi;
  const auditDir = mkdtempSync(path.join(tmpdir(), "openclaw-mxc-policy-"));
  const audit = new MxcPolicyAudit({ logPath: path.join(auditDir, "audit.jsonl") });
  audits.push(audit);
  auditDirs.push(auditDir);
  registerMxcPolicyHooks({
    api,
    getConfig: () => config,
    store,
    authorizationStore,
    audit,
  });
  return {
    store,
    authorizationStore,
    before: hooks.get("before_tool_call") as unknown as BeforeHook,
    after: hooks.get("after_tool_call") as unknown as (
      event: PluginHookAfterToolCallEvent,
      ctx: PluginHookToolContext,
    ) => void,
  };
}

const context: PluginHookToolContext = {
  toolName: "exec",
  sessionId: "session",
  runId: "run",
  toolCallId: "call",
};

describe("MXC policy hooks", () => {
  test("authorizes an unmatched exec without prompting or creating a policy", async () => {
    const { authorizationStore, before, store } = setup();
    const params = { command: "git status" };

    const result = await before({ toolName: "exec", params }, context);

    expect(result?.requireApproval).toBeUndefined();
    const env = result?.params?.env as Record<string, string>;
    const authorization = authorizationStore.consume({ command: "git status", env }).authorization;
    expect(authorization).toMatchObject({
      argsHash: computeMxcPolicyArgsHash(params),
      envelope: {},
    });
    expect(authorization?.policyRule).toBeUndefined();
    expect(await store.counts()).toEqual({ total: 0, settled: 0, inDevelopment: 0 });
  });

  test("blocks a settled deny policy", async () => {
    const { before, store } = setup();
    const params = { path: "secret.txt" };
    await store.upsert({
      toolName: "read",
      argsHash: computeMxcPolicyArgsHash(params),
      argsSummary: "{}",
      decision: "deny",
      envelope: {},
      lifecycle: "settled",
    });

    await expect(
      before({ toolName: "read", params }, { ...context, toolName: "read" }),
    ).resolves.toEqual({
      block: true,
      blockReason: "MXC policy denied read",
    });
  });

  test("prompts for a development rule and authorizes allow-once", async () => {
    const { before, store, authorizationStore } = setup();
    const params = { command: "git status" };
    await store.upsert({
      toolName: "exec",
      argsHash: computeMxcPolicyArgsHash(params),
      argsSummary: "{}",
      decision: "deny",
      envelope: {},
      lifecycle: "development",
    });

    const result = await before({ toolName: "exec", params }, context);
    expect(result?.requireApproval?.allowedDecisions).toEqual([
      "allow-once",
      "allow-always",
      "deny",
    ]);
    await result?.requireApproval?.onResolution?.("allow-once");

    const env = result?.params?.env as Record<string, string>;
    expect(authorizationStore.consume({ command: "git status", env }).authorization).toMatchObject({
      toolName: "exec",
    });
    expect(await store.lookupExact("exec", computeMxcPolicyArgsHash(params))).toMatchObject({
      lifecycle: "development",
      useCount: 1,
    });
  });

  test("automatic settlement applies only to an existing development rule", async () => {
    const config = { ...baseConfig, localPolicyAutoApprove: true };
    const { before, store } = setup(config);
    const unmatched = { command: "git diff" };
    await before({ toolName: "exec", params: unmatched }, context);
    expect(await store.counts()).toEqual({ total: 0, settled: 0, inDevelopment: 0 });

    const params = { command: "git status" };
    await store.upsert({
      toolName: "exec",
      argsHash: computeMxcPolicyArgsHash(params),
      argsSummary: "{}",
      decision: "deny",
      envelope: {},
      lifecycle: "development",
    });
    const result = await before({ toolName: "exec", params }, context);

    expect(result?.requireApproval).toBeUndefined();
    expect(await store.lookupExact("exec", computeMxcPolicyArgsHash(params))).toMatchObject({
      decision: "allow",
      lifecycle: "settled",
    });
  });

  test("does not let automatic approval overwrite a concurrent deny", async () => {
    const config = { ...baseConfig, localPolicyAutoApprove: true };
    const { before, store } = setup(config);
    const params = { command: "git status" };
    const argsHash = computeMxcPolicyArgsHash(params);
    const developmentRule = await store.upsert({
      toolName: "exec",
      argsHash,
      argsSummary: "{}",
      decision: "deny",
      envelope: {},
      lifecycle: "development",
    });
    const settle = store.settleAllowIfUnchanged.bind(store);
    vi.spyOn(store, "settleAllowIfUnchanged").mockImplementationOnce(async (rule, fingerprint) => {
      await store.upsert({
        ...developmentRule,
        decision: "deny",
        lifecycle: "settled",
      });
      return settle(rule, fingerprint);
    });

    await expect(before({ toolName: "exec", params }, context)).resolves.toEqual({
      block: true,
      blockReason: "MXC local policy evaluation failed - fail-closed",
    });
    await expect(store.lookupExact("exec", argsHash)).resolves.toMatchObject({
      decision: "deny",
      lifecycle: "settled",
    });
  });

  test("accepts an identical concurrent allow-always settlement", async () => {
    const { before, store, authorizationStore } = setup();
    const params = { command: "git status" };
    const argsHash = computeMxcPolicyArgsHash(params);
    const developmentRule = await store.upsert({
      toolName: "exec",
      argsHash,
      argsSummary: "{}",
      decision: "allow",
      envelope: { networkEnabled: false },
      lifecycle: "development",
    });
    const result = await before({ toolName: "exec", params }, context);
    await store.upsert({
      ...developmentRule,
      decision: "allow",
      lifecycle: "settled",
    });

    await result?.requireApproval?.onResolution?.("allow-always");

    const env = result?.params?.env as Record<string, string>;
    expect(authorizationStore.consume({ command: "git status", env }).authorization).toMatchObject({
      approvalState: "approved",
    });
  });

  test("does not let a stale approval overwrite a newer deny rule", async () => {
    const { before, store, authorizationStore } = setup();
    const params = { command: "git status" };
    const argsHash = computeMxcPolicyArgsHash(params);
    const developmentRule = await store.upsert({
      toolName: "exec",
      argsHash,
      argsSummary: "{}",
      decision: "allow",
      envelope: { networkEnabled: false },
      lifecycle: "development",
    });
    const result = await before({ toolName: "exec", params }, context);
    const env = result?.params?.env as Record<string, string>;

    await store.upsert({
      ...developmentRule,
      decision: "deny",
      envelope: {},
      lifecycle: "settled",
    });
    await result?.requireApproval?.onResolution?.("allow-always");

    await expect(store.lookupExact("exec", argsHash)).resolves.toMatchObject({
      decision: "deny",
      lifecycle: "settled",
    });
    expect(() => authorizationStore.consume({ command: "git status", env })).toThrow(
      /missing or expired/u,
    );
  });

  test("fails closed when the policy store cannot be read", async () => {
    const { before, store } = setup();
    vi.spyOn(store, "lookup").mockRejectedValueOnce(new Error("sqlite unavailable"));

    await expect(
      before({ toolName: "exec", params: { command: "git status" } }, context),
    ).resolves.toEqual({
      block: true,
      blockReason: "MXC local policy evaluation failed - fail-closed",
    });
  });
});
