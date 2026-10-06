import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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

function captureNamespace() {
  const root = fs.realpathSync(temp.make("plugin-native-namespace-"));
  const source = path.join(root, "native");
  const capturedRoot = path.join(root, "captured");
  fs.mkdirSync(source);
  fs.mkdirSync(capturedRoot);
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"native-fixture"}');
  fs.writeFileSync(path.join(source, "addon.node"), "native bytes");
  const { fact } = capturePluginNativeNamespace({
    sourceDirectory: source,
    boundary: source,
    capturedRoot,
    managed: false,
  });
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
