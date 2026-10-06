// Measures plugin source capture (copy + verification) for one installed plugin and its
// dependency closure. Usage and before/after procedure: scripts/bench-plugin-capture.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

type Counts = Record<string, number>;
type Run = {
  captureMs: number;
  reverifyMs: number[];
  fsCalls: { capture: Counts; reverify: Counts[] };
  captured: { files: number; directories: number; bytes: number };
};

const COUNTED = [
  "lstatSync",
  "statSync",
  "fstatSync",
  "realpathSync",
  "openSync",
  "closeSync",
  "readSync",
  "readdirSync",
  "readFileSync",
  "readlinkSync",
  "existsSync",
  "copyFileSync",
  "mkdirSync",
  "chmodSync",
  "linkSync",
  "symlinkSync",
] as const;

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    values.set(flag.slice(2), value);
    index += 1;
  }
  const pluginRoot = values.get("plugin-root");
  if (!pluginRoot) {
    throw new Error("--plugin-root <installed plugin package directory> is required");
  }
  return {
    pluginRoot: fs.realpathSync(pluginRoot),
    checkout: path.resolve(
      values.get("checkout") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
    ),
    runs: Number(values.get("runs") ?? 3),
    reverify: Number(values.get("reverify") ?? 2),
    captureRoot: path.resolve(values.get("capture-root") ?? os.tmpdir()),
    label: values.get("label") ?? "unlabeled",
    output: values.get("output"),
  };
}

// Counts are process-wide while a phase runs; the harness does no other filesystem work then.
function installCounters() {
  const counts: Counts = Object.fromEntries(COUNTED.map((name) => [name, 0]));
  counts["realpathSync.native"] = 0;
  const target = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of COUNTED) {
    const original = target[name]!;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      counts[name]! += 1;
      return Reflect.apply(original, this, args);
    };
    if (name === "realpathSync") {
      const native = fs.realpathSync.native;
      Object.assign(wrapped, {
        native: (...args: unknown[]) => {
          counts["realpathSync.native"]! += 1;
          return Reflect.apply(native, fs, args);
        },
      });
    }
    target[name] = wrapped;
  }
  syncBuiltinESMExports();
  return {
    snapshot: (): Counts => ({ ...counts }),
    since: (before: Counts): Counts =>
      Object.fromEntries(
        Object.entries(counts).map(([name, value]) => [name, value - before[name]!]),
      ),
  };
}

function measureTree(root: string) {
  const totals = { files: 0, directories: 0, bytes: 0 };
  const pending = [root];
  for (const directory of pending) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        totals.directories += 1;
        pending.push(filename);
      } else if (entry.isFile()) {
        totals.files += 1;
        totals.bytes += fs.statSync(filename).size;
      }
    }
  }
  return totals;
}

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null;
}

function gitHead(checkout: string) {
  try {
    return execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const head = gitHead(options.checkout);
  const counters = installCounters();
  const { capturePluginGenerationArtifact } = (await import(
    pathToFileURL(path.join(options.checkout, "src", "plugins", "plugin-generation-artifact.ts"))
      .href
  )) as typeof import("../src/plugins/plugin-generation-artifact.js");
  const { withPluginSourceCaptureDirectory } = (await import(
    pathToFileURL(
      path.join(options.checkout, "src", "plugins", "plugin-package-metadata-capture.ts"),
    ).href
  )) as typeof import("../src/plugins/plugin-package-metadata-capture.js");

  const runs: Run[] = [];
  for (let index = 0; index < options.runs; index += 1) {
    const captureDirectory = fs.mkdtempSync(
      path.join(options.captureRoot, "openclaw-capture-bench-"),
    );
    try {
      const before = counters.snapshot();
      const startedAt = performance.now();
      // Production startup capture: whole package body plus its declared dependency closure.
      const artifact = withPluginSourceCaptureDirectory(captureDirectory, () =>
        capturePluginGenerationArtifact(options.pluginRoot, undefined, (run) => run()),
      );
      const captureMs = performance.now() - startedAt;
      const capture = counters.since(before);
      const reverifyMs: number[] = [];
      const reverify: Counts[] = [];
      try {
        for (let pass = 0; pass < options.reverify; pass += 1) {
          const passBefore = counters.snapshot();
          const passStartedAt = performance.now();
          artifact.assertSourceCurrent();
          reverifyMs.push(performance.now() - passStartedAt);
          reverify.push(counters.since(passBefore));
        }
        const run = {
          captureMs,
          reverifyMs,
          fsCalls: { capture, reverify },
          captured: measureTree(captureDirectory),
        };
        runs.push(run);
        console.log(
          `[${options.label}] run ${index + 1}/${options.runs}: capture ${(captureMs / 1000).toFixed(2)}s, ` +
            `re-verify ${reverifyMs.map((ms) => `${(ms / 1000).toFixed(2)}s`).join(", ")}, ` +
            `${run.captured.files} files, lstat ${capture.lstatSync}, realpath ${capture.realpathSync}, ` +
            `open ${capture.openSync}`,
        );
      } finally {
        artifact.dispose();
      }
    } finally {
      fs.rmSync(captureDirectory, { recursive: true, force: true });
    }
  }

  const result = {
    label: options.label,
    checkout: options.checkout,
    head,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    os: os.release(),
    pluginRoot: options.pluginRoot,
    captureRoot: options.captureRoot,
    runs,
    // capture = copy + initial verification; re-verify = one full later verification pass.
    median: {
      captureMs: median(runs.map((run) => run.captureMs)),
      reverifyMs: median(runs.flatMap((run) => run.reverifyMs)),
      copyMsEstimate: median(runs.map((run) => run.captureMs - (median(run.reverifyMs) ?? 0))),
    },
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, json);
    console.log(`wrote ${path.resolve(options.output)}`);
  } else {
    process.stdout.write(json);
  }
}

await main();
