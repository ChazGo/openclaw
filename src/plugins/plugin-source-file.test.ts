import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import {
  hashPluginSourceFile,
  resolvePluginSourceRealPath,
  withPluginSourcePathScope,
} from "./plugin-source-file.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

function countRealpathCalls() {
  const realpathSync = fs.realpathSync;
  const native = fs.realpathSync.native;
  const calls = vi
    .spyOn(fs, "realpathSync")
    .mockImplementation((...args) => Reflect.apply(realpathSync, fs, args));
  // fs-safe canonicalizes opened files through the native resolver.
  Object.assign(fs.realpathSync, { native });
  return calls;
}

it("resolves the same canonical paths as realpathSync within a capture pass", () => {
  const root = fs.realpathSync(temp.make("plugin-source-realpath-"));
  const store = path.join(root, "store", "package");
  fs.mkdirSync(path.join(store, "lib"), { recursive: true });
  fs.writeFileSync(path.join(store, "lib", "index.js"), "export {};");
  fs.writeFileSync(path.join(store, "other.js"), "export {};");
  const modules = path.join(root, "node_modules");
  fs.mkdirSync(modules);
  fs.symlinkSync(store, path.join(modules, "package"), "junction");
  const candidates = [
    path.join(root, "store"),
    path.join(store, "lib", "index.js"),
    path.join(modules, "package"),
    path.join(modules, "package", "lib"),
    path.join(modules, "package", "lib", "index.js"),
    path.join(modules, "package", "other.js"),
    path.join(modules, ".", "package", "..", "package", "other.js"),
  ];
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(store, "other.js"), path.join(root, "linked.js"));
    candidates.push(path.join(root, "linked.js"));
  }

  const expected = candidates.map((candidate) => fs.realpathSync(candidate));
  expect(withPluginSourcePathScope(() => candidates.map(resolvePluginSourceRealPath))).toEqual(
    expected,
  );
  expect(candidates.map(resolvePluginSourceRealPath)).toEqual(expected);
  expect(() =>
    withPluginSourcePathScope(() => resolvePluginSourceRealPath(path.join(store, "missing.js"))),
  ).toThrow(expect.objectContaining({ code: "ENOENT" }));
});

it("canonicalizes package boundaries once per capture pass instead of once per file", () => {
  const root = fs.realpathSync(temp.make("plugin-source-ancestors-"));
  const source = path.join(root, ...Array.from({ length: 8 }, (_, index) => `ancestor-${index}`));
  const captures = path.join(root, "captures");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(captures);
  const files = 24;
  for (let index = 0; index < files; index += 1) {
    fs.writeFileSync(path.join(source, `module-${index}.js`), `export const value = ${index};`);
  }

  const calls = countRealpathCalls();
  const artifact = withPluginSourceCaptureDirectory(captures, () =>
    capturePluginGenerationArtifact(source, undefined, (run) => run()),
  );
  const captureCalls = calls.mock.calls.length;
  try {
    // Source verification keeps one independent canonical check per input; copying,
    // boundary admission, and receipt reopen no longer each walk every ancestor.
    expect(captureCalls).toBeLessThan(files * 2);
    expect(artifact.assertSourceCurrent).not.toThrow();
    for (let index = 0; index < files; index += 1) {
      const filename = path.join(source, `module-${index}.js`);
      expect(fs.readFileSync(artifact.resolve(filename), "utf8")).toBe(
        `export const value = ${index};`,
      );
    }
  } finally {
    artifact.dispose();
  }
});

it("does not follow a package boundary replaced during a capture pass", () => {
  const root = fs.realpathSync(temp.make("plugin-source-boundary-"));
  const boundary = path.join(root, "package");
  const outside = path.join(root, "outside");
  fs.mkdirSync(boundary);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(boundary, "index.js"), "captured");
  fs.writeFileSync(path.join(outside, "index.js"), "outside");

  withPluginSourcePathScope(() => {
    expect(hashPluginSourceFile(path.join(boundary, "index.js"), boundary).sizeBytes).toBe(8);
    fs.renameSync(boundary, `${boundary}.old`);
    fs.symlinkSync(outside, boundary, "junction");
    expect(() => hashPluginSourceFile(path.join(boundary, "index.js"), boundary)).toThrow();
  });
});
