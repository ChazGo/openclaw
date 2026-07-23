import type { MxcConfig } from "./config.js";
import type { MxcToolPolicyRule } from "./policy-store.js";

const APPROVAL_DESCRIPTION_MAX_LENGTH = 256;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

export function buildMxcPolicyApproval(input: {
  argsSummary: string;
  rule: MxcToolPolicyRule;
  config: MxcConfig;
}): {
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  timeoutMs: number;
  timeoutReason: string;
  allowedDecisions: Array<"allow-once" | "allow-always" | "deny">;
} {
  const network =
    input.rule.envelope.networkEnabled == null
      ? "net=inherit"
      : input.rule.envelope.networkEnabled
        ? "net=on"
        : "net=off";
  const description = truncate(
    `development ${input.rule.decision} rule; args=${truncate(input.argsSummary, 64)}; ${network}; uses=${input.rule.useCount}`,
    APPROVAL_DESCRIPTION_MAX_LENGTH,
  );
  return {
    title: `MXC policy: confirm ${input.rule.toolName}`,
    description,
    severity: input.config.approvalSeverity,
    timeoutMs: input.config.approvalTimeoutMs,
    timeoutReason: "MXC policy approval timed out",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  };
}
