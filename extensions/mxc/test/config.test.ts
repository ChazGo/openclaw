import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, test } from "vitest";
import { createMxcPluginConfigSchema, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  test("uses defaults only when config is omitted", () => {
    expect(resolveConfig(undefined)).toEqual({
      mxcBinaryPath: undefined,
      securityLevel: "Recommended",
      containment: "process",
      network: "default",
      timeoutSeconds: 60,
      debug: false,
    });

    const config = resolveConfig({});
    expect(config).toEqual({
      mxcBinaryPath: undefined,
      securityLevel: "Recommended",
      containment: "process",
      network: "default",
      timeoutSeconds: 60,
      debug: false,
      mxcPolicyPaths: undefined,
    });
  });

  test("applies valid overrides", () => {
    const config = resolveConfig({
      securityLevel: "Unprotected",
      mxcBinaryPath: "  C:\\custom\\wxc-exec.exe  ",
      containment: "processcontainer",
      network: "default",
      timeoutSeconds: 60,
      debug: true,
      mxcPolicyPaths: [
        "  C:\\ProgramData\\openclaw\\mxc-machine-policy.json  ",
        "  /opt/openclaw/mxc-user-policy.json  ",
      ],
    });

    expect(config).toEqual({
      mxcBinaryPath: "C:\\custom\\wxc-exec.exe",
      securityLevel: "Unprotected",
      containment: "processcontainer",
      network: "default",
      timeoutSeconds: 60,
      debug: true,
      mxcPolicyPaths: [
        "C:\\ProgramData\\openclaw\\mxc-machine-policy.json",
        "/opt/openclaw/mxc-user-policy.json",
      ],
    });
  });

  test("does not allow the network override to weaken Locked Down", () => {
    expect(resolveConfig({ securityLevel: "Locked Down", network: "default" }).network).toBe(
      "none",
    );
    expect(resolveConfig({ securityLevel: "Recommended", network: "none" }).network).toBe("none");
  });

  test.each([
    ["Locked Down", "none", 30],
    ["Recommended", "default", 60],
    ["Unprotected", "default", 300],
  ] as const)("maps the %s preset defaults", (securityLevel, network, timeoutSeconds) => {
    expect(resolveConfig({ securityLevel })).toEqual({
      mxcBinaryPath: undefined,
      securityLevel,
      containment: "process",
      network,
      timeoutSeconds,
      debug: false,
      mxcPolicyPaths: undefined,
    });
  });

  test("rejects invalid root values and unknown keys", () => {
    expect(() => resolveConfig(null)).toThrow(/Invalid mxc plugin config/u);
    expect(() => resolveConfig("bad")).toThrow(/Invalid mxc plugin config/u);
    expect(() => resolveConfig({ sandboxBaseline: {} })).toThrow(/sandboxBaseline/u);
  });

  test("rejects removed and malformed containment values", () => {
    for (const containment of [
      "windows_sandbox",
      "wslc",
      "microvm",
      "seatbelt",
      "isolation_session",
      "lxc",
      "invalid",
    ]) {
      expect(() => resolveConfig({ containment })).toThrow(/containment/u);
    }
  });

  test("rejects malformed enums and types instead of silently falling back", () => {
    expect(() => resolveConfig({ network: "allow-all" })).toThrow(/network/u);
    expect(() => resolveConfig({ securityLevel: "Balanced" })).toThrow(/securityLevel/u);
    expect(() => resolveConfig({ debug: "true" })).toThrow(/debug/u);
    expect(() => resolveConfig({ mxcBinaryPath: "   " })).toThrow(/mxcBinaryPath/u);
  });

  test("enforces timeout bounds", () => {
    expect(() => resolveConfig({ timeoutSeconds: 0 })).toThrow(/>= 1/u);
    expect(() => resolveConfig({ timeoutSeconds: -5 })).toThrow(/>= 1/u);
    expect(() => resolveConfig({ timeoutSeconds: "fast" })).toThrow(/timeoutSeconds/u);
    expect(() => resolveConfig({ timeoutSeconds: MAX_TIMER_TIMEOUT_SECONDS + 1 })).toThrow(
      new RegExp(`${MAX_TIMER_TIMEOUT_SECONDS}`, "u"),
    );

    const config = resolveConfig({ timeoutSeconds: MAX_TIMER_TIMEOUT_SECONDS });
    expect(config.timeoutSeconds).toBe(MAX_TIMER_TIMEOUT_SECONDS);
  });

  test("trims and validates mxcPolicyPaths as absolute paths", () => {
    expect(() => resolveConfig({ mxcPolicyPaths: "C:\\policy.json" })).toThrow(/mxcPolicyPaths/u);
    expect(() => resolveConfig({ mxcPolicyPaths: ["relative-policy.json"] })).toThrow(
      /mxcPolicyPaths\[0\]/u,
    );
    expect(() => resolveConfig({ mxcPolicyPaths: ["   "] })).toThrow(/mxcPolicyPaths/u);
    expect(() => resolveConfig({ mxcPolicyPaths: [42] })).toThrow(/mxcPolicyPaths/u);
  });
});

describe("createMxcPluginConfigSchema", () => {
  test("publishes preset and timeout contracts in the plugin schema", () => {
    const jsonSchema = createMxcPluginConfigSchema().jsonSchema as {
      properties?: { securityLevel?: unknown; timeoutSeconds?: unknown };
    };
    expect(jsonSchema.properties?.securityLevel).toEqual({
      type: "string",
      enum: ["Locked Down", "Recommended", "Unprotected"],
      default: "Recommended",
      description:
        "Windows-aligned baseline for network, standard folders, clipboard, and timeout.",
    });
    expect(jsonSchema.properties?.timeoutSeconds).toEqual({
      type: "number",
      minimum: 1,
      maximum: MAX_TIMER_TIMEOUT_SECONDS,
      description:
        "Optional preset timeout override in seconds. Capped to the sandbox policy baseline timeout when both are set.",
    });
  });
});
