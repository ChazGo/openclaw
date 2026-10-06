import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

async function importTrustedIntegrity() {
  vi.resetModules();
  vi.stubGlobal("OPENCLAW_LOCAL_TRUSTED_INSTALL", true);
  return await import("./package-update-integrity.js");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("local trusted-install package integrity", () => {
  it("is off unless the build defines it", async () => {
    vi.resetModules();
    const { LOCAL_TRUSTED_INSTALL } = await import("./local-trusted-install.js");
    expect(LOCAL_TRUSTED_INSTALL).toBe(false);
  });

  it("fingerprints package trees by stat identity without hashing file bytes", async () => {
    await withTestDir({ prefix: "openclaw-trusted-integrity-" }, async (base) => {
      const { createPackageIntegrityReader } = await importTrustedIntegrity();
      const { packageRoot } = await createPackageSwapFixture(base);
      const open = vi.spyOn(fs, "open");
      const reader = createPackageIntegrityReader();
      const first = await reader.tree(packageRoot);
      // Only the version read opens a package file; no file is hashed.
      expect(
        open.mock.calls
          .map(([file]) => String(file))
          .filter((file) => file.startsWith(`${packageRoot}${path.sep}`)),
      ).toEqual([path.join(packageRoot, "package.json")]);
      expect(await reader.tree(packageRoot)).toEqual(first);

      const marker = path.join(packageRoot, "dist", "trusted-marker.js");
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, "export {};\n");
      expect((await reader.tree(packageRoot)).digest).not.toBe(first.digest);
    });
  });

  it("still refuses a copy whose file sizes differ from the source", async () => {
    await withTestDir({ prefix: "openclaw-trusted-copy-" }, async (base) => {
      const { createPackageIntegrityReader } = await importTrustedIntegrity();
      const { packageRoot } = await createPackageSwapFixture(base);
      const copyRoot = path.join(base, "copy");
      await fs.cp(packageRoot, copyRoot, { recursive: true });
      const reader = createPackageIntegrityReader();
      const source = await reader.tree(packageRoot);
      await expect(reader.copiedTree(copyRoot, packageRoot, source)).resolves.toMatchObject({
        version: source.version,
      });

      await fs.appendFile(path.join(copyRoot, "package.json"), "\n");
      await expect(reader.copiedTree(copyRoot, packageRoot, source)).rejects.toThrow(
        "Package copy inventory does not match the original package.",
      );
    });
  });
});
