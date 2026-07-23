import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type MxcAuditToolCall = {
  toolName: string;
  argsHash: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
};

type AuditDecisionSource = "exact" | "wildcard" | "automatic" | "unmatched" | "error";

export class MxcPolicyAudit {
  private readonly logPath: string;
  private readonly warn: (message: string) => void;
  private writeQueue = Promise.resolve();

  constructor(input: { logPath: string; warn?: (message: string) => void }) {
    this.logPath = path.resolve(input.logPath);
    this.warn = input.warn ?? console.warn;
  }

  emitRequested(call: MxcAuditToolCall): void {
    this.write("mxc.policy.requested", call);
  }

  emitDecision(
    call: MxcAuditToolCall,
    decision: "allow" | "ask" | "deny",
    source: AuditDecisionSource,
  ): void {
    this.write("mxc.policy.decided", call, { decision, source });
  }

  emitApproval(call: MxcAuditToolCall, resolution: string): void {
    this.write("mxc.policy.approval", call, { resolution });
  }

  emitCompleted(input: MxcAuditToolCall & { durationMs?: number; error?: string }): void {
    this.write("mxc.policy.completed", input, {
      success: input.error == null,
      durationMs: input.durationMs,
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private write(
    eventType: string,
    call: MxcAuditToolCall,
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
          `[mxc] Failed to write policy audit event: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
