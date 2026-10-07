---
summary: "OS-level sandboxed tool execution via MXC: runs commands in a Windows ProcessContainer with configured MXC policy files."
read_when:
  - You are installing, configuring, or auditing the mxc plugin
title: "Mxc plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

OS-level sandboxed tool execution via MXC: runs commands in a Windows ProcessContainer with configured MXC policy files.

## Distribution

- Package: `@openclaw/mxc-sandbox`
- Install route: npm or ClawHub: `clawhub:@openclaw/mxc-sandbox`

## Surface

This plugin declares no channels, providers, commands, or contracts.

<!-- openclaw-plugin-reference:manual-start -->

## Per-agent sandbox policy

Configure `plugins.entries.mxc.config.agents.<agentId>` with optional `network`
(`"none"` or `"default"`), `timeoutSeconds` (1 through 2147000), and
`mxcPolicyPaths` (absolute policy file paths). Keys must match
`^[a-z0-9_][a-z0-9_-]{0,63}$`, including underscore-prefixed IDs.
Unsafe object keys (`__proto__`, `prototype`, and `constructor`), malformed values,
and unknown fields fail validation. Binary discovery, containment, and debug remain plugin-wide.

Every override must name an agent in the live roster. MXC checks this each time it
creates a backend handle (when a sandboxed turn or command needs one), not at plugin
registration, so adding, removing, or renaming an agent does not reload plugins.
While any override names an unconfigured agent, every MXC backend creation fails with
`Invalid mxc plugin config: unknown agent ID "<id>"`. Configure the agent or remove the
override. `openclaw sandbox explain` creates no MXC backend, so it does not report this.

```json5
{
  agents: {
    entries: {
      analyst: {
        sandbox: { mode: "all", backend: "mxc", scope: "agent", workspaceAccess: "none" },
      },
    },
  },
  plugins: {
    entries: {
      mxc: {
        enabled: true,
        config: {
          agents: {
            analyst: { network: "none", timeoutSeconds: 20, mxcPolicyPaths: [] },
          },
        },
      },
    },
  },
}
```

Plugin-wide settings are defaults, not mandatory common constraints. Missing
entries or fields inherit them. An explicit policy file list replaces the
default list, including `[]` (built-in baseline only). It does not union default
filesystem grants into every agent. Within the selected list, existing policy
composition retains hardening and the smallest timeout cap. Missing or malformed
selected files fail closed when a backend handle is created.

Overrides require a host that passes resolved `agentId` to sandbox factories;
missing context with a nonempty map fails closed. Selected overrides reject
effective shared scope; role-required or private-skill paths forced to isolated
scope still work. Shared scope without a selected override is unchanged.

Each handle snapshots its policy files. File edits do not revoke existing handles
or in-flight commands. Native containers remain per-command and destroy on exit.
Internal shell helpers always block network and cap timeouts at the smallest of
30 seconds, configured timeout, and selected baseline timeout.

Common writable workspaces and host/elevated tools are outside this separation
guarantee. Exec policy grants do not add filesystem-tool mounts; protected skill
roots and filesystem bridge checks remain enforced. Unit launcher-payload tests
alone are not proof of Windows OS isolation.

<!-- openclaw-plugin-reference:manual-end -->
