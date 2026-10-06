import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  capturePluginNativeNamespace,
  finishPluginNativeNamespace,
  pluginNativeNamespaceMemberPath,
} from "./plugin-native-namespace.js";
import { hashPluginSourceFile, pluginSourceStatIdentity } from "./plugin-source-file.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

// Stands in for an identity recorded before an on-access scanner stamped the copy's ctime.
const withEarlierCtime = (identity: string) => `${identity.slice(0, identity.lastIndexOf(":"))}:1`;

// Changing the link count moves ctime and nothing else, as a first-read scan stamp does.
// The link lives outside the namespace so no directory membership changes.
function stampCtime(filename: string, linkDirectory: string) {
  const before = pluginSourceStatIdentity(fs.statSync(filename, { bigint: true }));
  const link = path.join(linkDirectory, "stamp-link");
  for (let attempt = 0; attempt < 100_000; attempt++) {
    fs.linkSync(filename, link);
    fs.unlinkSync(link);
    if (pluginSourceStatIdentity(fs.statSync(filename, { bigint: true })) !== before) {
      return;
    }
  }
  throw new Error(`ctime of ${filename} did not advance`);
}

// Runs `duringCopy` right after the addon's copy is written, inside the capture pass.
function captureNamespace(
  duringCopy?: (paths: { source: string; copy: string; root: string }) => void,
) {
  const root = fs.realpathSync(temp.make("plugin-native-namespace-"));
  const source = path.join(root, "native");
  const capturedRoot = path.join(root, "captured");
  fs.mkdirSync(source);
  fs.mkdirSync(capturedRoot);
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"native-fixture"}');
  fs.writeFileSync(path.join(source, "addon.node"), "native bytes");
  const chmod = fs.chmodSync;
  const spy = vi.spyOn(fs, "chmodSync").mockImplementation((filename, mode) => {
    chmod(filename, mode);
    if (duringCopy && path.basename(String(filename)) === "addon.node") {
      duringCopy({ source: path.join(source, "addon.node"), copy: String(filename), root });
    }
  });
  let fact: ReturnType<typeof capturePluginNativeNamespace>["fact"];
  try {
    ({ fact } = capturePluginNativeNamespace({
      sourceDirectory: source,
      boundary: source,
      capturedRoot,
      managed: false,
    }));
  } finally {
    spy.mockRestore();
  }
  const member = fact.members["addon.node"]!;
  return { fact, member, copy: pluginNativeNamespaceMemberPath(fact, "addon.node") };
}

it("admits a captured companion whose ctime alone changed when its bytes match the source", () => {
  const { fact, member, copy } = captureNamespace();
  const actual = member.capturedIdentity;
  member.capturedIdentity = withEarlierCtime(actual);

  finishPluginNativeNamespace(fact);

  expect(member.contentHash).toBe(hashPluginSourceFile(copy, fact.capturedRoot).contentHash);
  expect(member.capturedIdentity).toBe(actual);
});

it("rejects a ctime-only change when the captured bytes no longer match the source", () => {
  const { fact, member, copy } = captureNamespace();
  fs.writeFileSync(copy, "forged bytes");
  member.capturedIdentity = withEarlierCtime(
    pluginSourceStatIdentity(fs.statSync(copy, { bigint: true })),
  );

  expect(() => finishPluginNativeNamespace(fact)).toThrow(
    "Native plugin companion changed before admission completed",
  );
});

it("rejects a captured companion whose mtime changed", () => {
  const { fact, member } = captureNamespace();
  const parts = member.capturedIdentity.split(":");
  parts[4] = "1";
  member.capturedIdentity = parts.join(":");

  expect(() => finishPluginNativeNamespace(fact)).toThrow(
    "Native plugin companion changed before admission completed",
  );
});

it("admits a copied companion whose source ctime alone changed during the copy", () => {
  let stamped = "";
  const { fact, member } = captureNamespace(({ source, root }) => {
    stampCtime(source, root);
    stamped = pluginSourceStatIdentity(fs.statSync(source, { bigint: true }));
  });

  expect(member.sourceIdentity).toBe(stamped);
  finishPluginNativeNamespace(fact);
  expect(member.contentHash).toBe(
    hashPluginSourceFile(member.source, fact.sourceDirectory).contentHash,
  );
});

it("rejects a ctime-only source change when the copy does not hold the source bytes", () => {
  expect(() =>
    captureNamespace(({ source, copy, root }) => {
      fs.writeFileSync(copy, "forged bytes");
      stampCtime(source, root);
    }),
  ).toThrow("Native plugin directory changed during admission");
});

it("rejects a source whose mtime changed during the copy", () => {
  expect(() =>
    captureNamespace(({ source }) => {
      fs.utimesSync(source, 1_000, 1_000);
    }),
  ).toThrow("Native plugin directory changed during admission");
});
