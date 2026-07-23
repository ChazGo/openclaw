import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  computeMxcPolicyArgsHash,
  type MxcPolicyDecision,
  type MxcPolicyStore,
  summarizeMxcPolicyArgs,
} from "./policy-store.js";
import { parseMxcExecutionEnvelope, type MxcExecutionEnvelope } from "./policy-types.js";

type RuleSelector = {
  argsHash: string;
  argsSummary: string;
};

function parseArgs(value: string | undefined): RuleSelector {
  if (!value) {
    return { argsHash: "", argsSummary: "(all arguments)" };
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--args must be a JSON object");
  }
  const args = parsed as Record<string, unknown>;
  return {
    argsHash: computeMxcPolicyArgsHash(args),
    argsSummary: summarizeMxcPolicyArgs(args),
  };
}

function parseDecision(value: string): MxcPolicyDecision {
  if (value !== "allow" && value !== "deny") {
    throw new Error("--decision must be allow or deny");
  }
  return value;
}

function parseEnvelope(value: string | undefined): MxcExecutionEnvelope {
  return parseMxcExecutionEnvelope(value ? JSON.parse(value) : {});
}

export function registerMxcPolicyCli(api: OpenClawPluginApi, getStore: () => MxcPolicyStore): void {
  api.registerCli(
    ({ program }) => {
      const mxc = program.command("mxc").description("Manage MXC sandbox policy");
      const policy = mxc.command("policy").description("Manage per-tool MXC policies");

      policy
        .command("list")
        .description("List saved policies")
        .action(async () => {
          const rules = await getStore().list();
          if (rules.length === 0) {
            console.log("(no MXC tool policies)");
            return;
          }
          for (const rule of rules) {
            console.log(
              `${rule.toolName}\t${rule.lifecycle}\t${rule.decision}\tuses=${rule.useCount}\t${rule.argsHash ? rule.argsSummary : "(all arguments)"}`,
            );
          }
        });

      policy
        .command("show <toolName>")
        .description("Show policies for one tool")
        .action(async (toolName: string) => {
          const rules = await getStore().list(toolName);
          if (rules.length === 0) {
            throw new Error(`No MXC policy for ${toolName}`);
          }
          console.log(JSON.stringify(rules, null, 2));
        });

      policy
        .command("edit <toolName>")
        .description("Create or replace a policy")
        .option("--args <json>", "Target one argument set; omit for a wildcard policy")
        .requiredOption("--decision <decision>", "Policy decision: allow or deny")
        .option("--envelope <json>", "MXC envelope JSON for allow policies", "{}")
        .option("--settled", "Apply the policy without prompting")
        .action(
          async (
            toolName: string,
            options: {
              args?: string;
              decision: string;
              envelope?: string;
              settled?: boolean;
            },
          ) => {
            const selector = parseArgs(options.args);
            const existing = await getStore().lookupExact(toolName, selector.argsHash);
            const rule = await getStore().upsert({
              toolName,
              ...selector,
              decision: parseDecision(options.decision),
              envelope: parseEnvelope(options.envelope),
              lifecycle: options.settled ? "settled" : (existing?.lifecycle ?? "development"),
              createdBy: existing?.createdBy ?? "imported",
            });
            console.log(JSON.stringify(rule, null, 2));
          },
        );

      policy
        .command("settle <toolName>")
        .description("Settle matching policies")
        .option("--args <json>", "Settle one argument set; omit for all policies for the tool")
        .action(async (toolName: string, options: { args?: string }) => {
          const store = getStore();
          const rules = options.args
            ? [await store.lookupExact(toolName, parseArgs(options.args).argsHash)].filter(
                (rule) => rule !== undefined,
              )
            : await store.list(toolName);
          if (rules.length === 0) {
            throw new Error(`No MXC policy for ${toolName}`);
          }
          for (const rule of rules) {
            await store.settle(toolName, rule.argsHash);
          }
          console.log(`Settled ${rules.length} MXC policy rule(s) for ${toolName}`);
        });

      policy
        .command("remove <toolName>")
        .description("Remove saved policies")
        .option("--args <json>", "Remove one argument set; omit for all policies for the tool")
        .action(async (toolName: string, options: { args?: string }) => {
          const store = getStore();
          const rules = options.args
            ? [await store.lookupExact(toolName, parseArgs(options.args).argsHash)].filter(
                (rule) => rule !== undefined,
              )
            : await store.list(toolName);
          if (rules.length === 0) {
            throw new Error(`No MXC policy for ${toolName}`);
          }
          for (const rule of rules) {
            await store.remove(toolName, rule.argsHash);
          }
          console.log(`Removed ${rules.length} MXC policy rule(s) for ${toolName}`);
        });
    },
    {
      descriptors: [
        {
          name: "mxc",
          description: "Manage MXC sandbox policy",
          hasSubcommands: true,
        },
      ],
    },
  );
}
