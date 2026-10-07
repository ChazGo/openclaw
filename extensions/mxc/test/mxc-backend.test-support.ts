// Shared MXC backend test fixtures. Each test file still owns its vi.mock setup.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { expect } from "vitest";
import type { MxcConfig } from "../src/config.js";
export const baseConfig: MxcConfig = {
  containment: "process",
  network: "none",
  timeoutSeconds: 120,
  timeoutSecondsConfigured: true,
  debug: false,
};

export const baseParams = {
  config: baseConfig,
  runtimeId: "openclaw-mxc-test-abc12345",
  workdir: "/workspace",
};

export const testDirs: string[] = [];

export function sandboxPolicyConfig(policy: unknown, config: MxcConfig = baseConfig): MxcConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "mxc-policy-"));
  testDirs.push(dir);
  const policyPath = path.join(dir, "policy.json");
  writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, "utf-8");
  return {
    ...config,
    mxcPolicyPaths: [policyPath],
  };
}

export function decodePayload(
  argv: readonly string[],
  options: { cleanupPayloadFile?: boolean } = {},
): {
  config: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  const payloadFileIndex = argv.indexOf("--payload-file");
  const payloadFile = argv[payloadFileIndex + 1];
  if (payloadFileIndex >= 0 && payloadFile !== undefined) {
    const decoded = JSON.parse(readFileSync(payloadFile, "utf-8")) as {
      config: Record<string, unknown>;
      options: Record<string, unknown>;
    };
    if (options.cleanupPayloadFile !== false) {
      rmSync(path.dirname(payloadFile), { force: true, recursive: true });
    }
    return decoded;
  }
  const payloadIndex = argv.indexOf("--payload");
  const payload = argv[payloadIndex + 1];
  if (payloadIndex < 0 || payload === undefined) {
    throw new Error(`expected --payload in argv: ${JSON.stringify(argv)}`);
  }
  return JSON.parse(Buffer.from(payload, "base64").toString("utf-8")) as {
    config: Record<string, unknown>;
    options: Record<string, unknown>;
  };
}

export function decodeContainerConfig(argv: readonly string[]): Record<string, unknown> {
  return decodePayload(argv).config;
}

export function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  expect(field).toEqual(expect.any(Object));
  return field as Record<string, unknown>;
}

export function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  expect(field).toEqual(expect.any(Array));
  return field as string[];
}

export function createSandboxBackendTestConfig(
  overrides: Partial<CreateSandboxBackendParams["cfg"]> = {},
): CreateSandboxBackendParams["cfg"] {
  return {
    mode: "all",
    backend: "mxc",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: "/workspace-root",
    dockerTmpfsSource: "configured",
    docker: {
      binds: [],
      capDrop: [],
      containerPrefix: "openclaw-sbx-",
      env: {},
      image: "unused",
      network: "none",
      readOnlyRoot: true,
      tmpfs: [],
      workdir: "/workspace",
    },
    ssh: {
      command: "ssh",
      strictHostKeyChecking: true,
      updateHostKeys: false,
      workspaceRoot: "/tmp",
    },
    browser: {
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 0,
      binds: [],
      cdpPort: 0,
      cdpSourceRange: undefined,
      noVncEnabled: false,
      headless: true,
      image: "",
      network: "",
      noVncPort: 0,
      vncPort: 0,
      containerPrefix: "",
      enabled: false,
    },
    tools: {},
    prune: { idleHours: 0, maxAgeDays: 0 },
    ...overrides,
  };
}

export const configuredRoster = { listAgentIds: () => ["main", "analyst", "reviewer", "other"] };
