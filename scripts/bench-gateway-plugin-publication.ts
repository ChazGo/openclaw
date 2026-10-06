// Cold-starts an isolated Gateway with one installed plugin and reports model runtime
// publication time against the 120 s budget. Usage: scripts/bench-plugin-capture.md.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort, requestProbeStatus } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  classifyGatewayReadyLog,
  collectOutputLines,
  collectTraceLine,
  createGatewayBenchEnv,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";

const PUBLICATION_BUDGET_MS = 120_000;
// Lines that decide whether this start met, degraded past, or failed the publication budget.
const OUTCOME_PATTERNS = [
  /prepared model runtime publication \([^)]*\) timed out/u,
  /prepared model runtime startup degraded after/u,
  /background model runtime publication failed/u,
  /startup_failed/u,
];

type Start = {
  index: number;
  readyMs: number | null;
  readyzMs: number | null;
  modelRuntimeMs: number | null;
  modelRuntimeTotalMs: number | null;
  buildStatsAtMs: number | null;
  withinBudget: boolean | null;
  outcomeLines: string[];
  exitCode: number | null;
  signal: string | null;
  logFile: string;
  startupTrace: Record<string, number>;
};

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const installArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--no-plugin") {
      flags.add(flag.slice(2));
      continue;
    }
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`Unexpected argument: ${flag}`);
    }
    if (flag === "--install-arg") {
      installArgs.push(value);
    } else {
      values.set(flag.slice(2), value);
    }
    index += 1;
  }
  const checkout = path.resolve(
    values.get("checkout") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const installSpec = flags.has("no-plugin") ? undefined : values.get("install-spec");
  if (!flags.has("no-plugin") && !installSpec) {
    throw new Error("Pass --install-spec <npm spec or path> or --no-plugin");
  }
  return {
    checkout,
    entry: path.resolve(checkout, values.get("entry") ?? "dist/entry.js"),
    installSpec,
    installArgs,
    packageName: values.get("package-name"),
    starts: Number(values.get("starts") ?? 3),
    timeoutMs: Number(values.get("timeout-ms") ?? 600_000),
    root: values.get("root"),
    label: values.get("label") ?? "unlabeled",
    output: values.get("output"),
  };
}

function windowsEnvironment(root: string, passUserProfile: boolean): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return {};
  }
  const passthrough = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        /^(SystemRoot|SystemDrive|windir|ComSpec|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/iu.test(
          name,
        ) || /^npm_config_/iu.test(name),
    ),
  );
  const temp = path.join(root, "tmp");
  fs.mkdirSync(temp, { recursive: true });
  return {
    ...passthrough,
    TEMP: temp,
    TMP: temp,
    // npm reads the operator's registry configuration from the real profile; the Gateway
    // itself runs with the isolated root as its profile.
    USERPROFILE: passUserProfile ? process.env.USERPROFILE : root,
    APPDATA: passUserProfile ? process.env.APPDATA : path.join(root, "AppData", "Roaming"),
    LOCALAPPDATA: passUserProfile ? process.env.LOCALAPPDATA : path.join(root, "AppData", "Local"),
  };
}

function findInstalledPackage(stateDir: string, packageName: string): string | undefined {
  const pending: Array<{ directory: string; depth: number }> = [{ directory: stateDir, depth: 0 }];
  for (const { directory, depth } of pending) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === packageName) {
          return directory;
        }
      } catch {}
    }
    if (depth >= 7) {
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".pnpm")) {
        pending.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
      }
    }
  }
  return undefined;
}

async function startGateway(params: {
  index: number;
  entry: string;
  checkout: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  logFile: string;
}): Promise<Start> {
  const port = await getFreePort();
  const log = fs.createWriteStream(params.logFile);
  const startedAt = performance.now();
  const child = spawn(process.execPath, buildGatewayBenchChildArgs(params.entry, port), {
    cwd: params.checkout,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const trace: Record<string, number> = {};
  const outcomeLines: string[] = [];
  let readyMs: number | null = null;
  let readyzMs: number | null = null;
  let modelRuntimeSeen = false;
  let buildStatsAtMs: number | null = null;
  let publicationFailed = false;
  const exit: { done: boolean; code: number | null; signal: string | null } = {
    done: false,
    code: null,
    signal: null,
  };
  const carry = { stdout: "", stderr: "" };
  const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const text = chunk.toString("utf8");
    log.write(text);
    const collected = collectOutputLines(carry[stream], text);
    carry[stream] = collected.carry;
    for (const line of collected.lines) {
      collectTraceLine(line, "startup trace", trace);
      modelRuntimeSeen ||= trace["sidecars.model-runtime"] !== undefined;
      if (
        buildStatsAtMs === null &&
        /startup\s+trace: sidecars\.model-runtime-build /u.test(line)
      ) {
        buildStatsAtMs = performance.now() - startedAt;
      }
      if (readyMs === null && classifyGatewayReadyLog(line) === "gateway-ready") {
        readyMs = performance.now() - startedAt;
      }
      if (OUTCOME_PATTERNS.some((pattern) => pattern.test(line))) {
        outcomeLines.push(`${((performance.now() - startedAt) / 1000).toFixed(1)}s ${line.trim()}`);
        publicationFailed ||= !/startup degraded after/u.test(line);
      }
    }
  };
  child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));
  child.on("exit", (code, exitSignal) => {
    exit.done = true;
    exit.code = code;
    exit.signal = exitSignal;
  });
  const deadline = startedAt + params.timeoutMs;
  while (!exit.done && performance.now() < deadline) {
    if (readyzMs === null && (await requestProbeStatus(port, "/readyz")).status === 200) {
      readyzMs = performance.now() - startedAt;
    }
    // Degraded startups keep publishing in the background; wait for its build result.
    if (modelRuntimeSeen && (buildStatsAtMs !== null || publicationFailed)) {
      break;
    }
    await delay(250);
  }
  if (!exit.done) {
    await stopChild(child);
  }
  await new Promise<void>((resolve) => {
    log.end(resolve);
  });
  const modelRuntimeMs = trace["sidecars.model-runtime"] ?? null;
  return {
    index: params.index,
    readyMs,
    readyzMs,
    modelRuntimeMs,
    modelRuntimeTotalMs: trace["sidecars.model-runtime.total"] ?? null,
    buildStatsAtMs,
    withinBudget:
      modelRuntimeMs === null
        ? null
        : modelRuntimeMs < PUBLICATION_BUDGET_MS && !outcomeLines.length,
    outcomeLines,
    exitCode: exit.code,
    signal: exit.signal,
    logFile: params.logFile,
    startupTrace: trace,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.entry)) {
    throw new Error(`Build ${options.checkout} first; missing ${options.entry}`);
  }
  const root = options.root
    ? path.resolve(options.root)
    : fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publication-bench-"));
  fs.mkdirSync(root, { recursive: true });
  const logs = path.join(root, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const configPath = writeGatewayBenchConfig(root, BASE_GATEWAY_BENCH_CONFIG, {});
  const gatewayEnv = {
    ...createGatewayBenchEnv(root, configPath, { startupTrace: true }),
    ...windowsEnvironment(root, false),
  };
  let pluginRoot: string | undefined;
  if (options.installSpec) {
    const install = spawnSync(
      process.execPath,
      [
        options.entry,
        "plugins",
        "install",
        options.installSpec,
        "--force",
        "--accept-capabilities",
        "--acknowledge-install-policy-warning",
        ...options.installArgs,
      ],
      {
        cwd: options.checkout,
        env: { ...gatewayEnv, ...windowsEnvironment(root, true) },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    fs.writeFileSync(path.join(logs, "install.log"), `${install.stdout}\n${install.stderr}`);
    if (install.status !== 0) {
      throw new Error(
        `plugins install failed (${install.status}); see ${path.join(logs, "install.log")}`,
      );
    }
    const packageName =
      options.packageName ??
      (options.installSpec.startsWith("@")
        ? `@${options.installSpec.slice(1).split("@")[0]}`
        : (options.installSpec.split("@")[0] ?? ""));
    pluginRoot = findInstalledPackage(path.join(root, "state"), packageName);
  }

  const starts: Start[] = [];
  for (let index = 0; index < options.starts; index += 1) {
    const start = await startGateway({
      index,
      entry: options.entry,
      checkout: options.checkout,
      env: gatewayEnv,
      timeoutMs: options.timeoutMs,
      logFile: path.join(logs, `gateway-start-${index + 1}.log`),
    });
    starts.push(start);
    console.log(
      `[${options.label}] start ${index + 1}/${options.starts}: model-runtime ` +
        `${start.modelRuntimeMs === null ? "n/a" : `${(start.modelRuntimeMs / 1000).toFixed(1)}s`} ` +
        `(budget ${PUBLICATION_BUDGET_MS / 1000}s, ${start.withinBudget ? "within" : "NOT within"}), ` +
        `ready ${start.readyMs === null ? "n/a" : `${(start.readyMs / 1000).toFixed(1)}s`}` +
        (start.outcomeLines.length ? `; ${start.outcomeLines[0]}` : ""),
    );
  }

  const result = {
    label: options.label,
    checkout: options.checkout,
    head: spawnSync("git", ["-C", options.checkout, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout?.trim(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    os: os.release(),
    installSpec: options.installSpec ?? null,
    pluginRoot: pluginRoot ?? null,
    root,
    publicationBudgetMs: PUBLICATION_BUDGET_MS,
    // Start 1 is the first start after install; later starts are restarts on the same state.
    starts,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const output = options.output ?? path.join(logs, "result.json");
  fs.writeFileSync(output, json);
  console.log(`wrote ${path.resolve(output)}${pluginRoot ? `; plugin root ${pluginRoot}` : ""}`);
  console.log(`isolated state kept at ${root}; delete it when finished`);
}

await main();
