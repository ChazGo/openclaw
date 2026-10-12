#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXECUTOR_NAME = "wxc-exec.exe";
const NATIVE_LIBRARY_NAME = "mxc_ffi.dll";

// Exit statuses owned by the launcher rather than the sandboxed command.
export const EXIT_TIMED_OUT = 124;
export const EXIT_LAUNCHER_FAILURE = 127;

export function decodePayload(argv) {
  const payloadFileIndex = argv.indexOf("--payload-file");
  if (payloadFileIndex < 0) {
    throw new Error("Missing --payload-file");
  }
  const payloadFile = argv[payloadFileIndex + 1];
  if (!payloadFile) {
    throw new Error("Missing --payload-file value");
  }
  const payloadJson = readFileSync(payloadFile, "utf8");
  rmSync(path.dirname(payloadFile), { force: true, recursive: true });
  const payload = JSON.parse(payloadJson);
  if (!payload || typeof payload !== "object" || !payload.request) {
    throw new Error("MXC launcher payload is missing its container request");
  }
  return payload;
}

function sdkArch() {
  return process.arch === "arm64" ? "arm64" : "x64";
}

/**
 * Re-checks the native components the plugin pinned. The SDK falls back to its
 * packaged binaries when an override directory is missing, so a vanished
 * override must fail here instead of silently running different binaries.
 */
export function assertPinnedNativeComponents(env = process.env, fileExists = existsSync) {
  const ffiDir = env.MXC_FFI_DIR;
  const binDir = env.MXC_BIN_DIR;
  if (!ffiDir || !binDir) {
    throw new Error("MXC launcher requires MXC_FFI_DIR and MXC_BIN_DIR from the plugin");
  }
  const nativeLibraryPath = path.join(ffiDir, NATIVE_LIBRARY_NAME);
  const executorPath = path.join(binDir, sdkArch(), EXECUTOR_NAME);
  for (const file of [nativeLibraryPath, executorPath]) {
    if (!fileExists(file)) {
      throw new Error(`MXC native component is missing: ${file}`);
    }
  }
  return { nativeLibraryPath, executorPath };
}

const FORWARDED_SIGNAL_EXIT_GRACE_MS = 1000;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

function formatErrorStack(error) {
  if (error && typeof error === "object" && typeof error.stack === "string") {
    return error.stack;
  }
  return String(error);
}

// The exec supervisor or runCommandBuffered owns descendant-tree cancellation.
// This SDK bridge must stay alive until wait() settles; exiting the launcher is not that join.
/**
 * Kills the sandbox on a forwarded signal and, after a grace period, records the
 * signal exit status and kills it again. The handlers are installed before spawn
 * resolves; a signal that arrives earlier kills the process as soon as it exists.
 * MXC 1.0 `kill()` already terminates the sandbox; completion still belongs to
 * `wait()`.
 */
export function forwardSignals(options = {}) {
  let target;
  let pendingKill = false;
  let exitTimer;
  let forcedExitCode;
  const exitGraceMs = options.exitGraceMs ?? FORWARDED_SIGNAL_EXIT_GRACE_MS;
  const killTarget = () => {
    try {
      target?.kill();
    } catch {
      // Ignore kill errors while the sandbox process is already exiting.
    }
  };
  const scheduleForcedExit = (signal) => {
    if (exitTimer) {
      return;
    }
    exitTimer = (options.setTimeout ?? setTimeout)(() => {
      forcedExitCode = signalExitCode(signal);
      killTarget();
    }, exitGraceMs);
    exitTimer?.unref?.();
  };
  const onSignal = options.onSignal ?? ((signal, handler) => process.on(signal, handler));
  const offSignal = options.offSignal ?? ((signal, handler) => process.off(signal, handler));
  const listeners = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const listener = () => {
      pendingKill = true;
      killTarget();
      scheduleForcedExit(signal);
    };
    onSignal(signal, listener);
    listeners.set(signal, listener);
  }
  return {
    attach(spawned) {
      target = spawned;
      if (pendingKill) {
        killTarget();
      }
    },
    exitCode: () => forcedExitCode,
    dispose() {
      if (exitTimer) {
        (options.clearTimeout ?? clearTimeout)(exitTimer);
      }
      for (const [signal, listener] of listeners) {
        offSignal(signal, listener);
      }
      listeners.clear();
    },
  };
}

const processIo = () => ({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });

function pipeOutput(source, sink, stderr) {
  return new Promise((resolve) => {
    if (!source) {
      resolve();
      return;
    }
    source.pipe(sink, { end: false });
    source.once("end", resolve);
    source.once("close", resolve);
    source.once("error", (error) => {
      stderr.write(`MXC output stream failed: ${formatErrorStack(error)}\n`);
      resolve();
    });
  });
}

/** Forwards launcher stdin into the sandbox and returns a disposer that releases it. */
function forwardInput(stdin, input, onEnd) {
  if (!input) {
    stdin.resume();
    return () => stdin.pause();
  }
  input.on("error", () => {
    // The sandbox may close stdin before the host stops writing.
  });
  const onData = (data) => {
    input.write(data);
  };
  const onStdinEnd = () => onEnd(input);
  stdin.on("data", onData);
  stdin.once("end", onStdinEnd);
  return () => {
    stdin.off("data", onData);
    stdin.off("end", onStdinEnd);
    stdin.pause();
    input.destroy?.();
  };
}

/**
 * Bridges a spawned process to the launcher's stdio and resolves with the exit
 * status the launcher should report.
 */
export async function bridgeProcess(spawned, { pty, debug } = {}, io = processIo()) {
  let outputs;
  let disposeInput;
  if (pty) {
    disposeInput = forwardInput(io.stdin, spawned.input, (input) => input.write("\x04"));
    outputs = [pipeOutput(spawned.output, io.stdout, io.stderr)];
  } else {
    disposeInput = forwardInput(io.stdin, spawned.standardInput, (input) => input.end());
    outputs = [
      pipeOutput(spawned.standardOutput, io.stdout, io.stderr),
      pipeOutput(spawned.standardError, io.stderr, io.stderr),
    ];
  }
  let result;
  try {
    result = await spawned.wait();
    await Promise.all(outputs);
  } finally {
    disposeInput();
  }
  if (debug) {
    for (const warning of spawned.warnings ?? []) {
      io.stderr.write(`[mxc] warning: ${warning}\n`);
    }
  }
  if (result.timedOut) {
    io.stderr.write("MXC sandbox command timed out and was terminated.\n");
    return EXIT_TIMED_OUT;
  }
  return result.exitCode;
}

/**
 * Runs one sandbox request and resolves with the exit status to report. `sdk`
 * supplies the v1 `spawn` and `spawnWithPty` functions so tests can substitute
 * them. Signal forwarding created here is released before returning.
 */
export async function launchSandbox(sdk, request, options = {}, signals, io = processIo()) {
  const forwarded = signals ?? forwardSignals();
  try {
    const spawned = options.pty ? await sdk.spawnWithPty(request) : await sdk.spawn(request);
    forwarded.attach(spawned);
    const exitCode = await bridgeProcess(spawned, options, io);
    return forwarded.exitCode() ?? exitCode;
  } finally {
    if (!signals) {
      forwarded.dispose();
    }
  }
}

const SIGNAL_NUMBERS = new Map([
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGQUIT", 3],
  ["SIGTERM", 15],
]);

export function signalExitCode(signal) {
  if (typeof signal === "number" && Number.isFinite(signal)) {
    return 128 + signal;
  }
  if (typeof signal === "string") {
    const signalNumber = SIGNAL_NUMBERS.get(signal);
    if (signalNumber !== undefined) {
      return 128 + signalNumber;
    }
  }
  return 1;
}

function isMain() {
  const mainPath = process.argv[1];
  if (!mainPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(mainPath)).href;
}

async function loadSdk() {
  return import("@microsoft/mxc-sdk/v1");
}

/** Host probe for readiness: prints the probe output as JSON. */
async function probeMain() {
  assertPinnedNativeComponents();
  const { probe } = await loadSdk();
  const output = probe();
  process.stdout.write(
    `${JSON.stringify({ probe: output })}\n`,
  );
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  let signals;
  try {
    if (argv.includes("--probe")) {
      process.exitCode = await probeMain();
    } else {
      signals = forwardSignals();
      const { request, options } = decodePayload(argv);
      const pinned = assertPinnedNativeComponents();
      if (options?.debug) {
        process.stderr.write(
          `[mxc] native library ${pinned.nativeLibraryPath}; executor ${pinned.executorPath}\n`,
        );
      }
      process.exitCode = await launchSandbox(await loadSdk(), request, options ?? {}, signals);
    }
  } catch (error) {
    process.stderr.write(`${formatErrorStack(error)}\n`);
    process.exitCode = EXIT_LAUNCHER_FAILURE;
  } finally {
    signals?.dispose();
  }
}

if (isMain()) {
  void main();
}
