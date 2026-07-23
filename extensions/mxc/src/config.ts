import { posix, win32 } from "node:path";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { z } from "zod";

const MXC_CONTAINMENTS = ["process", "processcontainer"] as const;
const MXC_NETWORK_MODES = ["none", "default"] as const;
const MXC_APPROVAL_SEVERITIES = ["info", "warning", "critical"] as const;

type MxcContainment = (typeof MXC_CONTAINMENTS)[number];

type MxcNetworkMode = (typeof MXC_NETWORK_MODES)[number];
type MxcApprovalSeverity = (typeof MXC_APPROVAL_SEVERITIES)[number];

type MxcPluginConfig = {
  mxcBinaryPath?: string;
  containment?: MxcContainment;
  network?: MxcNetworkMode;
  timeoutSeconds?: number;
  debug?: boolean;
  mxcPolicyPaths?: string[];
  localPolicyEnabled?: boolean;
  localPolicyAutoApprove?: boolean;
  approvalTimeoutMs?: number;
  approvalSeverity?: MxcApprovalSeverity;
  auditLogPath?: string;
};

export type MxcConfig = {
  mxcBinaryPath?: string;
  containment: MxcContainment;
  network: MxcNetworkMode;
  timeoutSeconds: number;
  timeoutSecondsConfigured?: boolean;
  debug: boolean;
  mxcPolicyPaths?: string[];
  localPolicyEnabled: boolean;
  localPolicyAutoApprove: boolean;
  approvalTimeoutMs: number;
  approvalSeverity: MxcApprovalSeverity;
  auditLogPath?: string;
};

const DEFAULT_CONTAINMENT: MxcContainment = "process";
const DEFAULT_NETWORK: MxcNetworkMode = "none";
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_DEBUG = false;
const DEFAULT_LOCAL_POLICY_ENABLED = true;
const DEFAULT_LOCAL_POLICY_AUTO_APPROVE = false;
const MAX_APPROVAL_TIMEOUT_MS = 600_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = MAX_APPROVAL_TIMEOUT_MS;
const DEFAULT_APPROVAL_SEVERITY: MxcApprovalSeverity = "warning";

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const MxcPluginConfigSchema = z.strictObject({
  mxcBinaryPath: nonEmptyTrimmedString("mxcBinaryPath must be a non-empty string")
    .describe(
      "Absolute path to the MXC executor (wxc-exec.exe). When unset, the executor is discovered from the installed @microsoft/mxc-sdk.",
    )
    .optional(),
  containment: z
    .enum(MXC_CONTAINMENTS, {
      error: `containment must be one of ${MXC_CONTAINMENTS.join(", ")}`,
    })
    .describe(
      "Windows containment mode. 'process' and 'processcontainer' currently both resolve to the Windows ProcessContainer sandbox.",
    )
    .optional(),
  network: z
    .enum(MXC_NETWORK_MODES, {
      error: `network must be one of ${MXC_NETWORK_MODES.join(", ")}`,
    })
    .describe(
      "Outbound network policy. 'none' blocks all network; 'default' allows outbound access via the internetClient capability.",
    )
    .optional(),
  timeoutSeconds: z
    .number({
      error: `timeoutSeconds must be a number between 1 and ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .min(1, { error: "timeoutSeconds must be a number >= 1" })
    .max(MAX_TIMER_TIMEOUT_SECONDS, {
      error: `timeoutSeconds must be a number <= ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .describe(
      "Per-command execution timeout in seconds. Capped to the sandbox policy baseline timeout when both are set.",
    )
    .optional(),
  debug: z
    .boolean({ error: "debug must be a boolean" })
    .describe("Forward verbose debug output from the MXC SDK launcher.")
    .optional(),
  mxcPolicyPaths: z
    .array(nonEmptyTrimmedString("mxcPolicyPaths must be an array of non-empty strings"), {
      error: "mxcPolicyPaths must be an array of non-empty strings",
    })
    .describe(
      "Absolute MXC policy file paths applied on top of the built-in sandbox baseline policy.",
    )
    .optional(),
  localPolicyEnabled: z
    .boolean({ error: "localPolicyEnabled must be a boolean" })
    .describe("Evaluate tool calls against the MXC local SQLite policy store.")
    .optional(),
  localPolicyAutoApprove: z
    .boolean({ error: "localPolicyAutoApprove must be a boolean" })
    .describe("Automatically settle matching development policies as allow.")
    .optional(),
  approvalTimeoutMs: z
    .number({ error: "approvalTimeoutMs must be a positive integer" })
    .int({ error: "approvalTimeoutMs must be a positive integer" })
    .min(1, { error: "approvalTimeoutMs must be a positive integer" })
    .max(MAX_APPROVAL_TIMEOUT_MS, {
      error: `approvalTimeoutMs must be <= ${MAX_APPROVAL_TIMEOUT_MS}`,
    })
    .describe("Timeout for MXC development-policy approvals.")
    .optional(),
  approvalSeverity: z
    .enum(MXC_APPROVAL_SEVERITIES, {
      error: `approvalSeverity must be one of ${MXC_APPROVAL_SEVERITIES.join(", ")}`,
    })
    .describe("Severity displayed for MXC development-policy approvals.")
    .optional(),
  auditLogPath: nonEmptyTrimmedString("auditLogPath must be a non-empty string")
    .describe("Optional absolute path for metadata-only MXC policy audit JSONL.")
    .optional(),
});

export function createMxcPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(MxcPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = MxcPluginConfigSchema.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        error: {
          issues: mapPluginConfigIssues(parsed.error.issues),
        },
      };
    },
  });
}

export function resolveConfig(value: unknown): MxcConfig {
  if (value === undefined) {
    return {
      mxcBinaryPath: undefined,
      containment: DEFAULT_CONTAINMENT,
      network: DEFAULT_NETWORK,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      debug: DEFAULT_DEBUG,
      localPolicyEnabled: DEFAULT_LOCAL_POLICY_ENABLED,
      localPolicyAutoApprove: DEFAULT_LOCAL_POLICY_AUTO_APPROVE,
      approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      approvalSeverity: DEFAULT_APPROVAL_SEVERITY,
    };
  }

  const parsed = MxcPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid mxc plugin config: ${message}`);
  }

  const config = parsed.data as MxcPluginConfig;
  const resolved: MxcConfig = {
    mxcBinaryPath: config.mxcBinaryPath,
    containment: config.containment ?? DEFAULT_CONTAINMENT,
    network: config.network ?? DEFAULT_NETWORK,
    timeoutSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    debug: config.debug ?? DEFAULT_DEBUG,
    mxcPolicyPaths: resolveMxcPolicyPaths(config.mxcPolicyPaths),
    localPolicyEnabled: config.localPolicyEnabled ?? DEFAULT_LOCAL_POLICY_ENABLED,
    localPolicyAutoApprove: config.localPolicyAutoApprove ?? DEFAULT_LOCAL_POLICY_AUTO_APPROVE,
    approvalTimeoutMs: config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    approvalSeverity: config.approvalSeverity ?? DEFAULT_APPROVAL_SEVERITY,
    auditLogPath: resolveOptionalAbsolutePath(config.auditLogPath, "auditLogPath"),
  };

  if (config.timeoutSeconds !== undefined) {
    resolved.timeoutSecondsConfigured = true;
  }

  function resolveOptionalAbsolutePath(
    value: string | undefined,
    field: string,
  ): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!isAbsolutePath(value)) {
      throw new Error(`Invalid mxc plugin config: ${field} must be an absolute path`);
    }
    return value;
  }

  return resolved;
}

function resolveMxcPolicyPaths(value: string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.map((entry, index) => {
    if (!isAbsolutePath(entry)) {
      throw new Error(
        `Invalid mxc plugin config: mxcPolicyPaths[${index}] must be an absolute path`,
      );
    }
    return entry;
  });
}

function isAbsolutePath(value: string): boolean {
  return win32.isAbsolute(value) || posix.isAbsolute(value);
}
