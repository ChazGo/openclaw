import { describe, expect, test } from "vitest";
import {
  computeMxcPolicyArgsHash,
  MxcPolicyStore,
  openMxcPolicyStore,
  summarizeMxcPolicyArgs,
} from "../src/policy-store.js";
import { MemoryKeyedStore } from "./policy-test-helpers.js";

function createStore(): MxcPolicyStore {
  return new MxcPolicyStore(new MemoryKeyedStore());
}

describe("MxcPolicyStore", () => {
  test("does not impose an application-level policy count limit", () => {
    let maxEntries: number | undefined;
    openMxcPolicyStore((options) => {
      maxEntries = options.maxEntries;
      return new MemoryKeyedStore();
    });

    expect(maxEntries).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("canonicalizes object keys while preserving array order", () => {
    expect(computeMxcPolicyArgsHash({ b: 2, a: { d: 4, c: [1, 2] } })).toBe(
      computeMxcPolicyArgsHash({ a: { c: [1, 2], d: 4 }, b: 2 }),
    );
    expect(computeMxcPolicyArgsHash({ values: [1, 2] })).not.toBe(
      computeMxcPolicyArgsHash({ values: [2, 1] }),
    );
  });

  test("includes special object property names in exact-policy hashes", () => {
    const withPrototypeKey = JSON.parse('{"options":{"__proto__":{"action":"delete"}}}') as Record<
      string,
      unknown
    >;

    expect(computeMxcPolicyArgsHash(withPrototypeKey)).not.toBe(
      computeMxcPolicyArgsHash({ options: {} }),
    );
  });

  test("uses exact rules before wildcard rules", async () => {
    const store = createStore();
    const argsHash = computeMxcPolicyArgsHash({ command: "git status" });
    await store.upsert({
      toolName: "exec",
      argsHash: "",
      argsSummary: "(all arguments)",
      decision: "deny",
      envelope: {},
      lifecycle: "settled",
    });
    await store.upsert({
      toolName: "exec",
      argsHash,
      argsSummary: summarizeMxcPolicyArgs({ command: "git status" }),
      decision: "allow",
      envelope: { networkEnabled: false },
      lifecycle: "settled",
    });

    expect(await store.lookup("exec", argsHash)).toMatchObject({
      matchedBy: "exact",
      rule: { decision: "allow" },
    });
    expect(
      await store.lookup("exec", computeMxcPolicyArgsHash({ command: "git diff" })),
    ).toMatchObject({
      matchedBy: "wildcard",
      rule: { decision: "deny" },
    });
  });

  test("tracks lifecycle and use count without creating unmatched rules", async () => {
    const store = createStore();
    expect(
      await store.lookup("read", computeMxcPolicyArgsHash({ path: "README.md" })),
    ).toBeUndefined();
    expect(await store.counts()).toEqual({ total: 0, settled: 0, inDevelopment: 0 });

    const rule = await store.upsert({
      toolName: "read",
      argsHash: "",
      argsSummary: "(all arguments)",
      decision: "allow",
      envelope: {},
      lifecycle: "development",
    });
    await store.recordUse(rule);
    await store.settle("read", "");

    expect(await store.lookupExact("read", "")).toMatchObject({
      lifecycle: "settled",
      useCount: 1,
    });
  });

  test("rejects containment envelopes on deny rules", async () => {
    await expect(
      createStore().upsert({
        toolName: "exec",
        argsHash: "",
        argsSummary: "(all arguments)",
        decision: "deny",
        envelope: { networkEnabled: false },
        lifecycle: "settled",
      }),
    ).rejects.toThrow(/deny policies cannot include/u);
  });
});
