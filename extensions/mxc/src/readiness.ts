import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { resolveMxcLauncherPath } from "./plugin-root.js";
import { buildLauncherEnv } from "./windows-env.js";

const MxcLauncherProbeSchema = z.object({
  probe: z.object({
    tier: z.enum(["base-container", "appcontainer-bfs", "appcontainer-dacl"]).optional(),
    warnings: z.array(z.string()).default([]),
    error: z.string().optional(),
  }),
});

function resolveWindowsSystemExecutable(name: string): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  return path.win32.join(systemRoot || "C:\\Windows", "System32", name);
}

// The probe runs in the launcher, with the same pinned `mxc_ffi` that executes
// commands. A probe can succeed without selecting a tier; only a selected and
// admitted tier means this host can run MXC sandboxes.
function probeMxcIsolationTier(nativeEnv: Record<string, string>): {
  tier: string;
  warnings: string[];
} {
  const notReady = (reason: string, cause?: unknown) =>
    new Error(
      `[mxc] MXC Windows ProcessContainer sandbox is not ready: ${reason}. ` +
        `The plugin probes the host through @microsoft/mxc-sdk 1.0 with the native ` +
        `components in ${nativeEnv.MXC_FFI_DIR}. If mxcBinaryPath is set, it must point ` +
        `to an MXC 1.0 release layout; otherwise unset ` +
        `plugins.entries.mxc.config.mxcBinaryPath and restart the Gateway to use the ` +
        `bundled SDK components.`,
      cause === undefined ? undefined : { cause },
    );
  let output: string;
  try {
    output = execFileSync(process.execPath, [resolveMxcLauncherPath(), "--probe"], {
      encoding: "utf-8",
      env: buildLauncherEnv(nativeEnv),
      stdio: "pipe",
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message.trim()}` : "";
    throw notReady(`the MXC host check failed${detail}`, error);
  }
  let probe: unknown;
  try {
    probe = JSON.parse(output);
  } catch (error) {
    throw notReady("the MXC host check did not return JSON", error);
  }
  const parsed = MxcLauncherProbeSchema.safeParse(probe);
  if (!parsed.success) {
    throw notReady("the MXC host check returned an unexpected result", parsed.error);
  }
  const { probe: result } = parsed.data;
  if (!result.tier) {
    const reason = result.error || "the check reported no isolation tier";
    throw notReady(`MXC cannot select an isolation tier on this host (${reason})`);
  }
  return { tier: result.tier, warnings: result.warnings };
}

// AppContainer processes need directory-traversal/list rights on the system
// drive root (C:\) to enumerate directories inside the sandbox.
// `wxc-host-prep prepare-system-drive` adds ACEs for the well-known
// ALL APPLICATION PACKAGES (S-1-15-2-1) and ALL RESTRICTED APPLICATION PACKAGES
// (S-1-15-2-2) SIDs. Without this, directory listing (e.g. `dir`) inside the
// sandbox fails with "Access is denied". This is advisory: the sandbox still
// runs basic cmd.exe read/write workloads without it, so a missing grant warns
// rather than blocking activation.
function isSystemDrivePrepared(): boolean {
  const systemDrive = process.env.SystemDrive || "C:";
  let output: string;
  try {
    output = execFileSync(resolveWindowsSystemExecutable("icacls.exe"), [`${systemDrive}\\`], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    // If icacls itself fails, assume prepared rather than emitting a spurious
    // warning on a host we cannot probe.
    return true;
  }
  // Look for the well-known ALL APPLICATION PACKAGES SID (S-1-15-2-1) or its
  // display name. Both forms can appear depending on OS locale/version.
  return output.includes("S-1-15-2-1") || output.includes("APPLICATION PACKAGES");
}

function systemDrivePrepWarning(systemDrive: string): string {
  return (
    `[mxc] MXC sandbox host preparation incomplete: the system drive root (${systemDrive}\\) ` +
    `does not grant directory access to AppContainer processes, so directory listing ` +
    `(e.g. \`dir\`) inside the sandbox will fail with "Access is denied". Basic read/write ` +
    `workloads still run.\n` +
    `Fix (one-time, elevated): wxc-host-prep prepare-system-drive (ships with @microsoft/mxc-sdk).`
  );
}

/**
 * Emits an advisory warning when the system drive is not prepared for
 * AppContainer directory access. Non-fatal: the sandbox still activates.
 */
export function warnMxcHostPrepIfNeeded(): void {
  if (process.platform !== "win32") {
    return;
  }
  if (!isSystemDrivePrepared()) {
    console.warn(systemDrivePrepWarning(process.env.SystemDrive || "C:"));
  }
}

/**
 * Fails plugin activation unless MXC's host probe, run with the pinned native
 * components, selects an admitted isolation tier. Degradation warnings from the
 * probe are reported but do not block activation.
 */
export function assertMxcReadiness(params: { nativeEnv: Record<string, string> }): void {
  if (process.platform !== "win32") {
    return;
  }
  const probe = probeMxcIsolationTier(params.nativeEnv);
  if (probe.warnings.length > 0) {
    console.warn(
      `[mxc] MXC sandbox is using the ${probe.tier} isolation tier: ${probe.warnings.join("; ")}`,
    );
  }
}
