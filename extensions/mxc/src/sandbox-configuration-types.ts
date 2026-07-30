/** MXC containment settings selected for one tool call. */
export type MxcSandboxConfigurationEnvelope = {
  timeoutSeconds?: number;
  networkEnabled?: boolean;
  allowLocalNetwork?: boolean;
  capabilities?: string[];
  deniedPaths?: string[];
  readonlyPaths?: string[];
  readwritePaths?: string[];
};

const ENVELOPE_KEYS = new Set<keyof MxcSandboxConfigurationEnvelope>([
  "timeoutSeconds",
  "networkEnabled",
  "allowLocalNetwork",
  "capabilities",
  "deniedPaths",
  "readonlyPaths",
  "readwritePaths",
]);

function parseStringArray(
  envelope: Record<string, unknown>,
  key: "capabilities" | "deniedPaths" | "readonlyPaths" | "readwritePaths",
): string[] | undefined {
  const value = envelope[key];
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new Error(`MXC sandbox configuration ${key} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

export function parseMxcSandboxConfigurationEnvelope(
  value: unknown,
): MxcSandboxConfigurationEnvelope {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MXC sandbox configuration must be an object");
  }
  const envelope = value as Record<string, unknown>;
  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_KEYS.has(key as keyof MxcSandboxConfigurationEnvelope)) {
      throw new Error(`Unknown MXC sandbox configuration field: ${key}`);
    }
  }
  if (
    envelope.timeoutSeconds !== undefined &&
    (typeof envelope.timeoutSeconds !== "number" ||
      !Number.isFinite(envelope.timeoutSeconds) ||
      envelope.timeoutSeconds <= 0)
  ) {
    throw new Error("MXC sandbox configuration timeoutSeconds must be a positive number");
  }
  for (const key of ["networkEnabled", "allowLocalNetwork"] as const) {
    if (envelope[key] !== undefined && typeof envelope[key] !== "boolean") {
      throw new Error(`MXC sandbox configuration ${key} must be a boolean`);
    }
  }

  const parsed: MxcSandboxConfigurationEnvelope = {};
  if (typeof envelope.timeoutSeconds === "number") {
    parsed.timeoutSeconds = envelope.timeoutSeconds;
  }
  if (typeof envelope.networkEnabled === "boolean") {
    parsed.networkEnabled = envelope.networkEnabled;
  }
  if (typeof envelope.allowLocalNetwork === "boolean") {
    parsed.allowLocalNetwork = envelope.allowLocalNetwork;
  }
  for (const key of ["capabilities", "deniedPaths", "readonlyPaths", "readwritePaths"] as const) {
    const values = parseStringArray(envelope, key);
    if (values) {
      parsed[key] = values;
    }
  }
  return parsed;
}
