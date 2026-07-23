import { describe, expect, test } from "vitest";
import { MxcPolicyAuthorizationStore, MXC_POLICY_NONCE_ENV } from "../src/policy-authorization.js";
import { MemorySyncKeyedStore } from "./policy-test-helpers.js";

describe("MxcPolicyAuthorizationStore", () => {
  test("correlates one exec command and strips the internal nonce", () => {
    const store = new MxcPolicyAuthorizationStore(new MemorySyncKeyedStore());
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

    expect(env[MXC_POLICY_NONCE_ENV]).toBe(issued.nonce);
    expect(
      store.consume({
        command: "git status",
        env,
      }),
    ).toEqual({
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
    const store = new MxcPolicyAuthorizationStore(new MemorySyncKeyedStore());
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

  test("returns no authorization when a call has no nonce", () => {
    const store = new MxcPolicyAuthorizationStore(new MemorySyncKeyedStore());

    expect(store.consume({ command: "git status", env: {} })).toEqual({
      authorization: undefined,
      env: {},
    });
  });

  test("does not let a nonce-free call consume another call's authorization", () => {
    const store = new MxcPolicyAuthorizationStore(new MemorySyncKeyedStore());
    for (const argsHash of ["first", "second"]) {
      store.authorize(
        { command: "git status" },
        {
          toolName: "exec",
          argsHash,
          command: "git status",
          envelope: {},
        },
      );
    }

    expect(store.consume({ command: "git status", env: {} }).authorization).toBeUndefined();
  });

  test("does not honor nonce-free authorization before MXC approval resolves", () => {
    const store = new MxcPolicyAuthorizationStore(new MemorySyncKeyedStore());
    store.authorize(
      { command: "git status" },
      {
        toolName: "exec",
        argsHash: "hash",
        command: "git status",
        envelope: { networkEnabled: false },
        approvalState: "pending",
      },
    );

    expect(store.consume({ command: "git status", env: {} }).authorization).toBeUndefined();
  });

  test("waits for asynchronous approval settlement before consuming", async () => {
    const store = new MxcPolicyAuthorizationStore(new MemorySyncKeyedStore());
    const issued = store.authorize(
      { command: "git status" },
      {
        toolName: "exec",
        argsHash: "hash",
        command: "git status",
        envelope: {},
        approvalState: "pending",
      },
    );

    const consuming = store.consumeWhenApproved({
      command: "git status",
      env: issued.params.env as Record<string, string>,
    });
    queueMicrotask(() => store.approve(issued.nonce));

    await expect(consuming).resolves.toMatchObject({
      authorization: { approvalState: "approved" },
    });
  });
});
