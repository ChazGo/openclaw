import path from "node:path";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { resolveMxcBinaryPath } from "./binary-resolver.js";
import { resolveConfig } from "./config.js";
import { createMxcSandboxBackendFactory } from "./mxc-backend-factory.js";
import { mxcSandboxBackendManager } from "./mxc-backend.js";
import { MxcPolicyAudit } from "./policy-audit.js";
import { openMxcPolicyAuthorizationStore } from "./policy-authorization.js";
import { registerMxcPolicyCli } from "./policy-cli.js";
import { registerMxcPolicyHooks } from "./policy-hooks.js";
import { openMxcPolicyStore } from "./policy-store.js";
import { assertMxcReadiness, warnMxcHostPrepIfNeeded } from "./readiness.js";

export function registerMxcPlugin(api: OpenClawPluginApi): void {
  if (api.registrationMode !== "full") {
    return;
  }

  const config = resolveConfig(api.pluginConfig);
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  const store = openMxcPolicyStore((options) => api.runtime.state.openKeyedStore(options));
  const authorizationStore = openMxcPolicyAuthorizationStore((options) =>
    api.runtime.state.openSyncKeyedStore(options),
  );
  registerMxcPolicyCli(api, () => store);

  if (process.platform !== "win32") {
    console.warn(
      `[mxc] Sandbox backend is Windows-only and not available on ${process.platform}. Plugin will be dormant.`,
    );
    return;
  }

  // IsoEnvBroker availability is the ProcessContainer readiness signal for this plugin.
  // Binary and host readiness checks fail load with actionable remediation.
  try {
    resolveMxcBinaryPath(config.mxcBinaryPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[mxc] MXC sandbox backend cannot load: ${reason}. Install @microsoft/mxc-sdk or set mxcBinaryPath.`,
      { cause: err },
    );
  }
  assertMxcReadiness();

  // Advisory: warn (don't block) when the system drive lacks AppContainer
  // directory-access ACEs, which only degrades in-sandbox directory listing.
  warnMxcHostPrepIfNeeded();

  const audit = new MxcPolicyAudit({
    logPath: config.auditLogPath ?? path.join(stateDir, "logs", "mxc-policy.jsonl"),
    warn: (message) => api.logger.warn(message),
  });
  registerMxcPolicyHooks({
    api,
    getConfig: () => resolveConfig(api.pluginConfig),
    store,
    authorizationStore,
    audit,
  });

  // Register the backend
  const unregister = registerSandboxBackend("mxc", {
    factory: createMxcSandboxBackendFactory(
      config,
      authorizationStore,
      store,
      path.join(stateDir, "state"),
    ),
    manager: mxcSandboxBackendManager,
  });

  // Cleanup service unregisters backend on shutdown.
  const cleanupService: OpenClawPluginService = {
    id: "mxc-sandbox-cleanup",
    start() {
      /* no-op */
    },
    stop() {
      unregister();
      return audit.flush();
    },
  };
  api.registerService(cleanupService);
}
