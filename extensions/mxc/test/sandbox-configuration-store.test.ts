import { describe, expect, test } from "vitest";
import {
  computeMxcSandboxConfigurationArgsHash,
  MxcSandboxConfigurationStore,
  openMxcSandboxConfigurationStore,
  summarizeMxcSandboxConfigurationArgs,
} from "../src/sandbox-configuration-store.js";
import { MemoryKeyedStore } from "./policy-test-helpers.js";

function createStore(): MxcSandboxConfigurationStore {
  return new MxcSandboxConfigurationStore(new MemoryKeyedStore());
}

describe("MxcSandboxConfigurationStore", () => {
  test("uses the sandbox-configurations namespace without an application count limit", () => {
    let namespace: string | undefined;
    let maxEntries: number | undefined;
    openMxcSandboxConfigurationStore((options) => {
      namespace = options.namespace;
      maxEntries = options.maxEntries;
      return new MemoryKeyedStore();
    });

    expect(namespace).toBe("sandbox-configurations");
    expect(maxEntries).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("canonicalizes object keys while preserving array order", () => {
    expect(computeMxcSandboxConfigurationArgsHash({ b: 2, a: { d: 4, c: [1, 2] } })).toBe(
      computeMxcSandboxConfigurationArgsHash({ a: { c: [1, 2], d: 4 }, b: 2 }),
    );
    expect(computeMxcSandboxConfigurationArgsHash({ values: [1, 2] })).not.toBe(
      computeMxcSandboxConfigurationArgsHash({ values: [2, 1] }),
    );
  });

  test("includes special object property names in exact configuration hashes", () => {
    const withPrototypeKey = JSON.parse('{"options":{"__proto__":{"action":"delete"}}}') as Record<
      string,
      unknown
    >;

    expect(computeMxcSandboxConfigurationArgsHash(withPrototypeKey)).not.toBe(
      computeMxcSandboxConfigurationArgsHash({ options: {} }),
    );
  });

  test("uses exact configurations before wildcard configurations", async () => {
    const store = createStore();
    const argsHash = computeMxcSandboxConfigurationArgsHash({ command: "git status" });
    await store.upsert({
      toolName: "exec",
      argsHash: "",
      argsSummary: "(all arguments)",
      envelope: { timeoutSeconds: 60 },
    });
    await store.upsert({
      toolName: "exec",
      argsHash,
      argsSummary: summarizeMxcSandboxConfigurationArgs({ command: "git status" }),
      envelope: { timeoutSeconds: 30 },
    });

    expect(await store.lookup("exec", argsHash)).toMatchObject({
      matchedBy: "exact",
      configuration: { envelope: { timeoutSeconds: 30 } },
    });
    expect(
      await store.lookup("exec", computeMxcSandboxConfigurationArgsHash({ command: "git diff" })),
    ).toMatchObject({
      matchedBy: "wildcard",
      configuration: { envelope: { timeoutSeconds: 60 } },
    });
  });

  test("tracks use count without creating unmatched configurations", async () => {
    const store = createStore();
    expect(
      await store.lookup("read", computeMxcSandboxConfigurationArgsHash({ path: "README.md" })),
    ).toBeUndefined();
    expect(await store.count()).toBe(0);

    const configuration = await store.upsert({
      toolName: "read",
      argsHash: "",
      argsSummary: "(all arguments)",
      envelope: {},
    });
    await store.recordUse(configuration);

    expect(await store.lookupExact("read", "")).toMatchObject({
      useCount: 1,
      createdBy: "cli",
    });
  });
});
