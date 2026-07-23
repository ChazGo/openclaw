import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MxcPolicyAudit } from "../src/policy-audit.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("MxcPolicyAudit", () => {
  test("writes serialized metadata without error text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mxc-policy-audit-"));
    tempDirs.push(dir);
    const logPath = path.join(dir, "audit.jsonl");
    const audit = new MxcPolicyAudit({ logPath });
    const call = {
      toolName: "exec",
      argsHash: "hash-only",
      sessionId: "session",
      runId: "run",
      toolCallId: "call",
    };

    audit.emitRequested(call);
    audit.emitDecision(call, "allow", "exact");
    audit.emitCompleted({ ...call, durationMs: 12, error: "secret failure details" });
    await audit.flush();

    const text = await readFile(logPath, "utf8");
    const entries = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({ success: false, durationMs: 12 });
    expect(text).not.toContain("secret failure details");
  });

  test("warns instead of rejecting when the audit path cannot be written", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mxc-policy-audit-"));
    tempDirs.push(dir);
    const warn = vi.fn();
    const audit = new MxcPolicyAudit({ logPath: dir, warn });

    audit.emitRequested({ toolName: "read", argsHash: "hash" });
    await expect(audit.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
