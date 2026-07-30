import { randomUUID } from "node:crypto";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MxcSandboxConfigurationEnvelope } from "./sandbox-configuration-types.js";

export const MXC_SANDBOX_CONFIGURATION_NONCE_ENV = "OPENCLAW_MXC_SANDBOX_CONFIGURATION_NONCE";

const AUTHORIZATION_TTL_MS = 11 * 60 * 1000;
const MAX_PENDING_AUTHORIZATIONS = 512;

export type MxcExecAuthorization = {
  toolName: "exec";
  argsHash: string;
  command: string;
  envelope: MxcSandboxConfigurationEnvelope;
  sandboxConfiguration?: {
    argsHash: string;
    fingerprint: string;
  };
};

export function stripMxcSandboxConfigurationAuthorizationEnv<T>(
  env: Record<string, T>,
): Record<string, T> {
  const cleanEnv = { ...env };
  delete cleanEnv[MXC_SANDBOX_CONFIGURATION_NONCE_ENV];
  return cleanEnv;
}

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

export function createMemoryMxcSandboxConfigurationAuthorizationStore(): MxcSandboxConfigurationAuthorizationStore {
  return new MxcSandboxConfigurationAuthorizationStore(new MemoryAuthorizationStore());
}

export class MxcSandboxConfigurationAuthorizationStore {
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
          [MXC_SANDBOX_CONFIGURATION_NONCE_ENV]: nonce,
        },
      },
    };
  }

  revoke(nonce: string): void {
    this.store.delete(nonce);
  }

  consume(params: { command: string; env: Record<string, string> }): {
    authorization?: MxcExecAuthorization;
    env: Record<string, string>;
  } {
    const nonce = params.env[MXC_SANDBOX_CONFIGURATION_NONCE_ENV];
    const env = stripMxcSandboxConfigurationAuthorizationEnv(params.env);
    if (!nonce) {
      return { env };
    }
    const authorization = this.store.consume(nonce);
    if (!authorization) {
      throw new Error("MXC sandbox configuration authorization is missing or expired");
    }
    if (authorization.command.trim() !== params.command.trim()) {
      throw new Error("MXC sandbox configuration authorization does not match the exec command");
    }
    return { authorization, env };
  }
}

export function openMxcSandboxConfigurationAuthorizationStore(
  openSyncKeyedStore: <T>(options: {
    namespace: string;
    maxEntries: number;
    overflowPolicy: "evict-oldest";
  }) => PluginStateSyncKeyedStore<T>,
): MxcSandboxConfigurationAuthorizationStore {
  return new MxcSandboxConfigurationAuthorizationStore(
    openSyncKeyedStore<MxcExecAuthorization>({
      namespace: "sandbox-configuration-authorizations",
      maxEntries: MAX_PENDING_AUTHORIZATIONS,
      overflowPolicy: "evict-oldest",
    }),
  );
}
