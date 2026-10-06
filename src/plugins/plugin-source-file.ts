import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copyFileDescriptorSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isGitRuntimeStagingName } from "../infra/update-runtime-staging.js";

// Git rollback trees retain links relative to their final location. Only explicit
// dependency selection may own them; incidental plugin walks must leave them alone.
export const isPluginSourceEntry = (name: string): boolean =>
  name !== "node_modules" && name !== ".git" && !isGitRuntimeStagingName(name);

// Capture and native module hooks are synchronous; no read retains this scratch buffer.
const scratch = Buffer.allocUnsafe(64 * 1024);

export const pluginSourceStatIdentity = (stat: fs.BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export const pluginSourceIdentityChangedOnlyByCtime = (
  previous: string,
  current: string,
): boolean =>
  previous.slice(0, previous.lastIndexOf(":")) === current.slice(0, current.lastIndexOf(":"));

// One synchronous capture or verification pass. Without it, every root-scoped
// open re-canonicalizes its package boundary from the drive root, and Windows
// pays a handle open per ancestor lstat for each captured file.
let pathScope:
  | { boundaries: Map<string, string | undefined>; directories: Map<string, string> }
  | undefined;

/** Shares path canonicalization across one synchronous capture or verification pass. */
export function withPluginSourcePathScope<T>(run: () => T): T {
  if (pathScope) {
    return run();
  }
  pathScope = { boundaries: new Map(), directories: new Map() };
  try {
    return run();
  } finally {
    pathScope = undefined;
  }
}

// fs-safe computes this same value for each open that lacks `rootRealPath`. Each
// open still observes the root's identity and natively canonicalizes the opened
// file inside it, so reusing the value cannot admit a file outside the boundary.
function scopedBoundaryRealPath(boundary: string): string | undefined {
  if (!pathScope) {
    return undefined;
  }
  if (!pathScope.boundaries.has(boundary)) {
    let real: string | undefined;
    try {
      real = resolvePathViaExistingAncestorSync(boundary);
    } catch {
      // Let the root-scoped open report its own boundary failure.
    }
    pathScope.boundaries.set(boundary, real);
  }
  return pathScope.boundaries.get(boundary);
}

function scopedDirectoryRealPath(directories: Map<string, string>, directory: string): string {
  const known = directories.get(directory);
  if (known !== undefined) {
    return known;
  }
  const parent = path.dirname(directory);
  const real =
    parent === directory || fs.lstatSync(directory).isSymbolicLink()
      ? fs.realpathSync(directory)
      : path.join(scopedDirectoryRealPath(directories, parent), path.basename(directory));
  directories.set(directory, real);
  return real;
}

/**
 * Same result as `fs.realpathSync`, but within a path scope each ancestor is
 * lstat'ed once rather than once per captured file. Capture-time only: source
 * verification keeps an independent `fs.realpathSync` so ancestor changes made
 * during capture are still rejected.
 */
export function resolvePluginSourceRealPath(source: string): string {
  // Bun's realpathSync is native and may canonicalize spelling; only Node's
  // component walk is reproduced exactly by joining non-link components.
  if (!pathScope || Object.hasOwn(process.versions, "bun")) {
    return fs.realpathSync(source);
  }
  const resolved = path.resolve(source);
  const parent = path.dirname(resolved);
  if (parent === resolved || fs.lstatSync(resolved).isSymbolicLink()) {
    return fs.realpathSync(resolved);
  }
  return path.join(scopedDirectoryRealPath(pathScope.directories, parent), path.basename(resolved));
}

function withPluginSourceFile<T>(source: string, boundary: string, read: (fd: number) => T): T {
  const opened = openRootFileSync({
    absolutePath: source,
    rootPath: boundary,
    rootRealPath: scopedBoundaryRealPath(boundary),
    boundaryLabel: "plugin build source",
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Cannot capture plugin source ${source}`, { cause: opened.error });
  }
  try {
    return read(opened.fd);
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function pluginSourceFileIdentity(source: string, boundary: string): string {
  return withPluginSourceFile(source, boundary, (fd) =>
    pluginSourceStatIdentity(fs.fstatSync(fd, { bigint: true })),
  );
}

export function isPluginNativeExecutable(source: string, boundary: string): boolean {
  return withPluginSourceFile(source, boundary, (fd) => {
    if (fs.readSync(fd, scratch, 0, 4, 0) !== 4) {
      return false;
    }
    const magic = scratch.readUInt32BE(0);
    return (
      scratch.readUInt16BE(0) === 0x4d5a ||
      [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(
        magic,
      )
    );
  });
}

export function copyPluginSourceFile(
  source: string,
  boundary: string,
  target: string,
  options: { hashCopiedContent?: boolean } = {},
) {
  return withPluginSourceFile(source, boundary, (fd) => {
    // Reopening the admitted pathname would lose the pinned inode on concurrent replacement.
    if (process.platform === "linux" || process.platform === "darwin") {
      const descriptor = `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fd}`;
      try {
        fs.copyFileSync(descriptor, target, fs.constants.COPYFILE_FICLONE);
        return undefined;
      } catch (error) {
        // Chroots and restricted mounts can lack descriptor paths despite a valid open file.
        if (
          !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].some((code) => hasErrnoCode(error, code)) &&
          !(
            process.platform === "darwin" &&
            Object.hasOwn(process.versions, "bun") &&
            hasErrnoCode(error, "EBADF")
          )
        ) {
          throw error;
        }
      }
    }
    const output = fs.openSync(target, options.hashCopiedContent ? "w+" : "w", 0o600);
    try {
      copyFileDescriptorSync(fd, output, { maxBytes: fs.fstatSync(fd).size });
      // Hash the actual destination through its owned descriptor. Reopening every
      // fresh copy repeats Windows file admission before its receipt can be recorded.
      return options.hashCopiedContent ? hashPluginSourceDescriptor(output) : undefined;
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "too-large") {
        throw new Error(
          "Plugin source changed while preparing its reload; retry after the edit finishes.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      fs.closeSync(output);
    }
  });
}

export function linkPluginSourceFile(source: string, boundary: string, target: string): void {
  withPluginSourceFile(source, boundary, (fd) => {
    const admitted = fs.fstatSync(fd, { bigint: true });
    fs.linkSync(source, target);
    const linked = fs.statSync(target, { bigint: true });
    if (linked.dev !== admitted.dev || linked.ino !== admitted.ino) {
      throw new Error("Native plugin artifact changed during admission");
    }
  });
}

export function hashPluginSourceFile(
  source: string,
  boundary: string,
  receipt?: Hash,
  prepared?: { contentHash: string; sizeBytes: number },
) {
  return withPluginSourceFile(source, boundary, (fd) =>
    hashPluginSourceDescriptor(fd, receipt, prepared),
  );
}

function hashPluginSourceDescriptor(
  fd: number,
  receipt?: Hash,
  prepared?: { contentHash: string; sizeBytes: number },
) {
  const content = prepared ? undefined : createHash("sha256");
  const sizeBytes = prepared?.sizeBytes ?? fs.fstatSync(fd).size;
  receipt?.update(String(sizeBytes)).update("\0");
  let position = 0;
  for (;;) {
    const length = fs.readSync(
      fd,
      scratch,
      0,
      Math.min(scratch.length, sizeBytes - position + 1),
      position,
    );
    position += length;
    if (length === 0 || position > sizeBytes) {
      break;
    }
    const chunk = scratch.subarray(0, length);
    content?.update(chunk);
    receipt?.update(chunk);
  }
  if (position !== sizeBytes) {
    throw new Error(
      "Plugin source changed while preparing its reload; retry after the edit finishes.",
    );
  }
  return prepared ?? { contentHash: content!.digest("hex"), sizeBytes };
}
