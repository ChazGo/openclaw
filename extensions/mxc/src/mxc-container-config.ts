import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import type { ContainerConfig } from "@microsoft/mxc-sdk";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";
import type { MxcConfig } from "./config.js";
import { resolveBaselineReadonlyPaths, type BaselineHostEnv } from "./sandbox-baseline.js";
import type { MxcSandboxConfigurationEnvelope } from "./sandbox-configuration-types.js";
import type {
  LoadedSandboxBaselinePolicy,
  SandboxConfiguredPathEntry,
} from "./sandbox-policy-loader.js";
import { buildCommandLine } from "./windows-command.js";
import { normalizeWindowsProcessEnvRecord } from "./windows-env.js";
import {
  resolveMxcReadOnlySkillMounts,
  type MxcReadOnlySkillMount,
  type MxcWorkspaceAccess,
} from "./workspace-skill-mounts.js";

const MXC_SCHEMA_VERSION = "0.7.0-alpha";
const PROCESS_CONTAINER_NAME_MAX_LEN = 64;

type MxcFilesystemConfig = NonNullable<ContainerConfig["filesystem"]>;

type FilesystemPathSpec = {
  path: string;
  required: boolean;
  sources?: readonly string[];
};

type BaselineApplicationContext = {
  projectDir: string;
  hostEnv: BaselineHostEnv;
};

type MxcWorkspaceContext = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  activeWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: MxcWorkspaceAccess;
};

export function resolveCurrentBaselineContext(projectDir: string): BaselineApplicationContext {
  return {
    projectDir: path.resolve(projectDir),
    hostEnv: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ProgramFiles: process.env.ProgramFiles,
      ProgramW6432: process.env.ProgramW6432,
      "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  };
}

export function resolveMxcWorkspaceContext(params: {
  workdir: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: MxcWorkspaceAccess;
}): MxcWorkspaceContext {
  const workspaceAccess = params.workspaceAccess ?? "rw";
  const workspaceDir = path.resolve(params.workdir);
  const agentWorkspaceDir = path.resolve(params.agentWorkspaceDir ?? params.workdir);
  return {
    workspaceDir,
    agentWorkspaceDir,
    activeWorkspaceDir: workspaceAccess === "rw" ? agentWorkspaceDir : workspaceDir,
    ...(params.skillsWorkspaceDir
      ? { skillsWorkspaceDir: path.resolve(params.skillsWorkspaceDir) }
      : {}),
    workdir: workspaceDir,
    workspaceAccess,
  };
}

export function resolveMxcRuntimeWorkdir(
  workspace: MxcWorkspaceContext,
  requestedWorkdir: string,
): string {
  if (workspace.workspaceAccess !== "rw") {
    return path.resolve(requestedWorkdir);
  }

  const relativePath = path.relative(workspace.workspaceDir, requestedWorkdir);
  return relativePath === ""
    ? workspace.activeWorkspaceDir
    : path.join(workspace.activeWorkspaceDir, relativePath);
}

export function buildMxcContainerConfig(params: {
  config: MxcConfig;
  baseline: LoadedSandboxBaselinePolicy;
  baselineContext: BaselineApplicationContext;
  runtimeId: string;
  containerId: string;
  command: string;
  args?: readonly string[];
  sandboxTempDir: string;
  workdir: string;
  workspace: MxcWorkspaceContext;
  protectedStateDir?: string;
  env: Record<string, string>;
  sandboxConfigurationEnvelope?: MxcSandboxConfigurationEnvelope;
}): ContainerConfig {
  const networkAllowed =
    params.config.network === "default" &&
    params.sandboxConfigurationEnvelope?.networkEnabled !== false;
  const localNetworkAllowed = false;
  assertSandboxConfigurationDoesNotWidenNetwork(params.sandboxConfigurationEnvelope, {
    networkAllowed,
    localNetworkAllowed,
  });
  const filesystem = buildFilesystemConfig({
    baseline: params.baseline,
    context: params.baselineContext,
    sandboxTempDir: params.sandboxTempDir,
    workspace: params.workspace,
    ...(params.protectedStateDir ? { protectedStateDir: params.protectedStateDir } : {}),
    sandboxConfigurationEnvelope: params.sandboxConfigurationEnvelope,
  });

  const processEnv = normalizeWindowsProcessEnvRecord({
    ...params.env,
    TEMP: params.sandboxTempDir,
    TMP: params.sandboxTempDir,
  });

  return {
    version: MXC_SCHEMA_VERSION,
    containerId: params.containerId,
    containment: params.config.containment,
    lifecycle: { destroyOnExit: true },
    process: {
      commandLine: buildCommandLine(params.command, params.args ?? []),
      cwd: resolveProcessCwd(params.workdir),
      env: processEnv,
      timeout:
        resolveProcessTimeoutSeconds(
          params.config,
          params.baseline,
          params.sandboxConfigurationEnvelope,
        ) * 1000,
    },
    filesystem,
    ui: {
      disable: true,
      clipboard: "none",
      injection: false,
    },
    network: {
      defaultPolicy: networkAllowed ? "allow" : "block",
      enforcementMode: "capabilities",
    },
    processContainer: {
      name: processContainerName(params.runtimeId),
      leastPrivilege: true,
      capabilities: resolveProcessCapabilities(params.sandboxConfigurationEnvelope, {
        networkAllowed,
        localNetworkAllowed,
      }),
      ui: {
        isolation: "container",
        desktopSystemControl: false,
        systemSettings: "none",
        ime: false,
      },
    },
  };
}

function buildFilesystemConfig(params: {
  baseline: LoadedSandboxBaselinePolicy;
  context: BaselineApplicationContext;
  sandboxTempDir: string;
  workspace: MxcWorkspaceContext;
  protectedStateDir?: string;
  sandboxConfigurationEnvelope?: MxcSandboxConfigurationEnvelope;
}): MxcFilesystemConfig {
  const readwritePathSpecs = resolveWorkspaceReadwritePathSpecs(params.workspace);
  const requiredReadwritePathSpecs: FilesystemPathSpec[] = [];
  const readonlyPathSpecs = [
    ...resolveWorkspaceReadonlyPathSpecs(params.workspace),
    ...resolveBaselineReadonlyPathSpecs(params.baseline, params.context),
    ...resolveProtectedSkillPolicyPathSpecs(params.workspace),
  ];

  if (params.baseline.filesystem.restrictToProjectDir) {
    const projectDirPath = params.context.projectDir;
    if (params.workspace.workspaceAccess === "rw") {
      readwritePathSpecs.push(requiredFilesystemPath(projectDirPath));
    } else {
      readonlyPathSpecs.push(requiredFilesystemPath(projectDirPath));
    }
    requiredReadwritePathSpecs.push(requiredFilesystemPath(path.resolve(params.sandboxTempDir)));
    readwritePathSpecs.push(
      ...params.baseline.configuredPaths.readwritePaths.map(createConfiguredFilesystemPath),
    );
  }

  const protectedSkillPolicyPaths = resolveMxcProtectedSkillPolicyPaths(params.workspace);
  // ProcessContainer writable-parent grants override nested read-only grants.
  // Fail closed instead of claiming protected skill overlays are enforceable.
  const requiredReadwritePaths = resolveExistingFilesystemPaths(
    requiredReadwritePathSpecs,
    "readwrite",
  );
  const readwritePaths = resolveExistingFilesystemPaths(readwritePathSpecs, "readwrite");
  assertNoMxcReadwriteReadonlyOverlap({
    readwritePaths: [...requiredReadwritePaths, ...readwritePaths],
    readonlyPaths: protectedSkillPolicyPaths,
  });

  const readonlyPaths = resolveExistingFilesystemPaths(readonlyPathSpecs, "read-only");
  const effectiveFilesystem = composeSandboxConfigurationFilesystem({
    deniedPaths: [
      ...(params.protectedStateDir ? [path.resolve(params.protectedStateDir)] : []),
      ...(params.sandboxConfigurationEnvelope?.deniedPaths ?? []),
    ],
    readonlyPaths,
    configurationReadonlyPaths: params.sandboxConfigurationEnvelope?.readonlyPaths ?? [],
    requiredReadwritePaths,
    readwritePaths,
    configurationReadwritePaths: params.sandboxConfigurationEnvelope?.readwritePaths,
  });
  assertNoMxcReadwriteReadonlyOverlap(effectiveFilesystem);
  assertNoMxcGrantedDeniedOverlap(effectiveFilesystem);

  return {
    readonlyPaths: effectiveFilesystem.readonlyPaths,
    deniedPaths:
      effectiveFilesystem.deniedPaths.length > 0 ? effectiveFilesystem.deniedPaths : undefined,
    readwritePaths: effectiveFilesystem.readwritePaths,
    clearPolicyOnExit: true,
  };
}

function resolveWorkspaceReadwritePathSpecs(workspace: MxcWorkspaceContext): FilesystemPathSpec[] {
  if (workspace.workspaceAccess !== "rw") {
    return [];
  }
  return [requiredFilesystemPath(workspace.activeWorkspaceDir)];
}

function resolveWorkspaceReadonlyPathSpecs(workspace: MxcWorkspaceContext): FilesystemPathSpec[] {
  if (workspace.workspaceAccess === "rw") {
    return [];
  }

  const readonlyPathSpecs = [requiredFilesystemPath(workspace.workspaceDir)];
  if (
    workspace.workspaceAccess === "ro" &&
    normalizePathForComparison(workspace.agentWorkspaceDir) !==
      normalizePathForComparison(workspace.workspaceDir)
  ) {
    readonlyPathSpecs.push(requiredFilesystemPath(workspace.agentWorkspaceDir));
  }
  return readonlyPathSpecs;
}

function resolveBaselineReadonlyPathSpecs(
  baseline: LoadedSandboxBaselinePolicy,
  context: BaselineApplicationContext,
): FilesystemPathSpec[] {
  return [
    ...resolveBaselineReadonlyPaths(context.hostEnv).map((candidatePath) =>
      optionalFilesystemPath(path.resolve(candidatePath)),
    ),
    ...baseline.configuredPaths.readonlyPaths.map(createConfiguredFilesystemPath),
  ];
}

function resolveMxcProtectedSkillPolicyPaths(context: MxcWorkspaceContext): string[] {
  const deduped = new Map<string, string>();
  for (const mount of resolveMxcProtectedSkillMounts(context)) {
    const hostPath = path.resolve(mount.hostPath);
    deduped.set(normalizePathForComparison(hostPath), hostPath);
    const containerPath = path.resolve(mount.containerPath);
    deduped.set(normalizePathForComparison(containerPath), containerPath);
  }
  return [...deduped.values()];
}

function resolveProtectedSkillPolicyPathSpecs(context: MxcWorkspaceContext): FilesystemPathSpec[] {
  return resolveMxcProtectedSkillPolicyPaths(context).map((candidatePath) =>
    optionalFilesystemPath(candidatePath),
  );
}

function resolveMxcProtectedSkillMounts(
  context: MxcWorkspaceContext,
): readonly MxcReadOnlySkillMount[] {
  return resolveMxcReadOnlySkillMounts({
    agentWorkspaceDir: context.agentWorkspaceDir,
    skillsWorkspaceDir: context.skillsWorkspaceDir,
    workdir: context.workdir,
    workspaceAccess: context.workspaceAccess,
  });
}

function resolveExistingFilesystemPaths(
  pathSpecs: readonly FilesystemPathSpec[],
  accessLabel: "denied" | "read-only" | "readwrite",
): string[] {
  const deduped = new Map<
    string,
    {
      path: string;
      required: boolean;
      sources: Set<string>;
    }
  >();

  for (const pathSpec of pathSpecs) {
    const key = normalizePathForComparison(pathSpec.path);
    const existing = deduped.get(key);
    if (existing) {
      existing.required ||= pathSpec.required;
      for (const source of pathSpec.sources ?? []) {
        existing.sources.add(source);
      }
      continue;
    }

    deduped.set(key, {
      path: pathSpec.path,
      required: pathSpec.required,
      sources: new Set(pathSpec.sources ?? []),
    });
  }

  const resolvedPaths: string[] = [];
  for (const pathSpec of deduped.values()) {
    if (hostPathExists(pathSpec.path)) {
      resolvedPaths.push(pathSpec.path);
      continue;
    }
    if (!pathSpec.required) {
      continue;
    }
    throw new Error(
      buildMissingFilesystemPathMessage(pathSpec.path, accessLabel, pathSpec.sources),
    );
  }
  return resolvedPaths;
}

function requiredFilesystemPath(pathValue: string): FilesystemPathSpec {
  return {
    path: path.resolve(pathValue),
    required: true,
  };
}

function optionalFilesystemPath(pathValue: string): FilesystemPathSpec {
  return {
    path: path.resolve(pathValue),
    required: false,
  };
}

function createConfiguredFilesystemPath(pathEntry: SandboxConfiguredPathEntry): FilesystemPathSpec {
  return {
    path: path.resolve(pathEntry.path),
    required: true,
    sources: pathEntry.sources,
  };
}

function buildMissingFilesystemPathMessage(
  pathValue: string,
  accessLabel: "denied" | "read-only" | "readwrite",
  sources: ReadonlySet<string>,
): string {
  const sourceLabel = [...sources].join(", ");
  if (sourceLabel) {
    return (
      `MXC sandbox ${accessLabel} path ${pathValue} configured by ${sourceLabel} ` +
      `is missing on the host. Recreate the path or update the policy file before launching the sandbox.`
    );
  }
  return `MXC sandbox ${accessLabel} path ${pathValue} does not exist on the host.`;
}

function processContainerName(runtimeId: string): string {
  if (runtimeId.length <= PROCESS_CONTAINER_NAME_MAX_LEN) {
    return runtimeId;
  }
  const hash = createHash("sha256").update(runtimeId).digest("hex").slice(0, 8);
  return `${runtimeId.slice(0, PROCESS_CONTAINER_NAME_MAX_LEN - hash.length - 1)}-${hash}`;
}

function resolveProcessCwd(workdir: string): string {
  return workdir;
}

function resolveProcessTimeoutSeconds(
  config: MxcConfig,
  baseline: LoadedSandboxBaselinePolicy,
  sandboxConfigurationEnvelope?: MxcSandboxConfigurationEnvelope,
): number {
  const configuredTimeout =
    config.timeoutSecondsConfigured === true
      ? Math.min(config.timeoutSeconds, baseline.process.timeoutSeconds)
      : baseline.process.timeoutSeconds;
  return sandboxConfigurationEnvelope?.timeoutSeconds === undefined
    ? configuredTimeout
    : Math.min(configuredTimeout, sandboxConfigurationEnvelope.timeoutSeconds);
}

function assertNoMxcReadwriteReadonlyOverlap(params: {
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
}): void {
  for (const readwritePath of params.readwritePaths) {
    for (const readonlyPath of params.readonlyPaths) {
      if (pathsOverlap(readwritePath, readonlyPath)) {
        throw new Error(
          `MXC readwrite path ${readwritePath} overlaps read-only path ${readonlyPath}. Windows MXC cannot safely enforce nested read-only overlays under writable paths.`,
        );
      }
    }
  }
}

type EffectiveSandboxConfigurationFilesystem = {
  deniedPaths: string[];
  readonlyPaths: string[];
  readwritePaths: string[];
};

function composeSandboxConfigurationFilesystem(params: {
  deniedPaths: readonly string[];
  readonlyPaths: readonly string[];
  configurationReadonlyPaths: readonly string[];
  requiredReadwritePaths: readonly string[];
  readwritePaths: readonly string[];
  configurationReadwritePaths: readonly string[] | undefined;
}): EffectiveSandboxConfigurationFilesystem {
  const deniedPaths = resolveSandboxConfigurationPaths(params.deniedPaths, "denied");
  const readonlyPaths = [...params.readonlyPaths];
  const configurationReadwritePaths =
    params.configurationReadwritePaths === undefined
      ? undefined
      : resolveSandboxConfigurationPaths(params.configurationReadwritePaths, "readwrite");
  const readwritePaths = [
    ...params.requiredReadwritePaths,
    ...params.readwritePaths,
    ...(configurationReadwritePaths ?? []),
  ];

  for (const candidate of resolveSandboxConfigurationPaths(
    params.configurationReadonlyPaths,
    "read-only",
  )) {
    if (readonlyPaths.some((grant) => pathContains(grant, candidate))) {
      continue;
    }
    const effectiveWritableParent = readwritePaths.find((grant) => pathContains(grant, candidate));
    if (effectiveWritableParent && !samePath(effectiveWritableParent, candidate)) {
      throw new Error(
        `MXC sandbox configuration read-only path ${candidate} is nested under writable path ${effectiveWritableParent}; MXC cannot safely enforce that overlay`,
      );
    }
    if (effectiveWritableParent) {
      readwritePaths.splice(readwritePaths.indexOf(effectiveWritableParent), 1);
    }
    readonlyPaths.push(candidate);
  }

  for (const deniedPath of deniedPaths) {
    for (const grant of [...readonlyPaths, ...readwritePaths]) {
      if (pathContains(grant, deniedPath) && !samePath(grant, deniedPath)) {
        throw new Error(
          `MXC sandbox configuration denied path ${deniedPath} is nested under granted path ${grant}; MXC cannot safely enforce that overlay`,
        );
      }
    }
    removeContainedPaths(readonlyPaths, deniedPath);
    removeContainedPaths(readwritePaths, deniedPath);
  }

  return {
    deniedPaths: dedupeSandboxConfigurationPaths(deniedPaths),
    readonlyPaths: dedupeSandboxConfigurationPaths(readonlyPaths),
    readwritePaths: dedupeSandboxConfigurationPaths(readwritePaths),
  };
}

function resolveSandboxConfigurationPaths(
  values: readonly string[],
  accessLabel: "denied" | "read-only" | "readwrite",
): string[] {
  return resolveExistingFilesystemPaths(
    values.map((value) => requiredFilesystemPath(value)),
    accessLabel,
  );
}

function removeContainedPaths(values: string[], parent: string): void {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value && pathContains(parent, value)) {
      values.splice(index, 1);
    }
  }
}

function assertNoMxcGrantedDeniedOverlap(params: EffectiveSandboxConfigurationFilesystem): void {
  for (const deniedPath of params.deniedPaths) {
    for (const grantedPath of [...params.readonlyPaths, ...params.readwritePaths]) {
      if (pathsOverlap(deniedPath, grantedPath)) {
        throw new Error(`MXC denied path ${deniedPath} overlaps granted path ${grantedPath}`);
      }
    }
  }
}

function resolveProcessCapabilities(
  envelope: MxcSandboxConfigurationEnvelope | undefined,
  floor: { networkAllowed: boolean; localNetworkAllowed: boolean },
): string[] {
  const floorCapabilities = [
    ...(floor.networkAllowed ? ["internetClient"] : []),
    ...(floor.localNetworkAllowed ? ["privateNetworkClientServer"] : []),
  ];
  if (envelope?.capabilities === undefined) {
    return floorCapabilities;
  }
  for (const requested of envelope.capabilities) {
    if (
      (requested === "internetClient" || requested === "internetClientServer") &&
      !floor.networkAllowed
    ) {
      throw new Error(
        `MXC sandbox configuration ${requested} capability conflicts with blocked network`,
      );
    }
    if (requested === "privateNetworkClientServer" && !floor.localNetworkAllowed) {
      throw new Error(
        "MXC sandbox configuration privateNetworkClientServer capability conflicts with blocked local network",
      );
    }
    if (requested === "internetClientServer") {
      throw new Error(
        "MXC sandbox configuration internetClientServer capability exceeds the outbound-only network baseline",
      );
    }
  }
  return [...new Set([...floorCapabilities, ...envelope.capabilities])];
}

function assertSandboxConfigurationDoesNotWidenNetwork(
  envelope: MxcSandboxConfigurationEnvelope | undefined,
  floor: { networkAllowed: boolean; localNetworkAllowed: boolean },
): void {
  if (envelope?.networkEnabled === true && !floor.networkAllowed) {
    throw new Error("MXC sandbox configuration network access exceeds the MXC floor");
  }
  if (envelope?.allowLocalNetwork === true && !floor.localNetworkAllowed) {
    throw new Error("MXC sandbox configuration local-network access exceeds the MXC floor");
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const left = normalizePathForComparison(first);
  const right = normalizePathForComparison(second);
  return isPathInside(left, right) || isPathInside(right, left);
}

function pathContains(parent: string, child: string): boolean {
  const parentPath = normalizePathForComparison(parent);
  const childPath = normalizePathForComparison(child);
  return isPathInside(parentPath, childPath);
}

function samePath(first: string, second: string): boolean {
  return normalizePathForComparison(first) === normalizePathForComparison(second);
}

function dedupeSandboxConfigurationPaths(values: readonly string[]): string[] {
  const deduped = new Map<string, string>();
  for (const value of values) {
    deduped.set(normalizePathForComparison(value), value);
  }
  return [...deduped.values()];
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function hostPathExists(candidatePath: string): boolean {
  try {
    statSync(candidatePath);
    return true;
  } catch (err) {
    if (isNodeError(err)) {
      return false;
    }
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
