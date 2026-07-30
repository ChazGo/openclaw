import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerMxcSandboxConfigurationCli } from "../src/sandbox-configuration-cli.js";
import {
  computeMxcSandboxConfigurationArgsHash,
  MxcSandboxConfigurationStore,
} from "../src/sandbox-configuration-store.js";
import { MemoryKeyedStore } from "./policy-test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createCli() {
  const program = new Command();
  program.exitOverride();
  const store = new MxcSandboxConfigurationStore(new MemoryKeyedStore());
  const api = {
    registerCli: (register: (input: { program: Command }) => void) => register({ program }),
  } as unknown as OpenClawPluginApi;
  registerMxcSandboxConfigurationCli(api, () => store);
  return { program, store };
}

describe("MXC sandbox configuration CLI", () => {
  test("creates a wildcard sandbox configuration", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { program, store } = createCli();

    await program.parseAsync(
      ["mxc", "sandbox", "edit", "exec", "--envelope", '{"timeoutSeconds":30}'],
      { from: "user" },
    );

    await expect(store.lookupExact("exec", "")).resolves.toMatchObject({
      envelope: { timeoutSeconds: 30 },
    });
  });

  test("targets one exact sandbox configuration for removal", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { program, store } = createCli();
    const args = '{"path":"C:\\\\data.txt"}';

    await program.parseAsync(
      ["mxc", "sandbox", "edit", "read", "--args", args, "--envelope", "{}"],
      { from: "user" },
    );
    await program.parseAsync(["mxc", "sandbox", "remove", "read", "--args", args], {
      from: "user",
    });

    const argsHash = computeMxcSandboxConfigurationArgsHash({ path: "C:\\data.txt" });
    await expect(store.lookupExact("read", argsHash)).resolves.toBeUndefined();
  });
});
