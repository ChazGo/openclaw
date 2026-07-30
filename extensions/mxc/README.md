# @openclaw/mxc-sandbox

Official MXC sandbox execution plugin for OpenClaw.

This plugin lets OpenClaw run tool execution through MXC on Windows hosts with
ProcessContainer support.

## Install

```bash
openclaw plugins install @openclaw/mxc-sandbox
```

Restart the Gateway after installing or updating the plugin.

## Configure

After installing the plugin, configure an agent to use the `mxc` sandbox backend:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "mxc",
        workspaceAccess: "none",
      },
    },
  },
}
```

This plugin is an early prerelease for testing, so expect configuration and
readiness behavior to change as MXC host support matures.

## Package

- Plugin id: `mxc`
- Package: `@openclaw/mxc-sandbox`
- Minimum OpenClaw host: `2026.6.11`

## Plugin config

`plugins.entries.mxc.config` is validated with a strict schema: unknown keys
and out-of-range values fail plugin activation with an actionable error
(`Invalid mxc plugin config: <reason>`) instead of falling back silently.

| Field                   | Type                              | Default                                | Notes                                                                                                                                                         |
| ----------------------- | --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mxcBinaryPath`         | `string`                          | unset                                  | Non-empty override for the `wxc-exec.exe` executor path; see [SDK-only executor discovery](#supported).                                                       |
| `containment`           | `"process" \| "processcontainer"` | `"process"`                            | Both currently resolve to Windows ProcessContainer.                                                                                                           |
| `network`               | `"none" \| "default"`             | `"none"`                               | `"default"` allows outbound network via the `internetClient` capability.                                                                                      |
| `timeoutSeconds`        | `number`                          | unset (baseline default `300` applies) | Must be `>= 1` and `<= 2147000` (the largest Node-safe `setTimeout` delay in whole seconds). Capped to the sandbox policy baseline timeout when both are set. |
| `debug`                 | `boolean`                         | `false`                                | Forwards debug output from the MXC SDK launcher.                                                                                                              |
| `mxcPolicyPaths`        | `string[]`                        | unset (built-in baseline only)         | Every entry must be a non-empty absolute path. See [Sandbox policy files](#sandbox-policy-files).                                                             |
| `perToolSandboxEnabled` | `boolean`                         | `true`                                 | Selects per-tool MXC sandbox configurations stored in OpenClaw SQLite.                                                                                        |
| `auditLogPath`          | absolute `string`                 | `<state-dir>/logs/mxc-sandbox.jsonl`   | Metadata-only JSONL audit path.                                                                                                                               |

Any other key is rejected. `openclaw.plugin.json` publishes the same schema
(enums, `minimum`/`maximum` bounds) so `openclaw config` validation and CLI
help stay in sync with plugin runtime validation.

## Supported

- Windows hosts with the MXC executor installed through `@microsoft/mxc-sdk`.
- Explicit opt-in after plugin install with `sandbox.backend: "mxc"`.
- MXC `process` containment, which resolves to Windows ProcessContainer.
- `workspaceAccess`:
  - `none`: only the isolated sandbox workdir is mounted, read-only. There is
    no separate mount for the real agent workspace.
  - `ro`: the isolated sandbox workdir is mounted read-only, plus a distinct
    read-only mount of the real agent workspace whenever it differs from the
    sandbox workdir.
  - `rw`: the active agent workspace is mounted read-write. If protected
    OpenClaw skill roots (`skills`, `.agents/skills`, or the materialized
    sandbox skills workspace) exist beneath it, MXC fails the command before
    launch because ProcessContainer cannot enforce a nested read-only grant
    beneath a writable parent. The filesystem bridge also rejects writes to
    those protected paths.
  - Use policy `filesystem.additionalReadwritePaths` for additional explicit
    writable host paths shared by every MXC sandbox.
- `scope` workspace selection:
  - `session`, `agent`, and `shared` choose the OpenClaw workspace directory
    passed to MXC.
- SDK-only executor discovery from `@microsoft/mxc-sdk/bin/<arch>` or
  `@microsoft/mxc-sdk/bin`; use `mxcBinaryPath` only for an explicit override.
- OpenClaw passes per-run command, environment, and filesystem config to the
  plugin's Node launcher through a short-lived local payload file, and deletes
  that file and its temp directory when the launcher or run finishes.
- `@microsoft/mxc-sdk@0.7.0` then carries the full base64 request envelope on
  the native `wxc-exec` process argv. A host user with process-inspection rights
  can observe that command, environment, and policy data while the process is
  running. Do not put secrets in MXC command arguments or environment values
  until the SDK provides a non-argv transport
  ([microsoft/mxc#626](https://github.com/microsoft/mxc/issues/626)).
- Exact and per-tool wildcard sandbox configurations stored through OpenClaw
  plugin state in `state/openclaw.sqlite`.
- Configuration selection for every tool and containment enforcement for
  MXC-backed `exec` calls.

## Not supported yet

- Non-Windows hosts.
- Docker-style long-lived containers per `scope`. MXC ProcessContainer runs are
  per command; scope controls workspace reuse, not container lifetime.
- Host-list network rules.
- Nested denied or read-only paths beneath a writable MXC grant. The plugin
  fails the whole call before launch instead of claiming that ProcessContainer
  can enforce an ineffective nested overlay.

## Test setup with `openclaw config`

This patch creates a default `main` agent, then adds a dedicated `mxc-test`
agent so MXC testing does not change the default agent. It uses
[`openclaw config patch --stdin`](https://docs.openclaw.ai/cli/config#config-patch)
so setup is one validated config write instead of several path-based
`config set` commands.

If you already have `agents.list` entries, copy them into the patch before
`mxc-test` instead of replacing the list.

```powershell
$mxcPolicyPath = Join-Path $env:TEMP "openclaw-mxc-policy.json"
@'
{
  "filesystem": {
    "restrictToProjectDir": true,
    "additionalReadonlyPaths": [],
    "additionalReadwritePaths": []
  },
  "process": {
    "timeoutSeconds": 120
  }
}
'@ | Set-Content -Path $mxcPolicyPath -Encoding utf8

$mxcPolicyPathLiteral = ConvertTo-Json $mxcPolicyPath -Compress
$mxcConfigPatch = @"
{
  agents: {
    list: [
      {
        id: "main",
        workspace: "~/.openclaw/workspace",
      },
      {
        id: "mxc-test",
        workspace: "~/.openclaw/workspace-mxc-test",
        sandbox: {
          mode: "all",
          backend: "mxc",
          scope: "agent",
          workspaceAccess: "none",
        },
      },
    ],
  },
  plugins: {
    entries: {
      mxc: {
        enabled: true,
        config: {
          containment: "process",
          network: "none",
          mxcPolicyPaths: [$mxcPolicyPathLiteral],
        },
      },
    },
  },
}
"@

$mxcConfigPatch | openclaw config patch --stdin --dry-run
$mxcConfigPatch | openclaw config patch --stdin
```

Resulting config shape:

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
      },
      {
        "id": "mxc-test",
        "workspace": "~/.openclaw/workspace-mxc-test",
        "sandbox": {
          "mode": "all",
          "backend": "mxc",
          "scope": "agent",
          "workspaceAccess": "none",
        },
      },
    ],
  },
  "plugins": {
    "entries": {
      "mxc": {
        "enabled": true,
        "config": {
          "containment": "process",
          "network": "none",
          "mxcPolicyPaths": ["C:\\Users\\you\\AppData\\Local\\Temp\\openclaw-mxc-policy.json"],
        },
      },
    },
  },
}
```

## Sandbox policy files

MXC reads optional host policy files listed in
`plugins.entries.mxc.config.mxcPolicyPaths`. Policy files constrain the
filesystem and process defaults used by every MXC sandbox run on the host.
Omitting `mxcPolicyPaths` (or configuring an empty array) uses the built-in
sandbox baseline only; MXC never reads an implicit user or machine policy
path.

Every `mxcPolicyPaths` entry must be a non-empty absolute path; the plugin
fails to activate with an actionable error the moment a relative, empty, or
non-string entry is configured. JSON arrays preserve order, and MXC treats
that order as the policy layering order.

Once a sandbox backend is created for an agent, MXC reads every configured
policy file and fails closed instead of silently falling back to the
baseline:

- A configured policy file that does not exist on the host is an error
  (`Configured sandbox policy file <path> does not exist. Remove it from
mxcPolicyPaths or create the file.`), not a silent skip.
- A policy file that is malformed JSON or includes an unsupported field fails
  with an error naming the policy file path and the invalid field.
- Every `filesystem.additionalReadonlyPaths` and
  `filesystem.additionalReadwritePaths` entry must be an absolute Windows path
  that exists on the host at the time the sandbox activates; a missing path
  fails with an error naming the path, the policy file, and the field.

Example policy:

```json
{
  "filesystem": {
    "restrictToProjectDir": true,
    "additionalReadonlyPaths": ["C:\\Tools\\OpenClaw\\shared-readonly"],
    "additionalReadwritePaths": ["D:\\OpenClawScratch"]
  },
  "process": {
    "timeoutSeconds": 120
  }
}
```

Policy schema:

- `filesystem.restrictToProjectDir`: `true`, default `true`. Hardening-only.
  The default already restricts the sandbox to the project/workspace directory;
  policy files can assert `true` but cannot loosen this.
- `filesystem.additionalReadonlyPaths`: `string[]`, default `[]`. Extra host
  paths to expose read-only. Each path must be absolute and must already
  exist on the host.
- `filesystem.additionalReadwritePaths`: `string[]`, default `[]`. Extra host
  paths to expose read-write. Each path must be absolute and must already
  exist on the host, and must not overlap read-only roots or protected skill
  overlays.
- `process.timeoutSeconds`: positive `number`, default `300`. Per-command upper
  bound. Values must be finite and at least `1`.

Only the `filesystem` and `process` sections are supported. Unknown sections or
unknown fields are rejected so policy files fail closed when they drift from the
implemented MXC ProcessContainer surface.

When multiple configured policy files exist, OpenClaw layers them
deterministically in `mxcPolicyPaths` array order:

- readonly and read-write path arrays are appended and de-duplicated while
  preserving first-seen order.
- the effective timeout is the smallest value from the default and configured
  policy files.
- `restrictToProjectDir` remains enabled because the field is hardening-only.

The filesystem bridge keeps protected OpenClaw skill overlays read-only. For
command execution, MXC fails closed before launch when `workspaceAccess: "rw"`
or a configured read-write path overlaps a protected skill root, because
ProcessContainer cannot safely enforce the nested read-only grant.

## Per-tool sandbox configurations

Per-tool sandbox configurations are mutable runtime state, separate from the
static baseline files in `mxcPolicyPaths`. The plugin stores them in OpenClaw's
shared SQLite database under the `sandbox-configurations` plugin-state
namespace. Unmatched calls do not create rows, and the plugin does not impose a
practical application-level configuration count limit. MXC denies sandbox
access to the shared SQLite state directory and rejects per-tool grants that
overlap it.

Each call is matched in this order:

1. Exact tool name and canonical argument hash.
2. Wildcard configuration for the tool.
3. No match.

Object keys are sorted recursively before hashing, while array order remains
significant. An exact configuration takes precedence over a wildcard
configuration. Calls without a matching configuration use the existing MXC
sandbox configuration.

Create a wildcard configuration:

```powershell
openclaw mxc sandbox edit exec `
  --envelope '{"timeoutSeconds":30,"networkEnabled":false}'
```

Create an exact configuration:

```powershell
openclaw mxc sandbox edit exec `
  --args '{"command":"git status"}' `
  --envelope '{"timeoutSeconds":30,"readonlyPaths":["C:\\source"]}'
```

Inspect and manage configurations:

```powershell
openclaw mxc sandbox list
openclaw mxc sandbox show exec
openclaw mxc sandbox remove exec
```

Use `--args <json>` with `remove` to target one exact configuration. Omitting
`--args` removes every configuration for the tool.

Configuration envelopes support:

- `timeoutSeconds`
- `networkEnabled`
- `allowLocalNetwork`
- `capabilities`
- `deniedPaths`
- `readonlyPaths`
- `readwritePaths`

The selected configuration composes with the built-in MXC baseline. It can add
read-only paths, read-write paths, and capabilities required by the tool while
network access can only be narrowed and the lower timeout wins. Explicit denies
and protected OpenClaw runtime-state paths remain authoritative. An exact
writable root can be downgraded to read-only or denied. A narrower denied or
read-only child beneath a writable parent fails closed when the active
ProcessContainer filesystem tier cannot safely enforce that overlap.

For every `exec` while per-tool sandbox configuration is enabled, the plugin
injects an internal authorization nonce after ordinary parameter rewrites. The
MXC backend consumes
the nonce, verifies the command and effective configuration revision, strips it
from the child environment, and applies the selected configuration. A later
rewrite that drops the nonce fails closed because the backend cannot correlate
the call to the configuration selection. An expired, replayed, mismatched, or
stale nonce also fails closed. Calls with no matching configuration receive an
empty-envelope authorization and use the static MXC baseline.

Configuration-store read or record validation failures block the affected call.
Metadata-only audit records include tool identity, argument hash, correlation
ids, configuration match source, requested-access counts, duration, and success
state. They do not include raw arguments, command text, paths, secrets, or error
text.

Run the TUI as that agent:

```powershell
openclaw tui --session agent:mxc-test:main
```

For local embedded testing without a Gateway:

```powershell
openclaw tui --local --session agent:mxc-test:main
```

## Cleanup

If you used the exact sample above, remove the test agent and MXC plugin
configuration by patching the config back to the default-only shape:

```powershell
$mxcCleanupPatch = @'
{
  agents: {
    list: [
      {
        id: "main",
        workspace: "~/.openclaw/workspace",
      },
    ],
  },
  plugins: {
    entries: {
      mxc: null,
    },
  },
}
'@

$mxcCleanupPatch | openclaw config patch --stdin --dry-run
$mxcCleanupPatch | openclaw config patch --stdin
Remove-Item -Path $mxcPolicyPath -ErrorAction SilentlyContinue
```

## Host readiness

IsoEnvBroker must be available on the host OS. The plugin checks this before
registering the sandbox backend.

Host preparation is advisory. If directory listing inside the sandbox fails with
`Access is denied`, run this once from an elevated prompt:

```powershell
wxc-host-prep prepare-system-drive
```

`wxc-host-prep` ships with `@microsoft/mxc-sdk` under
`node_modules/@microsoft/mxc-sdk/bin/<arch>/`.

## Testing

```powershell
pnpm test:extension mxc
```

`pnpm test extensions/mxc` is equivalent and also works.

For per-tool sandbox configuration edits, the focused coverage is in:

```powershell
pnpm test:extension mxc extensions/mxc/test/config.test.ts extensions/mxc/test/sandbox-configuration-store.test.ts extensions/mxc/test/sandbox-configuration-authorization.test.ts extensions/mxc/test/sandbox-configuration-hooks.test.ts extensions/mxc/test/mxc-backend.test.ts
```
