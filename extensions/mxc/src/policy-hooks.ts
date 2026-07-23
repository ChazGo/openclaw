import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { MxcConfig } from "./config.js";
import { buildMxcPolicyApproval } from "./policy-approval.js";
import type { MxcAuditToolCall, MxcPolicyAudit } from "./policy-audit.js";
import { MxcPolicyAuthorizationStore, MXC_POLICY_NONCE_ENV } from "./policy-authorization.js";
import {
  computeMxcPolicyArgsHash,
  computeMxcPolicyRuleFingerprint,
  formatMxcPolicyArgsForApproval,
  type MxcPolicyStore,
  type MxcToolPolicyRule,
} from "./policy-store.js";

// Policy evaluation must observe every ordinary parameter rewrite. Trusted
// plugins run first; this absolute terminal priority prevents later mutation.
const MXC_POLICY_HOOK_PRIORITY = Number.NEGATIVE_INFINITY;

function execCommand(params: Record<string, unknown>): string | undefined {
  const command = params.command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

function stripAuthorizationNonce(params: Record<string, unknown>): Record<string, unknown> {
  const env = params.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return params;
  }
  const cleanEnv = { ...(env as Record<string, unknown>) };
  delete cleanEnv[MXC_POLICY_NONCE_ENV];
  return { ...params, env: cleanEnv };
}

function authorizeExec(
  authorizationStore: MxcPolicyAuthorizationStore,
  params: Record<string, unknown>,
  rule: MxcToolPolicyRule | undefined,
  argsHash: string,
  approvalState: "not-required" | "pending",
): { params: Record<string, unknown>; nonce: string } | undefined {
  if (rule && rule.toolName !== "exec") {
    return undefined;
  }
  const command = execCommand(params);
  if (!command) {
    throw new Error("MXC policy evaluation requires a non-empty exec command");
  }
  const acceptedFingerprints = rule ? [computeMxcPolicyRuleFingerprint(rule)] : [];
  if (rule && approvalState === "pending") {
    acceptedFingerprints.push(
      computeMxcPolicyRuleFingerprint({
        ...rule,
        decision: "allow",
        lifecycle: "settled",
      }),
    );
  }
  return authorizationStore.authorize(params, {
    toolName: "exec",
    argsHash,
    command,
    envelope: rule?.envelope ?? {},
    approvalState,
    ...(rule
      ? {
          policyRule: {
            argsHash: rule.argsHash,
            acceptedFingerprints,
          },
        }
      : {}),
  });
}

async function settleAllowIfCurrent(
  store: MxcPolicyStore,
  rule: MxcToolPolicyRule,
): Promise<MxcToolPolicyRule | undefined> {
  const expectedFingerprint = computeMxcPolicyRuleFingerprint(rule);
  const settled = await store.settleAllowIfUnchanged(rule, expectedFingerprint);
  if (settled) {
    return settled;
  }
  const current = await store.lookupExact(rule.toolName, rule.argsHash);
  const anticipatedFingerprint = computeMxcPolicyRuleFingerprint({
    ...rule,
    decision: "allow",
    lifecycle: "settled",
  });
  return current && computeMxcPolicyRuleFingerprint(current) === anticipatedFingerprint
    ? current
    : undefined;
}

export function registerMxcPolicyHooks(input: {
  api: OpenClawPluginApi;
  getConfig: () => MxcConfig;
  store: MxcPolicyStore;
  authorizationStore: MxcPolicyAuthorizationStore;
  audit: MxcPolicyAudit;
}): void {
  input.api.on(
    "before_tool_call",
    async (event, ctx) => {
      if (!input.getConfig().localPolicyEnabled) {
        return;
      }

      const params = stripAuthorizationNonce(event.params ?? {});
      let call: MxcAuditToolCall | undefined;
      try {
        const argsHash = computeMxcPolicyArgsHash(params);
        call = {
          toolName: event.toolName,
          argsHash,
          sessionId: ctx.sessionId,
          runId: event.runId ?? ctx.runId,
          toolCallId: event.toolCallId ?? ctx.toolCallId,
        };
        input.audit.emitRequested(call);

        const match = await input.store.lookup(event.toolName, argsHash);
        if (!match) {
          input.audit.emitDecision(call, "allow", "unmatched");
          const authorization = authorizeExec(
            input.authorizationStore,
            params,
            undefined,
            argsHash,
            "not-required",
          );
          return { params: authorization?.params ?? params };
        }

        if (match.rule.lifecycle === "settled") {
          await input.store.recordUse(match.rule);
          if (match.rule.decision === "deny") {
            input.audit.emitDecision(call, "deny", match.matchedBy);
            return {
              block: true,
              blockReason: `MXC policy denied ${event.toolName}`,
            };
          }
          const authorization = authorizeExec(
            input.authorizationStore,
            params,
            match.rule,
            argsHash,
            "not-required",
          );
          input.audit.emitDecision(call, "allow", match.matchedBy);
          return { params: authorization?.params ?? params };
        }

        if (input.getConfig().localPolicyAutoApprove) {
          const rule = await settleAllowIfCurrent(input.store, match.rule);
          if (!rule) {
            throw new Error("MXC policy changed during automatic approval");
          }
          await input.store.recordUse(rule);
          const authorization = authorizeExec(
            input.authorizationStore,
            params,
            rule,
            argsHash,
            "not-required",
          );
          input.audit.emitDecision(call, "allow", "automatic");
          return { params: authorization?.params ?? params };
        }

        const authorization = authorizeExec(
          input.authorizationStore,
          params,
          match.rule,
          argsHash,
          "pending",
        );
        const approval = buildMxcPolicyApproval({
          argsSummary: formatMxcPolicyArgsForApproval(params),
          rule: match.rule,
          config: input.getConfig(),
        });
        input.audit.emitDecision(call, "ask", match.matchedBy);
        return {
          ...(authorization ? { params: authorization.params } : {}),
          requireApproval: {
            ...approval,
            // Approval admits the current non-exec call. Only exec has a later
            // backend gate; this callback conditionally updates future policy.
            onResolution: async (resolution) => {
              input.audit.emitApproval(call!, resolution);
              if (resolution !== "allow-once" && resolution !== "allow-always") {
                if (authorization) {
                  input.authorizationStore.revoke(authorization.nonce);
                }
                return;
              }
              try {
                if (resolution === "allow-always") {
                  const settled = await settleAllowIfCurrent(input.store, match.rule);
                  if (!settled) {
                    if (authorization) {
                      input.authorizationStore.revoke(authorization.nonce);
                    }
                    return;
                  }
                  await input.store.recordUse(settled);
                } else {
                  const current = await input.store.lookupExact(
                    match.rule.toolName,
                    match.rule.argsHash,
                  );
                  if (
                    !current ||
                    computeMxcPolicyRuleFingerprint(current) !==
                      computeMxcPolicyRuleFingerprint(match.rule)
                  ) {
                    if (authorization) {
                      input.authorizationStore.revoke(authorization.nonce);
                    }
                    return;
                  }
                  await input.store.recordUse(current);
                }
                if (authorization) {
                  input.authorizationStore.approve(authorization.nonce);
                }
              } catch (error) {
                if (authorization) {
                  input.authorizationStore.revoke(authorization.nonce);
                }
                throw error;
              }
            },
          },
        };
      } catch (error) {
        if (call) {
          input.audit.emitDecision(call, "deny", "error");
        }
        input.api.logger.error(
          `[mxc] local policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          block: true,
          blockReason: "MXC local policy evaluation failed - fail-closed",
        };
      }
    },
    { priority: MXC_POLICY_HOOK_PRIORITY },
  );

  input.api.on(
    "after_tool_call",
    (event, ctx) => {
      if (!input.getConfig().localPolicyEnabled) {
        return;
      }
      const params = stripAuthorizationNonce(event.params ?? {});
      input.audit.emitCompleted({
        toolName: event.toolName,
        argsHash: computeMxcPolicyArgsHash(params),
        sessionId: ctx.sessionId,
        runId: event.runId ?? ctx.runId,
        toolCallId: event.toolCallId ?? ctx.toolCallId,
        durationMs: event.durationMs,
        error: event.error,
      });
    },
    { priority: MXC_POLICY_HOOK_PRIORITY },
  );
}
