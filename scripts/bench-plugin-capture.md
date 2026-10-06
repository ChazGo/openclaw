# Windows plugin capture benchmarks

Two harnesses measure the cost of capturing a plugin's source and dependency closure
at Gateway startup, and whether prepared model runtime publication stays within its
120 s budget. Use them to compare a base checkout (before) against a candidate
checkout (after) on the same machine and plugin.

Neither harness touches `~/.openclaw` or a running Gateway. Gateway starts use a fresh
`mkdtemp` state root with `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`,
`TEMP`, and `TMP` pointed inside it. The plugin install step reuses your npm registry
configuration (`USERPROFILE`, `APPDATA`, and `npm_config_*`).

## Setup

Build both checkouts with the same Node version (`node -v` is recorded in the output):

```powershell
git worktree add ..\openclaw-before <base-commit>
foreach ($checkout in '..\openclaw-before', '.') {
  pnpm -C $checkout install --frozen-lockfile
  pnpm -C $checkout build
}
```

Record Microsoft Defender's state with each result, because it dominates unexcluded
captures:

```powershell
Get-MpPreference | Select-Object ExclusionPath, ExclusionProcess, DisableRealtimeMonitoring |
  ConvertTo-Json | Set-Content bench-out\defender.json
```

Run each harness from the candidate checkout. `--checkout` selects which build is
measured.

## Gateway cold start with one plugin

`scripts/bench-gateway-plugin-publication.ts` installs one plugin into an isolated
state root, then starts the Gateway `--starts` times on that state. Start 1 is the first
start after install. It reports `modelRuntimeMs` (the `sidecars.model-runtime` startup
trace phase), `buildStatsAtMs` (when the publication build reported its stats), any
publication timeout, degraded-startup, or `startup_failed` lines, and `withinBudget`.

A fast `modelRuntimeMs` is not a pass on its own: a plugin rejected during capture or
admission leaves publication fast and empty. With a plugin installed, each start also
reports `pluginLoaded`, `pluginLoadMs`, and `pluginFailureLines`. `pluginLoaded` requires
the loader's `plugins.gateway-load.plugin.<id>` trace (load and register timed, zero
failure counts), a `sidecars.model-runtime` phase, and no capture or admission
rejection lines (for example "Native plugin companion changed before admission
completed"). `withinBudget` is false whenever `pluginLoaded` is false.

From a source checkout, a bundled plugin with the same id outranks the installed one.
The harness moves `dist\extensions\<id>` and `dist-runtime\extensions\<id>` into
`.bench-hidden-bundled\` before `plugins install` (whose post-load otherwise rejects the
installed package) and keeps them there through the starts, restoring them afterward
(including after an interrupted run, on the next invocation); the JSON lists them in
`hiddenBundled`. `--keep-bundled` disables this. The plugin id comes from `--plugin-id`,
else the source `extensions\*` package whose name matches the install spec, else the
installed `openclaw.plugin.json`.

```powershell
New-Item -ItemType Directory -Force bench-out | Out-Null
node --import ./scripts/tsx.mjs scripts/bench-gateway-plugin-publication.ts `
  --checkout ..\openclaw-before --install-spec "@openclaw/acpx@2026.9.5" `
  --starts 3 --label before --output bench-out\publication-before.json
node --import ./scripts/tsx.mjs scripts/bench-gateway-plugin-publication.ts `
  --checkout . --install-spec "@openclaw/acpx@2026.9.5" `
  --starts 3 --label after --output bench-out\publication-after.json
```

Add `--no-plugin` instead of `--install-spec` for the baseline Gateway without a plugin.
Extra install flags pass through with `--install-arg <flag>` (repeatable). The state
root and per-start logs (`logs\gateway-start-N.log`, `logs\install.log`) are kept and
printed; delete the root when finished. `--timeout-ms` (default 600000) bounds each
start.

Some Windows hosts stamp a file's NTFS ctime on its first read (on-access scanning),
which makes native admission reject freshly captured files ("Native plugin companion
changed before admission completed"). `--warm-read` reads every file under the isolated
state root before each start (`warmReadMs`, not included in the start's timings). It
settles installed and retained files only: capture copies the Gateway creates during the
start can still be stamped, so it is a diagnostic, not a way around that rejection.

The JSON's `pluginRoot` is the installed package directory for the capture harness.

## Capture copy and verification

`scripts/bench-plugin-capture.ts` runs the startup capture path
(`capturePluginGenerationArtifact` with no entry: the whole package body and its
dependency closure) against an installed plugin, then re-verifies the captured inputs.
It counts synchronous `fs` calls per phase.

```powershell
$pluginRoot = (Get-Content bench-out\publication-after.json | ConvertFrom-Json).pluginRoot
node --import ./scripts/tsx.mjs scripts/bench-plugin-capture.ts `
  --checkout ..\openclaw-before --plugin-root $pluginRoot `
  --runs 3 --reverify 2 --label before --output bench-out\capture-before.json
node --import ./scripts/tsx.mjs scripts/bench-plugin-capture.ts `
  --checkout . --plugin-root $pluginRoot `
  --runs 3 --reverify 2 --label after --output bench-out\capture-after.json
```

`median.captureMs` is copy plus initial verification, `median.reverifyMs` is one later
full verification pass, and `median.copyMsEstimate` is their difference. Each run's
`fsCalls` shows where the syscalls go (`lstatSync`, `realpathSync`, `openSync`, and so
on), and `captured` confirms both checkouts copied the same file count and bytes.
`--capture-root` (default `%TEMP%`) places the capture directories, for example on a
Defender-excluded path.
