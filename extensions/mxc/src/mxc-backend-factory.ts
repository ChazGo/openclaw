import { createHash } from "node:crypto";
import type { CreateSandboxBackendParams, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import {
  assertMxcAgentOverridesConfigured,
  resolveMxcAgentConfig,
  type MxcConfig,
} from "./config.js";
import { createMxcSandboxBackendHandle } from "./mxc-backend.js";

function sanitizeRuntimeId(value: string): string {
  if (/:workspace:[a-f0-9]{32}$/i.test(value.trim())) {
    const hash = createHash("sha256").update(value).digest("hex").slice(0, 32);
    return `openclaw-mxc-workspace-${hash}`;
  }
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `openclaw-mxc-${slug || "sandbox"}-${hash}`;
}

export type MxcSandboxBackendFactoryOptions = {
  /** Read the live configured agent roster; called once per backend creation. */
  listAgentIds: () => readonly string[];
  assertRegistrationCurrent?: () => void;
};

/** Factory function called by OpenClaw when sandbox.backend=mxc. */
export function createMxcSandboxBackendFactory(
  config: MxcConfig,
  { listAgentIds, assertRegistrationCurrent }: MxcSandboxBackendFactoryOptions,
) {
  return async function createMxcSandboxBackend(
    params: CreateSandboxBackendParams,
  ): Promise<SandboxBackendHandle> {
    const assertHostCurrent = params.assertRuntimeCurrent;
    const assertRuntimeCurrent = () => {
      assertRegistrationCurrent?.();
      assertHostCurrent?.();
    };
    assertRuntimeCurrent();
    assertMxcAgentOverridesConfigured(config, listAgentIds());
    const agentConfig = resolveMxcAgentConfig(config, params.agentId, params.cfg.scope);
    if ((params.cfg.docker.binds?.length ?? 0) > 0) {
      throw new Error("MXC sandbox backend does not support sandbox.docker.binds.");
    }
    const runtimeId = sanitizeRuntimeId(params.scopeKey);
    return createMxcSandboxBackendHandle({
      config: agentConfig,
      assertRuntimeCurrent,
      runtimeId,
      workdir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir,
      ...(params.skillsWorkspaceDir ? { skillsWorkspaceDir: params.skillsWorkspaceDir } : {}),
      workspaceAccess: params.cfg.workspaceAccess,
    });
  };
}
