import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { parseMxcExecutionEnvelope, type MxcExecutionEnvelope } from "./policy-types.js";

export type MxcPolicyDecision = "allow" | "deny";
export type MxcPolicyLifecycle = "development" | "settled";
export type MxcPolicyCreatedBy = "interactive" | "imported";

export type MxcToolPolicyRule = {
  toolName: string;
  argsHash: string;
  argsSummary: string;
  decision: MxcPolicyDecision;
  envelope: MxcExecutionEnvelope;
  lifecycle: MxcPolicyLifecycle;
  useCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  createdBy: MxcPolicyCreatedBy;
};

export type MxcToolPolicyMatch = {
  rule: MxcToolPolicyRule;
  matchedBy: "exact" | "wildcard";
};

type PolicyStore = PluginStateKeyedStore<MxcToolPolicyRule>;

const POLICY_STORE_NAMESPACE = "tool-policies";
const POLICY_STORE_MAX_ENTRIES = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parsePolicyRule(value: unknown): MxcToolPolicyRule {
  if (
    !isRecord(value) ||
    typeof value.toolName !== "string" ||
    value.toolName.trim().length === 0 ||
    typeof value.argsHash !== "string" ||
    typeof value.argsSummary !== "string" ||
    (value.decision !== "allow" && value.decision !== "deny") ||
    (value.lifecycle !== "development" && value.lifecycle !== "settled") ||
    typeof value.useCount !== "number" ||
    !Number.isSafeInteger(value.useCount) ||
    value.useCount < 0 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.lastUsedAt !== null && typeof value.lastUsedAt !== "string") ||
    (value.createdBy !== "interactive" && value.createdBy !== "imported")
  ) {
    throw new Error("Invalid MXC policy record");
  }
  return {
    toolName: value.toolName,
    argsHash: value.argsHash,
    argsSummary: value.argsSummary,
    decision: value.decision,
    envelope: parseMxcExecutionEnvelope(value.envelope),
    lifecycle: value.lifecycle,
    useCount: value.useCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastUsedAt: value.lastUsedAt,
    createdBy: value.createdBy,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  const object = value as Record<string, unknown>;
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(object).sort()) {
    const entry = object[key];
    if (entry !== undefined) {
      normalized[key] = canonicalize(entry);
    }
  }
  return normalized;
}

function policyKey(toolName: string, argsHash: string): string {
  const toolHash = createHash("sha256").update(toolName).digest("hex");
  return `${toolHash}:${argsHash || "wildcard"}`;
}

export function computeMxcPolicyArgsHash(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(args)))
    .digest("hex");
}

export function computeMxcPolicyRuleFingerprint(
  rule: Pick<MxcToolPolicyRule, "toolName" | "argsHash" | "decision" | "envelope" | "lifecycle">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          toolName: rule.toolName,
          argsHash: rule.argsHash,
          decision: rule.decision,
          envelope: rule.envelope,
          lifecycle: rule.lifecycle,
        }),
      ),
    )
    .digest("hex");
}

export function summarizeMxcPolicyArgs(args: Record<string, unknown>, maxLength = 80): string {
  const summarize = (value: unknown, depth = 0): unknown => {
    if (depth > 3) {
      return "<nested>";
    }
    if (Array.isArray(value)) {
      return `<array:${value.length}>`;
    }
    if (value != null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, summarize((value as Record<string, unknown>)[key], depth + 1)]),
      );
    }
    if (value === null) {
      return "<null>";
    }
    return `<${typeof value}>`;
  };
  const serialized = JSON.stringify(summarize(args));
  return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength - 3)}...`;
}

export function formatMxcPolicyArgsForApproval(
  args: Record<string, unknown>,
  maxLength = 160,
): string {
  const serialized = JSON.stringify(args);
  return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength - 3)}...`;
}

export function openMxcPolicyStore(
  openKeyedStore: <T>(options: {
    namespace: string;
    maxEntries: number;
    overflowPolicy: "reject-new";
  }) => PluginStateKeyedStore<T>,
): MxcPolicyStore {
  return new MxcPolicyStore(
    openKeyedStore<MxcToolPolicyRule>({
      namespace: POLICY_STORE_NAMESPACE,
      maxEntries: POLICY_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
  );
}

export class MxcPolicyStore {
  constructor(private readonly store: PolicyStore) {}

  async lookup(toolName: string, argsHash: string): Promise<MxcToolPolicyMatch | undefined> {
    const exact = await this.store.lookup(policyKey(toolName, argsHash));
    if (exact) {
      return { rule: parsePolicyRule(exact), matchedBy: "exact" };
    }
    const wildcard = await this.store.lookup(policyKey(toolName, ""));
    return wildcard ? { rule: parsePolicyRule(wildcard), matchedBy: "wildcard" } : undefined;
  }

  async lookupExact(toolName: string, argsHash: string): Promise<MxcToolPolicyRule | undefined> {
    const rule = await this.store.lookup(policyKey(toolName, argsHash));
    return rule ? parsePolicyRule(rule) : undefined;
  }

  async list(toolName?: string): Promise<MxcToolPolicyRule[]> {
    const entries = await this.store.entries();
    return entries
      .map((entry) => parsePolicyRule(entry.value))
      .filter((rule) => !toolName || rule.toolName === toolName)
      .toSorted(
        (left, right) =>
          left.toolName.localeCompare(right.toolName) ||
          left.argsSummary.localeCompare(right.argsSummary),
      );
  }

  async upsert(input: {
    toolName: string;
    argsHash: string;
    argsSummary: string;
    decision: MxcPolicyDecision;
    envelope: MxcExecutionEnvelope;
    lifecycle: MxcPolicyLifecycle;
    createdBy?: MxcPolicyCreatedBy;
  }): Promise<MxcToolPolicyRule> {
    const toolName = input.toolName.trim();
    if (!toolName) {
      throw new Error("MXC policy toolName must not be empty");
    }
    const envelope = parseMxcExecutionEnvelope(input.envelope);
    if (input.decision === "deny" && Object.keys(envelope).length > 0) {
      throw new Error("MXC deny policies cannot include an execution envelope");
    }
    const key = policyKey(toolName, input.argsHash);
    const now = new Date().toISOString();
    const buildRule = (existing: MxcToolPolicyRule | undefined): MxcToolPolicyRule => ({
      toolName,
      argsHash: input.argsHash,
      argsSummary: input.argsSummary,
      decision: input.decision,
      envelope,
      lifecycle: input.lifecycle,
      useCount: existing?.useCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      createdBy: existing?.createdBy ?? input.createdBy ?? "interactive",
    });
    if (this.store.update) {
      let next: MxcToolPolicyRule | undefined;
      const updated = await this.store.update(key, (existing) => {
        next = buildRule(existing ? parsePolicyRule(existing) : undefined);
        return next;
      });
      if (!updated || !next) {
        throw new Error(`Failed to update MXC policy for ${toolName}`);
      }
      return next;
    }
    const existing = await this.store.lookup(key);
    const next = buildRule(existing ? parsePolicyRule(existing) : undefined);
    await this.store.register(key, next);
    return next;
  }

  async recordUse(rule: MxcToolPolicyRule): Promise<MxcToolPolicyRule | undefined> {
    const key = policyKey(rule.toolName, rule.argsHash);
    const now = new Date().toISOString();
    if (this.store.update) {
      let next: MxcToolPolicyRule | undefined;
      await this.store.update(key, (existing) => {
        if (!existing) {
          return undefined;
        }
        const current = parsePolicyRule(existing);
        next = {
          ...current,
          useCount: current.useCount + 1,
          lastUsedAt: now,
        };
        return next;
      });
      return next;
    }
    const existingValue = await this.store.lookup(key);
    if (!existingValue) {
      return undefined;
    }
    const current = parsePolicyRule(existingValue);
    const next = {
      ...current,
      useCount: current.useCount + 1,
      lastUsedAt: now,
    };
    await this.store.register(key, next);
    return next;
  }

  async settleAllowIfUnchanged(
    rule: MxcToolPolicyRule,
    expectedFingerprint: string,
  ): Promise<MxcToolPolicyRule | undefined> {
    const key = policyKey(rule.toolName, rule.argsHash);
    if (!this.store.update) {
      return undefined;
    }
    const now = new Date().toISOString();
    let next: MxcToolPolicyRule | undefined;
    await this.store.update(key, (existing) => {
      if (!existing) {
        return undefined;
      }
      const current = parsePolicyRule(existing);
      if (computeMxcPolicyRuleFingerprint(current) !== expectedFingerprint) {
        return undefined;
      }
      next = {
        ...current,
        decision: "allow",
        lifecycle: "settled",
        updatedAt: now,
      };
      return next;
    });
    return next;
  }

  async settle(toolName: string, argsHash: string): Promise<MxcToolPolicyRule | undefined> {
    if (!this.store.update) {
      return undefined;
    }
    const key = policyKey(toolName, argsHash);
    const now = new Date().toISOString();
    let next: MxcToolPolicyRule | undefined;
    await this.store.update(key, (existing) => {
      if (!existing) {
        return undefined;
      }
      next = {
        ...parsePolicyRule(existing),
        lifecycle: "settled",
        updatedAt: now,
      };
      return next;
    });
    return next;
  }

  async remove(toolName: string, argsHash: string): Promise<boolean> {
    return await this.store.delete(policyKey(toolName, argsHash));
  }

  async counts(): Promise<{ total: number; settled: number; inDevelopment: number }> {
    const rules = await this.list();
    const settled = rules.filter((rule) => rule.lifecycle === "settled").length;
    return {
      total: rules.length,
      settled,
      inDevelopment: rules.length - settled,
    };
  }
}
