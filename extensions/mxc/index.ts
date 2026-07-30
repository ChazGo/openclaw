import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMxcPluginConfigSchema } from "./src/config.js";
import { registerMxcPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "mxc",
  name: "MXC Sandbox Execution",
  description:
    "OS-level sandboxed tool execution via MXC with static policy files and per-tool sandbox configurations.",
  configSchema: createMxcPluginConfigSchema(),
  register: registerMxcPlugin,
});
