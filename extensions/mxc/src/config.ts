import { posix, win32 } from "node:path";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { z } from "zod";
import {
  DEFAULT_MXC_SECURITY_LEVEL,
  getMxcSecurityPreset,
  MXC_SECURITY_LEVELS,
  type MxcSecurityLevel,
} from "./security-level.js";

const MXC_CONTAINMENTS = ["process", "processcontainer"] as const;
const MXC_NETWORK_MODES = ["none", "default"] as const;

type MxcContainment = (typeof MXC_CONTAINMENTS)[number];

type MxcNetworkMode = (typeof MXC_NETWORK_MODES)[number];

export type MxcConfig = {
  mxcBinaryPath?: string;
  securityLevel: MxcSecurityLevel;
  containment: MxcContainment;
  network: MxcNetworkMode;
  timeoutSeconds: number;
  debug: boolean;
  mxcPolicyPaths?: string[];
};

const DEFAULT_CONTAINMENT: MxcContainment = "process";
const DEFAULT_DEBUG = false;

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const MxcPluginConfigSchema = z.strictObject({
  securityLevel: z
    .enum(MXC_SECURITY_LEVELS, {
      error: `securityLevel must be one of ${MXC_SECURITY_LEVELS.join(", ")}`,
    })
    .describe("Windows-aligned baseline for network, standard folders, clipboard, and timeout.")
    .default(DEFAULT_MXC_SECURITY_LEVEL),
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
      "Optional restrictive preset override. 'none' blocks all network; 'default' retains the selected preset's outbound policy.",
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
      "Optional preset timeout override in seconds. Capped to the sandbox policy baseline timeout when both are set.",
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
    const preset = getMxcSecurityPreset(DEFAULT_MXC_SECURITY_LEVEL);
    return {
      mxcBinaryPath: undefined,
      securityLevel: DEFAULT_MXC_SECURITY_LEVEL,
      containment: DEFAULT_CONTAINMENT,
      network: preset.networkEnabled ? "default" : "none",
      timeoutSeconds: preset.timeoutSeconds,
      debug: DEFAULT_DEBUG,
    };
  }

  const parsed = MxcPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid mxc plugin config: ${message}`);
  }

  const config = parsed.data;
  const securityLevel = config.securityLevel ?? DEFAULT_MXC_SECURITY_LEVEL;
  const preset = getMxcSecurityPreset(securityLevel);
  const presetNetwork: MxcNetworkMode = preset.networkEnabled ? "default" : "none";
  const resolved: MxcConfig = {
    mxcBinaryPath: config.mxcBinaryPath,
    securityLevel,
    containment: config.containment ?? DEFAULT_CONTAINMENT,
    network: presetNetwork === "none" ? "none" : (config.network ?? presetNetwork),
    timeoutSeconds: config.timeoutSeconds ?? preset.timeoutSeconds,
    debug: config.debug ?? DEFAULT_DEBUG,
    mxcPolicyPaths: resolveMxcPolicyPaths(config.mxcPolicyPaths),
  };
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
