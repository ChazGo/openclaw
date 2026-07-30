import { describe, expect, test } from "vitest";
import {
  MxcSandboxConfigurationAuthorizationStore,
  MXC_SANDBOX_CONFIGURATION_NONCE_ENV,
} from "../src/sandbox-configuration-authorization.js";
import { MemorySyncKeyedStore } from "./policy-test-helpers.js";

describe("MxcSandboxConfigurationAuthorizationStore", () => {
  test("correlates one exec command and strips the internal nonce", () => {
    const store = new MxcSandboxConfigurationAuthorizationStore(new MemorySyncKeyedStore());
    const issued = store.authorize(
      { command: "git status", env: { KEEP: "yes" } },
      {
        toolName: "exec",
        argsHash: "hash",
        command: "git status",
        envelope: { networkEnabled: false },
      },
    );
    const env = issued.params.env as Record<string, string>;

    expect(env[MXC_SANDBOX_CONFIGURATION_NONCE_ENV]).toBe(issued.nonce);
    expect(store.consume({ command: "git status", env })).toEqual({
      authorization: {
        toolName: "exec",
        argsHash: "hash",
        command: "git status",
        envelope: { networkEnabled: false },
      },
      env: { KEEP: "yes" },
    });
  });

  test("fails closed for command substitution and nonce replay", () => {
    const store = new MxcSandboxConfigurationAuthorizationStore(new MemorySyncKeyedStore());
    const issued = store.authorize(
      { command: "git status" },
      {
        toolName: "exec",
        argsHash: "hash",
        command: "git status",
        envelope: {},
      },
    );
    const env = issued.params.env as Record<string, string>;

    expect(() => store.consume({ command: "Remove-Item -Recurse .", env })).toThrow(
      /does not match/u,
    );
    expect(() => store.consume({ command: "git status", env })).toThrow(/missing or expired/u);
  });

  test("does not let a nonce-free call consume another call's authorization", () => {
    const store = new MxcSandboxConfigurationAuthorizationStore(new MemorySyncKeyedStore());
    store.authorize(
      { command: "git status" },
      {
        toolName: "exec",
        argsHash: "hash",
        command: "git status",
        envelope: {},
      },
    );

    expect(store.consume({ command: "git status", env: {} })).toEqual({
      authorization: undefined,
      env: {},
    });
  });
});
