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
import { MxcSandboxConfigurationAudit } from "../src/sandbox-configuration-audit.js";
import { MxcSandboxConfigurationAuthorizationStore } from "../src/sandbox-configuration-authorization.js";
import { registerMxcSandboxConfigurationHooks } from "../src/sandbox-configuration-hooks.js";
import {
  computeMxcSandboxConfigurationArgsHash,
  MxcSandboxConfigurationStore,
} from "../src/sandbox-configuration-store.js";
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
  perToolSandboxEnabled: true,
};

const audits: MxcSandboxConfigurationAudit[] = [];
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
  const store = new MxcSandboxConfigurationStore(new MemoryKeyedStore());
  const authorizationStore = new MxcSandboxConfigurationAuthorizationStore(
    new MemorySyncKeyedStore(),
  );
  const api = {
    logger: { error: vi.fn() },
    on: vi.fn((name: string, handler: (...args: never[]) => unknown) => {
      hooks.set(name, handler);
    }),
  } as unknown as OpenClawPluginApi;
  const auditDir = mkdtempSync(path.join(tmpdir(), "openclaw-mxc-sandbox-"));
  const audit = new MxcSandboxConfigurationAudit({ logPath: path.join(auditDir, "audit.jsonl") });
  audits.push(audit);
  auditDirs.push(auditDir);
  registerMxcSandboxConfigurationHooks({
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

describe("MXC sandbox configuration hooks", () => {
  test("authorizes an unmatched exec without creating configuration state", async () => {
    const { authorizationStore, before, store } = setup();
    const params = { command: "git status" };

    const result = await before({ toolName: "exec", params }, context);

    const env = result?.params?.env as Record<string, string>;
    const authorization = authorizationStore.consume({ command: "git status", env }).authorization;
    expect(authorization).toMatchObject({
      argsHash: computeMxcSandboxConfigurationArgsHash(params),
      envelope: {},
    });
    expect(authorization?.sandboxConfiguration).toBeUndefined();
    expect(await store.count()).toBe(0);
  });

  test("attaches a matching configuration without prompting", async () => {
    const { authorizationStore, before, store } = setup();
    const params = { command: "git status" };
    const argsHash = computeMxcSandboxConfigurationArgsHash(params);
    await store.upsert({
      toolName: "exec",
      argsHash,
      argsSummary: "{}",
      envelope: { timeoutSeconds: 30, networkEnabled: false },
    });

    const result = await before({ toolName: "exec", params }, context);
    expect(result?.requireApproval).toBeUndefined();
    const env = result?.params?.env as Record<string, string>;
    expect(authorizationStore.consume({ command: "git status", env }).authorization).toMatchObject({
      envelope: { timeoutSeconds: 30, networkEnabled: false },
      sandboxConfiguration: { argsHash },
    });
    await expect(store.lookupExact("exec", argsHash)).resolves.toMatchObject({ useCount: 1 });
  });

  test("selects configuration for non-exec tools without claiming containment enforcement", async () => {
    const { before, store } = setup();
    const params = { path: "README.md" };
    await store.upsert({
      toolName: "read",
      argsHash: computeMxcSandboxConfigurationArgsHash(params),
      argsSummary: "{}",
      envelope: { readonlyPaths: ["C:\\source"] },
    });

    await expect(
      before({ toolName: "read", params }, { ...context, toolName: "read" }),
    ).resolves.toBeUndefined();
    await expect(
      store.lookupExact("read", computeMxcSandboxConfigurationArgsHash(params)),
    ).resolves.toMatchObject({ useCount: 1 });
  });

  test("fails closed when the configuration store cannot be read", async () => {
    const { before, store } = setup();
    vi.spyOn(store, "lookup").mockRejectedValueOnce(new Error("sqlite unavailable"));

    await expect(
      before({ toolName: "exec", params: { command: "git status" } }, context),
    ).resolves.toEqual({
      block: true,
      blockReason: "MXC per-tool sandbox configuration failed - fail-closed",
    });
  });

  test("does nothing when per-tool sandbox configuration is disabled", async () => {
    const { before } = setup({ ...baseConfig, perToolSandboxEnabled: false });

    await expect(
      before({ toolName: "exec", params: { command: "git status" } }, context),
    ).resolves.toBeUndefined();
  });
});
