import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  computeMxcSandboxConfigurationArgsHash,
  type MxcSandboxConfigurationStore,
  summarizeMxcSandboxConfigurationArgs,
} from "./sandbox-configuration-store.js";
import {
  parseMxcSandboxConfigurationEnvelope,
  type MxcSandboxConfigurationEnvelope,
} from "./sandbox-configuration-types.js";

type ConfigurationSelector = {
  argsHash: string;
  argsSummary: string;
};

function parseArgs(value: string | undefined): ConfigurationSelector {
  if (!value) {
    return { argsHash: "", argsSummary: "(all arguments)" };
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--args must be a JSON object");
  }
  const args = parsed as Record<string, unknown>;
  return {
    argsHash: computeMxcSandboxConfigurationArgsHash(args),
    argsSummary: summarizeMxcSandboxConfigurationArgs(args),
  };
}

function parseEnvelope(value: string): MxcSandboxConfigurationEnvelope {
  return parseMxcSandboxConfigurationEnvelope(JSON.parse(value));
}

export function registerMxcSandboxConfigurationCli(
  api: OpenClawPluginApi,
  getStore: () => MxcSandboxConfigurationStore,
): void {
  api.registerCli(
    ({ program }) => {
      const mxc = program.command("mxc").description("Manage MXC sandbox execution");
      const sandbox = mxc
        .command("sandbox")
        .description("Manage per-tool MXC sandbox configurations");

      sandbox
        .command("list")
        .description("List saved sandbox configurations")
        .action(async () => {
          const configurations = await getStore().list();
          if (configurations.length === 0) {
            console.log("(no MXC per-tool sandbox configurations)");
            return;
          }
          for (const configuration of configurations) {
            console.log(
              `${configuration.toolName}\tuses=${configuration.useCount}\t${configuration.argsHash ? configuration.argsSummary : "(all arguments)"}`,
            );
          }
        });

      sandbox
        .command("show <toolName>")
        .description("Show sandbox configurations for one tool")
        .action(async (toolName: string) => {
          const configurations = await getStore().list(toolName);
          if (configurations.length === 0) {
            throw new Error(`No MXC sandbox configuration for ${toolName}`);
          }
          console.log(JSON.stringify(configurations, null, 2));
        });

      sandbox
        .command("edit <toolName>")
        .description("Create or replace a sandbox configuration")
        .option("--args <json>", "Target one argument set; omit for a wildcard configuration")
        .requiredOption("--envelope <json>", "MXC sandbox configuration JSON")
        .action(async (toolName: string, options: { args?: string; envelope: string }) => {
          const configuration = await getStore().upsert({
            toolName,
            ...parseArgs(options.args),
            envelope: parseEnvelope(options.envelope),
          });
          console.log(JSON.stringify(configuration, null, 2));
        });

      sandbox
        .command("remove <toolName>")
        .description("Remove saved sandbox configurations")
        .option(
          "--args <json>",
          "Remove one argument set; omit for all configurations for the tool",
        )
        .action(async (toolName: string, options: { args?: string }) => {
          const store = getStore();
          const configurations = options.args
            ? [await store.lookupExact(toolName, parseArgs(options.args).argsHash)].filter(
                (configuration) => configuration !== undefined,
              )
            : await store.list(toolName);
          if (configurations.length === 0) {
            throw new Error(`No MXC sandbox configuration for ${toolName}`);
          }
          for (const configuration of configurations) {
            await store.remove(toolName, configuration.argsHash);
          }
          console.log(
            `Removed ${configurations.length} MXC sandbox configuration(s) for ${toolName}`,
          );
        });
    },
    {
      descriptors: [
        {
          name: "mxc",
          description: "Manage MXC sandbox execution",
          hasSubcommands: true,
        },
      ],
    },
  );
}
