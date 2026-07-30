import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { MxcSandboxConfigurationEnvelope } from "./sandbox-configuration-types.js";

export type MxcSandboxConfigurationAuditCall = {
  toolName: string;
  argsHash: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
};

export type MxcSandboxConfigurationMatchSource = "exact" | "wildcard" | "unmatched" | "error";

export class MxcSandboxConfigurationAudit {
  private readonly logPath: string;
  private readonly warn: (message: string) => void;
  private writeQueue = Promise.resolve();

  constructor(input: { logPath: string; warn?: (message: string) => void }) {
    this.logPath = path.resolve(input.logPath);
    this.warn = input.warn ?? console.warn;
  }

  emitRequested(call: MxcSandboxConfigurationAuditCall): void {
    this.write("mxc.sandbox.requested", call);
  }

  emitSelected(
    call: MxcSandboxConfigurationAuditCall,
    source: MxcSandboxConfigurationMatchSource,
    envelope: MxcSandboxConfigurationEnvelope,
  ): void {
    this.write("mxc.sandbox.selected", call, {
      source,
      requestedAccess: summarizeRequestedAccess(envelope),
    });
  }

  emitCompleted(
    input: MxcSandboxConfigurationAuditCall & { durationMs?: number; error?: string },
  ): void {
    this.write("mxc.sandbox.completed", input, {
      success: input.error == null,
      durationMs: input.durationMs,
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private write(
    eventType: string,
    call: MxcSandboxConfigurationAuditCall,
    details?: Record<string, unknown>,
  ): void {
    const entry = {
      eventType,
      timestamp: new Date().toISOString(),
      sessionId: call.sessionId ?? "",
      runId: call.runId,
      toolCallId: call.toolCallId,
      action: {
        kind: "tool_call",
        name: call.toolName,
        argsHash: call.argsHash || undefined,
      },
      ...details,
    };
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(path.dirname(this.logPath), { recursive: true });
        await appendFile(this.logPath, `${JSON.stringify(entry)}\n`);
      })
      .catch((error: unknown) => {
        this.warn(
          `[mxc] Failed to write sandbox configuration audit event: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}

function summarizeRequestedAccess(envelope: MxcSandboxConfigurationEnvelope) {
  return {
    timeoutSeconds: envelope.timeoutSeconds,
    networkEnabled: envelope.networkEnabled,
    allowLocalNetwork: envelope.allowLocalNetwork,
    capabilityCount: envelope.capabilities?.length ?? 0,
    deniedPathCount: envelope.deniedPaths?.length ?? 0,
    readonlyPathCount: envelope.readonlyPaths?.length ?? 0,
    readwritePathCount: envelope.readwritePaths?.length ?? 0,
  };
}
