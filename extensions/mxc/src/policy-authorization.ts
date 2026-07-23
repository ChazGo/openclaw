import { randomUUID } from "node:crypto";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MxcExecutionEnvelope } from "./policy-types.js";

export const MXC_POLICY_NONCE_ENV = "OPENCLAW_MXC_POLICY_NONCE";

// The host caps plugin approvals at ten minutes. Keep a short execution grace
// so an approval resolved near expiry can still reach the sandbox backend.
const AUTHORIZATION_TTL_MS = 11 * 60 * 1000;
const APPROVAL_SETTLEMENT_WAIT_MS = 5_000;
const MAX_PENDING_AUTHORIZATIONS = 512;

class MxcPolicyAuthorizationPendingError extends Error {}

export type MxcExecAuthorization = {
  toolName: "exec";
  argsHash: string;
  command: string;
  envelope: MxcExecutionEnvelope;
  approvalState?: "not-required" | "pending" | "approved";
  policyRule?: {
    argsHash: string;
    acceptedFingerprints: string[];
  };
};

class MemoryAuthorizationStore implements PluginStateSyncKeyedStore<MxcExecAuthorization> {
  private readonly entriesByKey = new Map<
    string,
    { value: MxcExecAuthorization; createdAt: number; expiresAt?: number }
  >();

  register(key: string, value: MxcExecAuthorization, opts?: { ttlMs?: number }): void {
    const createdAt = Date.now();
    this.entriesByKey.set(key, {
      value,
      createdAt,
      ...(opts?.ttlMs ? { expiresAt: createdAt + opts.ttlMs } : {}),
    });
  }

  registerIfAbsent(key: string, value: MxcExecAuthorization, opts?: { ttlMs?: number }): boolean {
    if (this.lookup(key)) {
      return false;
    }
    this.register(key, value, opts);
    return true;
  }

  lookup(key: string): MxcExecAuthorization | undefined {
    const entry = this.entriesByKey.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entriesByKey.delete(key);
      return undefined;
    }
    return entry?.value;
  }

  consume(key: string): MxcExecAuthorization | undefined {
    const value = this.lookup(key);
    this.entriesByKey.delete(key);
    return value;
  }

  delete(key: string): boolean {
    return this.entriesByKey.delete(key);
  }

  entries() {
    for (const key of this.entriesByKey.keys()) {
      this.lookup(key);
    }
    return [...this.entriesByKey.entries()].map(([key, entry]) => ({
      key,
      value: entry.value,
      createdAt: entry.createdAt,
      ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    }));
  }

  clear(): void {
    this.entriesByKey.clear();
  }
}

export function createMemoryMxcPolicyAuthorizationStore(): MxcPolicyAuthorizationStore {
  return new MxcPolicyAuthorizationStore(new MemoryAuthorizationStore());
}

export class MxcPolicyAuthorizationStore {
  constructor(private readonly store: PluginStateSyncKeyedStore<MxcExecAuthorization>) {}

  authorize(
    params: Record<string, unknown>,
    authorization: MxcExecAuthorization,
  ): { params: Record<string, unknown>; nonce: string } {
    const nonce = randomUUID();
    this.store.register(nonce, authorization, { ttlMs: AUTHORIZATION_TTL_MS });
    const env =
      params.env && typeof params.env === "object" && !Array.isArray(params.env)
        ? (params.env as Record<string, unknown>)
        : {};
    return {
      nonce,
      params: {
        ...params,
        env: {
          ...env,
          [MXC_POLICY_NONCE_ENV]: nonce,
        },
      },
    };
  }

  revoke(nonce: string): void {
    this.store.delete(nonce);
  }

  approve(nonce: string): void {
    if (this.store.update) {
      const updated = this.store.update(
        nonce,
        (current) => (current ? { ...current, approvalState: "approved" } : undefined),
        { ttlMs: AUTHORIZATION_TTL_MS },
      );
      if (!updated) {
        throw new Error("MXC policy authorization is missing or expired");
      }
      return;
    }
    const current = this.store.lookup(nonce);
    if (!current) {
      throw new Error("MXC policy authorization is missing or expired");
    }
    this.store.register(
      nonce,
      { ...current, approvalState: "approved" },
      {
        ttlMs: AUTHORIZATION_TTL_MS,
      },
    );
  }

  consume(params: { command: string; env: Record<string, string> }): {
    authorization?: MxcExecAuthorization;
    env: Record<string, string>;
  } {
    const env = { ...params.env };
    const nonce = env[MXC_POLICY_NONCE_ENV];
    delete env[MXC_POLICY_NONCE_ENV];
    if (!nonce) {
      return { env };
    }
    const current = this.store.lookup(nonce);
    if (current?.approvalState === "pending") {
      throw new MxcPolicyAuthorizationPendingError(
        "MXC policy authorization has not been approved",
      );
    }
    const authorization = this.store.consume(nonce);
    if (!authorization) {
      throw new Error("MXC policy authorization is missing or expired");
    }
    if (authorization.approvalState === "pending") {
      throw new Error("MXC policy authorization has not been approved");
    }
    if (authorization.command.trim() !== params.command.trim()) {
      throw new Error("MXC policy authorization does not match the exec command");
    }
    return { authorization, env };
  }

  async consumeWhenApproved(params: { command: string; env: Record<string, string> }): Promise<{
    authorization?: MxcExecAuthorization;
    env: Record<string, string>;
  }> {
    const deadline = Date.now() + APPROVAL_SETTLEMENT_WAIT_MS;
    while (true) {
      try {
        return this.consume(params);
      } catch (error) {
        if (!(error instanceof MxcPolicyAuthorizationPendingError) || Date.now() >= deadline) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}

export function openMxcPolicyAuthorizationStore(
  openSyncKeyedStore: <T>(options: {
    namespace: string;
    maxEntries: number;
    overflowPolicy: "evict-oldest";
  }) => PluginStateSyncKeyedStore<T>,
): MxcPolicyAuthorizationStore {
  return new MxcPolicyAuthorizationStore(
    openSyncKeyedStore<MxcExecAuthorization>({
      namespace: "tool-policy-authorizations",
      maxEntries: MAX_PENDING_AUTHORIZATIONS,
      overflowPolicy: "evict-oldest",
    }),
  );
}
