import { describe, expect, test, vi } from "vitest";
import { resolveWindowsStandardFolders } from "../src/windows-known-folders.js";

const DOWNLOADS_VALUE = "{374DE290-123F-4565-9164-39C4925E467B}";

function registryOutput(valueName: string, value: string): string {
  return [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
    `    ${valueName}    REG_EXPAND_SZ    ${value}`,
    "",
  ].join("\r\n");
}

describe("resolveWindowsStandardFolders", () => {
  test("resolves redirected folders for the current Windows identity", () => {
    const values: Record<string, string> = {
      Personal: "%OneDrive%\\Documents",
      [DOWNLOADS_VALUE]: "D:\\Downloads",
      Desktop: "%USERPROFILE%\\Desktop",
    };

    expect(
      resolveWindowsStandardFolders({
        platform: "win32",
        env: {
          OneDrive: "C:\\Users\\Agent\\OneDrive - Microsoft",
          USERPROFILE: "C:\\Users\\Agent",
        },
        queryRegistryValue: (valueName) => {
          const value = values[valueName];
          if (!value) {
            throw new Error(`missing fixture for ${valueName}`);
          }
          return registryOutput(valueName, value);
        },
        warn: vi.fn(),
      }),
    ).toEqual({
      documents: "C:\\Users\\Agent\\OneDrive - Microsoft\\Documents",
      downloads: "D:\\Downloads",
      desktop: "C:\\Users\\Agent\\Desktop",
    });
  });

  test("omits unresolved or malformed folders with a warning", () => {
    const warn = vi.fn();

    expect(
      resolveWindowsStandardFolders({
        platform: "win32",
        env: { USERPROFILE: "C:\\Users\\Agent" },
        queryRegistryValue: (valueName) => {
          if (valueName === "Personal") {
            return registryOutput(valueName, "%MISSING%\\Documents");
          }
          if (valueName === DOWNLOADS_VALUE) {
            return registryOutput(valueName, "Downloads");
          }
          return `    ${valueName}    REG_BINARY    00`;
        },
        warn,
      }),
    ).toEqual({
      documents: undefined,
      downloads: undefined,
      desktop: undefined,
    });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  test("returns no standard-folder grants outside Windows", () => {
    expect(resolveWindowsStandardFolders({ platform: "linux" })).toEqual({});
  });
});
