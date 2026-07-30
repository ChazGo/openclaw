import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { MxcConfig } from "./config.js";
import type {
  MxcSandboxConfigurationAudit,
  MxcSandboxConfigurationAuditCall,
} from "./sandbox-configuration-audit.js";
import {
  MxcSandboxConfigurationAuthorizationStore,
  MXC_SANDBOX_CONFIGURATION_NONCE_ENV,
  stripMxcSandboxConfigurationAuthorizationEnv,
} from "./sandbox-configuration-authorization.js";
import {
  computeMxcSandboxConfigurationArgsHash,
  computeMxcSandboxConfigurationFingerprint,
  type MxcSandboxConfigurationStore,
  type MxcToolSandboxConfiguration,
} from "./sandbox-configuration-store.js";

// Configuration selection must observe every ordinary parameter rewrite.
// This terminal priority prevents later mutation before tool execution.
const MXC_SANDBOX_CONFIGURATION_HOOK_PRIORITY = Number.NEGATIVE_INFINITY;

function execCommand(params: Record<string, unknown>): string | undefined {
  const command = params.command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

function stripAuthorizationNonce(params: Record<string, unknown>): Record<string, unknown> {
  const env = params.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return params;
  }
  return {
    ...params,
    env: stripMxcSandboxConfigurationAuthorizationEnv(env as Record<string, unknown>),
  };
}

function authorizeExec(
  authorizationStore: MxcSandboxConfigurationAuthorizationStore,
  params: Record<string, unknown>,
  argsHash: string,
  configuration: MxcToolSandboxConfiguration | undefined,
): Record<string, unknown> | undefined {
  const command = execCommand(params);
  if (!command) {
    return undefined;
  }
  return authorizationStore.authorize(params, {
    toolName: "exec",
    argsHash,
    command,
    envelope: configuration?.envelope ?? {},
    ...(configuration
      ? {
          sandboxConfiguration: {
            argsHash: configuration.argsHash,
            fingerprint: computeMxcSandboxConfigurationFingerprint(configuration),
          },
        }
      : {}),
  }).params;
}

export function registerMxcSandboxConfigurationHooks(input: {
  api: OpenClawPluginApi;
  getConfig: () => MxcConfig;
  store: MxcSandboxConfigurationStore;
  authorizationStore: MxcSandboxConfigurationAuthorizationStore;
  audit: MxcSandboxConfigurationAudit;
}): void {
  input.api.on(
    "before_tool_call",
    async (event, ctx) => {
      if (!input.getConfig().perToolSandboxEnabled) {
        return;
      }

      const params = stripAuthorizationNonce(event.params ?? {});
      let call: MxcSandboxConfigurationAuditCall | undefined;
      try {
        const argsHash = computeMxcSandboxConfigurationArgsHash(params);
        call = {
          toolName: event.toolName,
          argsHash,
          sessionId: ctx.sessionId,
          runId: event.runId ?? ctx.runId,
          toolCallId: event.toolCallId ?? ctx.toolCallId,
        };
        input.audit.emitRequested(call);

        const match = await input.store.lookup(event.toolName, argsHash);
        if (match) {
          await input.store.recordUse(match.configuration);
        }
        const envelope = match?.configuration.envelope ?? {};
        input.audit.emitSelected(call, match?.matchedBy ?? "unmatched", envelope);

        if (event.toolName !== "exec") {
          return;
        }
        const authorizedParams = authorizeExec(
          input.authorizationStore,
          params,
          argsHash,
          match?.configuration,
        );
        if (!authorizedParams) {
          throw new Error("MXC sandbox configuration requires a non-empty exec command");
        }
        return { params: authorizedParams };
      } catch (error) {
        if (call) {
          input.audit.emitSelected(call, "error", {});
        }
        input.api.logger.error(
          `[mxc] per-tool sandbox configuration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          block: true,
          blockReason: "MXC per-tool sandbox configuration failed - fail-closed",
        };
      }
    },
    { priority: MXC_SANDBOX_CONFIGURATION_HOOK_PRIORITY },
  );

  input.api.on(
    "after_tool_call",
    (event, ctx) => {
      if (!input.getConfig().perToolSandboxEnabled) {
        return;
      }
      const params = stripAuthorizationNonce(event.params ?? {});
      input.audit.emitCompleted({
        toolName: event.toolName,
        argsHash: computeMxcSandboxConfigurationArgsHash(params),
        sessionId: ctx.sessionId,
        runId: event.runId ?? ctx.runId,
        toolCallId: event.toolCallId ?? ctx.toolCallId,
        durationMs: event.durationMs,
        error: event.error,
      });
    },
    { priority: MXC_SANDBOX_CONFIGURATION_HOOK_PRIORITY },
  );
}
