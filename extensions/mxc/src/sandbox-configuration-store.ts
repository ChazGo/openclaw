import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  parseMxcSandboxConfigurationEnvelope,
  type MxcSandboxConfigurationEnvelope,
} from "./sandbox-configuration-types.js";

export type MxcSandboxConfigurationCreatedBy = "cli" | "imported";

export type MxcToolSandboxConfiguration = {
  toolName: string;
  argsHash: string;
  argsSummary: string;
  envelope: MxcSandboxConfigurationEnvelope;
  useCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  createdBy: MxcSandboxConfigurationCreatedBy;
};

export type MxcToolSandboxConfigurationMatch = {
  configuration: MxcToolSandboxConfiguration;
  matchedBy: "exact" | "wildcard";
};

type SandboxConfigurationStore = PluginStateKeyedStore<MxcToolSandboxConfiguration>;

const SANDBOX_CONFIGURATION_STORE_NAMESPACE = "sandbox-configurations";
const SANDBOX_CONFIGURATION_STORE_MAX_ENTRIES = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseSandboxConfiguration(value: unknown): MxcToolSandboxConfiguration {
  if (
    !isRecord(value) ||
    typeof value.toolName !== "string" ||
    value.toolName.trim().length === 0 ||
    typeof value.argsHash !== "string" ||
    typeof value.argsSummary !== "string" ||
    typeof value.useCount !== "number" ||
    !Number.isSafeInteger(value.useCount) ||
    value.useCount < 0 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.lastUsedAt !== null && typeof value.lastUsedAt !== "string") ||
    (value.createdBy !== "cli" && value.createdBy !== "imported")
  ) {
    throw new Error("Invalid MXC sandbox configuration record");
  }
  return {
    toolName: value.toolName,
    argsHash: value.argsHash,
    argsSummary: value.argsSummary,
    envelope: parseMxcSandboxConfigurationEnvelope(value.envelope),
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

function configurationKey(toolName: string, argsHash: string): string {
  const toolHash = createHash("sha256").update(toolName).digest("hex");
  return `${toolHash}:${argsHash || "wildcard"}`;
}

export function computeMxcSandboxConfigurationArgsHash(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(args)))
    .digest("hex");
}

export function computeMxcSandboxConfigurationFingerprint(
  configuration: Pick<MxcToolSandboxConfiguration, "toolName" | "argsHash" | "envelope">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          toolName: configuration.toolName,
          argsHash: configuration.argsHash,
          envelope: configuration.envelope,
        }),
      ),
    )
    .digest("hex");
}

export function summarizeMxcSandboxConfigurationArgs(
  args: Record<string, unknown>,
  maxLength = 80,
): string {
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

export function openMxcSandboxConfigurationStore(
  openKeyedStore: <T>(options: {
    namespace: string;
    maxEntries: number;
    overflowPolicy: "reject-new";
  }) => PluginStateKeyedStore<T>,
): MxcSandboxConfigurationStore {
  return new MxcSandboxConfigurationStore(
    openKeyedStore<MxcToolSandboxConfiguration>({
      namespace: SANDBOX_CONFIGURATION_STORE_NAMESPACE,
      maxEntries: SANDBOX_CONFIGURATION_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
  );
}

export class MxcSandboxConfigurationStore {
  constructor(private readonly store: SandboxConfigurationStore) {}

  async lookup(
    toolName: string,
    argsHash: string,
  ): Promise<MxcToolSandboxConfigurationMatch | undefined> {
    const exact = await this.store.lookup(configurationKey(toolName, argsHash));
    if (exact) {
      return { configuration: parseSandboxConfiguration(exact), matchedBy: "exact" };
    }
    const wildcard = await this.store.lookup(configurationKey(toolName, ""));
    return wildcard
      ? { configuration: parseSandboxConfiguration(wildcard), matchedBy: "wildcard" }
      : undefined;
  }

  async lookupExact(
    toolName: string,
    argsHash: string,
  ): Promise<MxcToolSandboxConfiguration | undefined> {
    const configuration = await this.store.lookup(configurationKey(toolName, argsHash));
    return configuration ? parseSandboxConfiguration(configuration) : undefined;
  }

  async list(toolName?: string): Promise<MxcToolSandboxConfiguration[]> {
    const entries = await this.store.entries();
    return entries
      .map((entry) => parseSandboxConfiguration(entry.value))
      .filter((configuration) => !toolName || configuration.toolName === toolName)
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
    envelope: MxcSandboxConfigurationEnvelope;
    createdBy?: MxcSandboxConfigurationCreatedBy;
  }): Promise<MxcToolSandboxConfiguration> {
    const toolName = input.toolName.trim();
    if (!toolName) {
      throw new Error("MXC sandbox configuration toolName must not be empty");
    }
    const envelope = parseMxcSandboxConfigurationEnvelope(input.envelope);
    const key = configurationKey(toolName, input.argsHash);
    const now = new Date().toISOString();
    const buildConfiguration = (
      existing: MxcToolSandboxConfiguration | undefined,
    ): MxcToolSandboxConfiguration => ({
      toolName,
      argsHash: input.argsHash,
      argsSummary: input.argsSummary,
      envelope,
      useCount: existing?.useCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      createdBy: existing?.createdBy ?? input.createdBy ?? "cli",
    });
    if (this.store.update) {
      let next: MxcToolSandboxConfiguration | undefined;
      const updated = await this.store.update(key, (existing) => {
        next = buildConfiguration(existing ? parseSandboxConfiguration(existing) : undefined);
        return next;
      });
      if (!updated || !next) {
        throw new Error(`Failed to update MXC sandbox configuration for ${toolName}`);
      }
      return next;
    }
    const existing = await this.store.lookup(key);
    const next = buildConfiguration(existing ? parseSandboxConfiguration(existing) : undefined);
    await this.store.register(key, next);
    return next;
  }

  async recordUse(
    configuration: MxcToolSandboxConfiguration,
  ): Promise<MxcToolSandboxConfiguration | undefined> {
    const key = configurationKey(configuration.toolName, configuration.argsHash);
    const now = new Date().toISOString();
    if (this.store.update) {
      let next: MxcToolSandboxConfiguration | undefined;
      await this.store.update(key, (existing) => {
        if (!existing) {
          return undefined;
        }
        const current = parseSandboxConfiguration(existing);
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
    const current = parseSandboxConfiguration(existingValue);
    const next = {
      ...current,
      useCount: current.useCount + 1,
      lastUsedAt: now,
    };
    await this.store.register(key, next);
    return next;
  }

  async remove(toolName: string, argsHash: string): Promise<boolean> {
    return await this.store.delete(configurationKey(toolName, argsHash));
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }
}
