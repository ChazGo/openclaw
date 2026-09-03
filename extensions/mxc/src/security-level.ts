export const MXC_SECURITY_LEVELS = ["Locked Down", "Recommended", "Unprotected"] as const;

export type MxcSecurityLevel = (typeof MXC_SECURITY_LEVELS)[number];
export type MxcClipboardAccess = "none" | "read" | "all";
export type MxcStandardFolderAccess = "none" | "readonly" | "readwrite";

export const DEFAULT_MXC_SECURITY_LEVEL: MxcSecurityLevel = "Recommended";

export type MxcSecurityPreset = {
  networkEnabled: boolean;
  standardFolderAccess: MxcStandardFolderAccess;
  clipboard: MxcClipboardAccess;
  timeoutSeconds: number;
};

const PRESETS: Record<MxcSecurityLevel, MxcSecurityPreset> = {
  "Locked Down": {
    networkEnabled: false,
    standardFolderAccess: "none",
    clipboard: "none",
    timeoutSeconds: 30,
  },
  Recommended: {
    networkEnabled: true,
    standardFolderAccess: "readonly",
    clipboard: "read",
    timeoutSeconds: 60,
  },
  Unprotected: {
    networkEnabled: true,
    standardFolderAccess: "readwrite",
    clipboard: "all",
    timeoutSeconds: 300,
  },
};

export function getMxcSecurityPreset(level: MxcSecurityLevel): MxcSecurityPreset {
  return PRESETS[level];
}
