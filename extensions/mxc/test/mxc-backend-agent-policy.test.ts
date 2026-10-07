import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { createMxcSandboxBackendFactory } from "../src/mxc-backend-factory.js";
import {
  baseConfig,
  baseParams,
  configuredRoster,
  createSandboxBackendTestConfig,
  decodeContainerConfig,
  decodePayload,
  objectField,
  sandboxPolicyConfig,
  stringArrayField,
  testDirs,
} from "./mxc-backend.test-support.js";

const { spawnCommandMock, execFileSyncMock, mockedHomeDir } = vi.hoisted(() => ({
  spawnCommandMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  mockedHomeDir: { value: undefined as string | undefined },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockedHomeDir.value ?? actual.homedir(),
  };
});

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered: spawnCommandMock,
}));

vi.mock("../src/binary-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/binary-resolver.js")>()),
  resolveMxcBinaryPath: (configuredPath?: string) => configuredPath ?? "mxc-test-binary",
}));

const describeOnWindows = describe.runIf(process.platform === "win32");
describe("createMxcSandboxBackendFactory", () => {
  test("hashes workspace-qualified scopes without truncating their identity", async () => {
    const createBackend = createMxcSandboxBackendFactory(baseConfig, configuredRoster);
    const handle = await createBackend({
      sessionKey: "agent:main:main",
      scopeKey: `agent:main:workspace:${"a".repeat(32)}`,
      workspaceDir: baseParams.workdir,
      agentWorkspaceDir: baseParams.workdir,
      cfg: createSandboxBackendTestConfig({ workspaceAccess: "rw" }),
    });

    expect(handle.runtimeId).toMatch(/^openclaw-mxc-workspace-[a-f0-9]{32}$/u);
  });

  test("validates overrides against the live roster on every backend creation", async () => {
    let roster: string[] = ["main"];
    const listAgentIds = vi.fn(() => roster);
    const createBackend = createMxcSandboxBackendFactory(
      resolveConfig({ agents: { analyst: { network: "none" } } }),
      { listAgentIds },
    );
    const create = (agentId: string) =>
      createBackend({
        agentId,
        sessionKey: `agent:${agentId}:main`,
        scopeKey: `agent:${agentId}`,
        workspaceDir: baseParams.workdir,
        agentWorkspaceDir: baseParams.workdir,
        cfg: createSandboxBackendTestConfig({ scope: "agent" }),
      });
    const unknownAnalyst =
      'Invalid mxc plugin config: unknown agent ID "analyst"; configure the agent or remove plugins.entries.mxc.config.agents.analyst.';

    // A stale override blocks every agent, including agents that use plugin defaults.
    await expect(create("main")).rejects.toThrow(unknownAnalyst);
    roster = ["main", "analyst"];
    await expect(create("analyst")).resolves.toBeDefined();
    await expect(create("main")).resolves.toBeDefined();
    roster = ["main", "analyst-renamed"];
    await expect(create("main")).rejects.toThrow(unknownAnalyst);
    roster = [];
    await expect(create("analyst")).rejects.toThrow(unknownAnalyst);
    expect(listAgentIds).toHaveBeenCalledTimes(5);
  });

  test("reads one roster snapshot per creation, so a removal that lands later fails the next creation", async () => {
    let roster = ["main", "analyst"];
    const listAgentIds = vi.fn(() => {
      const snapshot = roster;
      // The removal commits after this creation read the roster.
      roster = ["main"];
      return snapshot;
    });
    const createBackend = createMxcSandboxBackendFactory(
      resolveConfig({ agents: { analyst: { network: "none" } } }),
      { listAgentIds },
    );
    const params = {
      agentId: "analyst",
      sessionKey: "agent:analyst:main",
      scopeKey: "agent:analyst",
      workspaceDir: baseParams.workdir,
      agentWorkspaceDir: baseParams.workdir,
      cfg: createSandboxBackendTestConfig({ scope: "agent" }),
    };
    await expect(createBackend(params)).resolves.toBeDefined();
    await expect(createBackend(params)).rejects.toThrow('unknown agent ID "analyst"');
    expect(listAgentIds).toHaveBeenCalledTimes(2);
  });

  test("checks registration authority before reading the roster", async () => {
    const listAgentIds = vi.fn(() => ["main"]);
    const createBackend = createMxcSandboxBackendFactory(baseConfig, {
      listAgentIds,
      assertRegistrationCurrent: () => {
        throw new Error("registration retired");
      },
    });
    await expect(
      createBackend({
        sessionKey: "agent:main:main",
        scopeKey: "agent:main",
        workspaceDir: baseParams.workdir,
        agentWorkspaceDir: baseParams.workdir,
        cfg: createSandboxBackendTestConfig({ scope: "agent" }),
      }),
    ).rejects.toThrow("registration retired");
    expect(listAgentIds).not.toHaveBeenCalled();
  });
});

describeOnWindows("per-agent MXC policy selection (Windows-only MXC backend tests)", () => {
  beforeEach(() => {
    spawnCommandMock.mockReset();
    spawnCommandMock.mockResolvedValue({
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    mockedHomeDir.value = mkdtempSync(path.join(tmpdir(), "mxc-test-home-"));
    testDirs.push(mockedHomeDir.value);
    baseParams.workdir = mkdtempSync(path.join(tmpdir(), "mxc-test-workspace-"));
    testDirs.push(baseParams.workdir);
  });

  afterEach(() => {
    mockedHomeDir.value = undefined;
    for (const dir of testDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test.each(["host", "registration"])(
    "retained factory handles reject expired %s authority",
    async (authority) => {
      const reason = "retired";
      let current = true;
      const assertRuntimeCurrent = () => {
        if (!current) {
          throw new Error("owner " + reason);
        }
      };
      const factory = createMxcSandboxBackendFactory(
        resolveConfig({
          agents: { analyst: { network: "none" } },
        }),
        {
          ...configuredRoster,
          assertRegistrationCurrent:
            authority === "registration" ? assertRuntimeCurrent : undefined,
        },
      );
      const handle = await factory({
        agentId: "analyst",
        sessionKey: "opaque-owner-test",
        scopeKey: "agent:analyst",
        workspaceDir: baseParams.workdir,
        agentWorkspaceDir: baseParams.workdir,
        cfg: createSandboxBackendTestConfig({ scope: "agent" }),
        assertRuntimeCurrent: authority === "host" ? assertRuntimeCurrent : undefined,
      });
      const spec = await handle.buildExecSpec({ command: "echo admitted", env: {}, usePty: false });
      try {
        current = false;
        expect(() => spec.assertCurrent?.()).toThrow("owner " + reason);
        await expect(
          handle.buildExecSpec({ command: "echo stale", env: {}, usePty: false }),
        ).rejects.toThrow("owner " + reason);
        await expect(handle.runShellCommand({ script: "echo stale" })).rejects.toThrow(
          "owner " + reason,
        );
        await expect(handle.validateWorkdir?.(baseParams.workdir)).rejects.toThrow(
          "owner " + reason,
        );
        expect(spawnCommandMock).not.toHaveBeenCalled();
      } finally {
        await handle.finalizeExec?.({
          status: "failed",
          exitCode: null,
          timedOut: false,
          token: spec.finalizeToken,
        });
      }
    },
  );

  test("an admitted handle keeps its policy after its agent leaves the roster", async () => {
    let roster = ["analyst"];
    const createBackend = createMxcSandboxBackendFactory(
      resolveConfig({ agents: { analyst: { network: "none", timeoutSeconds: 7 } } }),
      { listAgentIds: () => roster },
    );
    const handle = await createBackend({
      agentId: "analyst",
      sessionKey: "agent:analyst:main",
      scopeKey: "agent:analyst",
      workspaceDir: baseParams.workdir,
      agentWorkspaceDir: baseParams.workdir,
      cfg: createSandboxBackendTestConfig({ scope: "agent" }),
    });
    roster = [];
    const spec = await handle.buildExecSpec({ command: "echo admitted", env: {}, usePty: false });
    try {
      expect(decodePayload(spec.argv, { cleanupPayloadFile: false }).config).toMatchObject({
        process: { timeout: 7000 },
        network: { defaultPolicy: "block" },
      });
    } finally {
      await handle.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
      });
    }
  });

  test.each([3, 60])(
    "internal shell retains per-agent ceiling %i and blocks network",
    async (timeoutSeconds) => {
      const createBackend = createMxcSandboxBackendFactory(
        resolveConfig({ agents: { analyst: { network: "default", timeoutSeconds } } }),
        configuredRoster,
      );
      const handle = await createBackend({
        agentId: "analyst",
        sessionKey: "opaque-session",
        scopeKey: "opaque-scope",
        workspaceDir: baseParams.workdir,
        agentWorkspaceDir: baseParams.workdir,
        cfg: createSandboxBackendTestConfig(),
      });
      let payload: Record<string, unknown> | undefined;
      spawnCommandMock.mockImplementationOnce(async (argv: string[]) => {
        payload = decodeContainerConfig(argv);
        return { code: 0, termination: "exit", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      });
      await handle.runShellCommand({ script: "echo hello" });
      expect(payload).toMatchObject({
        process: { timeout: Math.min(30, timeoutSeconds) * 1000 },
        network: { defaultPolicy: "block" },
        processContainer: { capabilities: [] },
      });
      expect(spawnCommandMock).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ timeoutMs: Math.min(30, timeoutSeconds) * 1000 }),
      );
    },
  );

  test("snapshots selected agent policy layers across A/B/A and concurrent payloads", async () => {
    const grantA = mkdtempSync(path.join(tmpdir(), "mxc-agent-a-"));
    const grantDefault = mkdtempSync(path.join(tmpdir(), "mxc-agent-default-"));
    testDirs.push(grantA, grantDefault);
    const policyA = sandboxPolicyConfig({
      filesystem: { additionalReadonlyPaths: [grantA] },
      process: { timeoutSeconds: 4 },
    }).mxcPolicyPaths!;
    const defaultPaths = sandboxPolicyConfig({
      filesystem: { additionalReadonlyPaths: [grantDefault] },
      process: { timeoutSeconds: 9 },
    }).mxcPolicyPaths!;
    const config = resolveConfig({
      network: "default",
      mxcPolicyPaths: defaultPaths,
      agents: {
        analyst: { network: "none", timeoutSeconds: 7, mxcPolicyPaths: policyA },
        reviewer: { timeoutSeconds: 15, mxcPolicyPaths: [] },
      },
    });
    const createBackend = createMxcSandboxBackendFactory(config, configuredRoster);
    const create = (agentId: string) =>
      createBackend({
        agentId,
        sessionKey: "not-an-agent-key",
        scopeKey: "opaque-scope",
        workspaceDir: baseParams.workdir,
        agentWorkspaceDir: baseParams.workdir,
        cfg: createSandboxBackendTestConfig(),
      });
    const handles = await Promise.all([
      create("analyst"),
      create("reviewer"),
      create("analyst"),
      create("other"),
    ]);
    // Existing handles retain the loaded policy snapshot; a new malformed file fails closed.
    const policyAPath = policyA[0];
    assert.ok(policyAPath);
    writeFileSync(policyAPath, "not json");
    await expect(create("analyst")).rejects.toThrow();
    const specs = await Promise.all(
      handles.map((handle) =>
        handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false }),
      ),
    );
    try {
      const payloads = specs.map(
        (spec) => decodePayload(spec.argv, { cleanupPayloadFile: false }).config,
      );
      expect(new Set(payloads.map((payload) => payload.containerId)).size).toBe(4);
      for (const index of [0, 2]) {
        const payload = payloads[index];
        assert.ok(payload);
        expect(payload).toMatchObject({
          process: { timeout: 4000 },
          network: { defaultPolicy: "block" },
          lifecycle: { destroyOnExit: true },
        });
        expect(objectField(payload, "filesystem").readonlyPaths).toContain(grantA);
        expect(objectField(payload, "filesystem").readonlyPaths).not.toContain(grantDefault);
      }
      const reviewerPayload = payloads[1];
      const defaultPayload = payloads[3];
      assert.ok(reviewerPayload);
      assert.ok(defaultPayload);
      expect(reviewerPayload).toMatchObject({
        process: { timeout: 15000 },
        network: { defaultPolicy: "allow" },
      });
      expect(objectField(reviewerPayload, "filesystem").readonlyPaths).not.toContain(grantA);
      expect(objectField(reviewerPayload, "filesystem").readonlyPaths).not.toContain(grantDefault);
      expect(defaultPayload).toMatchObject({ process: { timeout: 9000 } });
      expect(objectField(defaultPayload, "filesystem").readonlyPaths).toContain(grantDefault);
      expect(config.agents?.reviewer?.mxcPolicyPaths).toEqual([]);
      const bridge = handles[0].createFsBridge?.({
        sandbox: {
          workspaceDir: baseParams.workdir,
          agentWorkspaceDir: baseParams.workdir,
          containerWorkdir: baseParams.workdir,
          containerName: handles[0].runtimeId,
          workspaceAccess: "rw",
          docker: { binds: [] },
          backend: handles[0],
        },
      });
      expect(bridge).toBeDefined();
      await expect(bridge?.readFile({ filePath: path.join(grantA, "data.txt") })).rejects.toThrow(
        /Path escapes sandbox root/,
      );
      await expect(
        bridge?.writeFile({ filePath: path.join(grantA, "data.txt"), data: "not permitted" }),
      ).rejects.toThrow(/Path escapes sandbox root/);
    } finally {
      await Promise.all(
        specs.map(async (spec, index) => {
          const handle = handles[index];
          assert.ok(handle);
          return handle.finalizeExec?.({
            status: "completed",
            exitCode: 0,
            timedOut: false,
            token: spec.finalizeToken,
          });
        }),
      );
    }
  });

  test("factory rejects missing identity, shared overrides and missing selected files before launch", async () => {
    const createBackend = createMxcSandboxBackendFactory(
      resolveConfig({
        agents: {
          analyst: { mxcPolicyPaths: [path.join(baseParams.workdir, "missing-policy.json")] },
        },
      }),
      configuredRoster,
    );
    const params = {
      sessionKey: "agent:analyst:main",
      scopeKey: "agent:analyst",
      workspaceDir: baseParams.workdir,
      agentWorkspaceDir: baseParams.workdir,
      cfg: createSandboxBackendTestConfig(),
    };
    await expect(createBackend(params)).rejects.toThrow(/canonical agentId/);
    await expect(
      createBackend({
        ...params,
        agentId: "analyst",
        cfg: createSandboxBackendTestConfig({ scope: "shared" }),
      }),
    ).rejects.toThrow(/shared sandbox scope/);
    await expect(createBackend({ ...params, agentId: "analyst" })).rejects.toThrow(
      /missing-policy/,
    );
    await expect(
      createBackend({
        ...params,
        agentId: "other",
        cfg: createSandboxBackendTestConfig({ scope: "shared" }),
      }),
    ).resolves.toBeDefined();
    expect(spawnCommandMock).not.toHaveBeenCalled();
  });

  test.each(["ro", "none"] as const)(
    "selected agent policy preserves private skill protection with workspaceAccess %s",
    async (workspaceAccess) => {
      const workdir = mkdtempSync(path.join(tmpdir(), "mxc-private-workspace-"));
      const agentWorkspaceDir = mkdtempSync(path.join(tmpdir(), "mxc-private-agent-"));
      testDirs.push(workdir, agentWorkspaceDir);
      const privateSkillRoot = path.join(workdir, "skills", "private-guide");
      mkdirSync(privateSkillRoot, { recursive: true });
      const createBackend = createMxcSandboxBackendFactory(
        resolveConfig({
          network: "default",
          timeoutSeconds: 120,
          agents: { analyst: { network: "none", timeoutSeconds: 7, mxcPolicyPaths: [] } },
        }),
        configuredRoster,
      );
      const handle = await createBackend({
        agentId: "analyst",
        sessionKey: "agent:analyst:private-task",
        scopeKey: "private-selection-scope",
        workspaceDir: workdir,
        agentWorkspaceDir,
        skillsWorkspaceDir: workdir,
        cfg: createSandboxBackendTestConfig({ scope: "agent", workspaceAccess }),
      });
      const spec = await handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false });
      try {
        const payload = decodePayload(spec.argv, { cleanupPayloadFile: false }).config;
        expect(payload).toMatchObject({
          process: { timeout: 7000 },
          network: { defaultPolicy: "block" },
        });
        const filesystem = objectField(payload, "filesystem");
        const readonlyPaths = stringArrayField(filesystem, "readonlyPaths");
        const writablePaths = stringArrayField(filesystem, "readwritePaths");
        expect(readonlyPaths.some((root) => isPathInside(root, privateSkillRoot))).toBe(true);
        expect(writablePaths.some((root) => isPathInside(root, privateSkillRoot))).toBe(false);
        expect(spawnCommandMock).not.toHaveBeenCalled();
      } finally {
        await handle.finalizeExec?.({
          status: "completed",
          exitCode: 0,
          timedOut: false,
          token: spec.finalizeToken,
        });
      }
    },
  );

  test("selected agent policy carries protected skill workspace context into the exec guard", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "mxc-factory-workspace-"));
    const skillsWorkspaceDir = mkdtempSync(path.join(tmpdir(), "mxc-factory-skills-"));
    try {
      mkdirSync(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
      mkdirSync(path.join(workdir, ".openclaw", "sandbox-skills", "skills", "demo"), {
        recursive: true,
      });
      const createBackend = createMxcSandboxBackendFactory(
        resolveConfig({
          agents: { analyst: { network: "none", timeoutSeconds: 7, mxcPolicyPaths: [] } },
        }),
        configuredRoster,
      );
      const handle = await createBackend({
        agentId: "analyst",
        sessionKey: "agent:analyst:private-task",
        scopeKey: "private-selection-scope",
        workspaceDir: workdir,
        agentWorkspaceDir: workdir,
        skillsWorkspaceDir,
        cfg: createSandboxBackendTestConfig({ scope: "agent", workspaceAccess: "rw" }),
      });

      await expect(
        handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false }),
      ).rejects.toThrow(/overlaps read-only path/u);
      expect(spawnCommandMock).not.toHaveBeenCalled();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(skillsWorkspaceDir, { recursive: true, force: true });
    }
  });

  test("factory rejects unsupported Docker bind mounts", async () => {
    const createBackend = createMxcSandboxBackendFactory(baseConfig, configuredRoster);
    const cfg = createSandboxBackendTestConfig({
      workspaceAccess: "none",
      docker: {
        ...createSandboxBackendTestConfig().docker,
        binds: ["/host/path:/workspace/path:ro"],
      },
    });

    await expect(
      createBackend({
        sessionKey: "agent:main:main",
        scopeKey: "mxc-test",
        workspaceDir: baseParams.workdir,
        agentWorkspaceDir: baseParams.workdir,
        cfg,
      }),
    ).rejects.toThrow(/does not support sandbox\.docker\.binds/u);
  });
});
