import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { warnMxcHostPrepIfNeeded } from "../src/readiness.js";

const SYSTEM32 = path.win32.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
);
const ICACLS = path.win32.join(SYSTEM32, "icacls.exe");

function depsFor(params: { systemDriveAcl?: string }) {
  const systemDriveAcl =
    params.systemDriveAcl ?? "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n    S-1-15-2-1:(R)\n";
  const exec = vi.fn((command: string) => {
    if (command === ICACLS) {
      return systemDriveAcl;
    }
    throw new Error(`unexpected command: ${command}`);
  }) as unknown as typeof execFileSync;
  return { execFileSync: exec };
}

describe("warnMxcHostPrepIfNeeded", () => {
  test("is a no-op on non-Windows platforms", () => {
    const warn = vi.fn();
    const deps = depsFor({});

    warnMxcHostPrepIfNeeded({ platform: "linux", deps, warn });
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns when the system drive lacks AppContainer ACEs", () => {
    const warn = vi.fn();
    const deps = depsFor({
      systemDriveAcl: "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n",
    });

    warnMxcHostPrepIfNeeded({ platform: "win32", deps, warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/prepare-system-drive/u);
  });

  test("stays silent when the system drive is prepared (SID form)", () => {
    const warn = vi.fn();
    const deps = depsFor({});

    warnMxcHostPrepIfNeeded({ platform: "win32", deps, warn });
    expect(warn).not.toHaveBeenCalled();
  });

  test("stays silent when the system drive is prepared (display-name form)", () => {
    const warn = vi.fn();
    const deps = depsFor({
      systemDriveAcl: "C:\\ APPLICATION PACKAGES:(R)\n    BUILTIN\\Administrators:(F)\n",
    });

    warnMxcHostPrepIfNeeded({ platform: "win32", deps, warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
