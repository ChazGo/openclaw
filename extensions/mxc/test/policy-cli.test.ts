import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerMxcPolicyCli } from "../src/policy-cli.js";
import { computeMxcPolicyArgsHash, MxcPolicyStore } from "../src/policy-store.js";
import { MemoryKeyedStore } from "./policy-test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createCli() {
  const program = new Command();
  program.exitOverride();
  const store = new MxcPolicyStore(new MemoryKeyedStore());
  const api = {
    registerCli: (register: (input: { program: Command }) => void) => register({ program }),
  } as unknown as OpenClawPluginApi;
  registerMxcPolicyCli(api, () => store);
  return { program, store };
}

describe("MXC policy CLI", () => {
  test("creates a settled wildcard allow policy", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { program, store } = createCli();

    await program.parseAsync(
      [
        "mxc",
        "policy",
        "edit",
        "exec",
        "--decision",
        "allow",
        "--envelope",
        '{"timeoutSeconds":30}',
        "--settled",
      ],
      { from: "user" },
    );

    await expect(store.lookupExact("exec", "")).resolves.toMatchObject({
      decision: "allow",
      lifecycle: "settled",
      envelope: { timeoutSeconds: 30 },
    });
  });

  test("targets one exact policy for removal", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { program, store } = createCli();
    const args = '{"path":"C:\\\\data.txt"}';

    await program.parseAsync(
      ["mxc", "policy", "edit", "read", "--args", args, "--decision", "deny", "--settled"],
      { from: "user" },
    );
    await program.parseAsync(["mxc", "policy", "remove", "read", "--args", args], {
      from: "user",
    });

    const argsHash = computeMxcPolicyArgsHash({ path: "C:\\data.txt" });
    await expect(store.lookupExact("read", argsHash)).resolves.toBeUndefined();
  });
});
