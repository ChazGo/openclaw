import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("mxc plugin entry", () => {
  it("stays startup-off until the plugin entry is explicitly enabled", () => {
    expect(manifest.activation).toEqual({
      onStartup: false,
      onConfigPaths: ["plugins.entries.mxc"],
    });
  });

  it("keeps entry metadata aligned with the manifest", () => {
    expect(plugin.id).toBe(manifest.id);
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.description).toBe(
      "OS-level sandboxed tool execution via MXC: runs commands in a Windows ProcessContainer with configured MXC policy files.",
    );
  });

  it("wires the runtime config schema into the plugin entry and manifest", () => {
    expect(plugin.configSchema?.jsonSchema).toEqual(manifest.configSchema);
  });

  it("publishes the security preset contract", () => {
    expect(manifest.configSchema.properties.securityLevel).toMatchObject({
      enum: ["Locked Down", "Recommended", "Unprotected"],
      default: "Recommended",
    });
    expect(manifest.configContracts.dangerousFlags).toContainEqual({
      path: "securityLevel",
      equals: "Unprotected",
    });
    expect(manifest.uiHints.securityLevel).toMatchObject({
      label: "Default sandbox security",
    });
    expect(manifest.uiHints.securityLevel).not.toHaveProperty("advanced");
    expect(manifest.uiHints.network.advanced).toBe(true);
  });
});
