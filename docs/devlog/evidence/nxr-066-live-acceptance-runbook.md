# NXR-066 live acceptance runbook (owner)

Owner-initiated, never CI. Prepared 2026-10-07; no live acceptance was executed. Live stages use real
subscriptions and plan allowance. Acceptance produces only local commits; nothing is pushed. Results go
to `docs/devlog/evidence/nxr-066-owner-acceptance.md` (ids, resource ids, reason codes, timings —
never prompts, outputs, tokens or account identifiers).

## 0. Preconditions

**Last verified preparation head:** `c68c7bd7b1366e3bb9a3dc71057a573b19d27aa7`,
[full CI 37621704929 attempt 1](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37621704929/attempts/1)
passed Ubuntu, Windows and secret scan, source/packaged Desktop E2E, installer/SHA256 upload.
NXR-068 implementation generation is `0244d97`. This maintenance update creates a new head;
**require its full exact-head CI before the following environment update**. Record SHA/run in the
final handoff; do not reuse c68 CI as new-head evidence or create a self-referential CI commit loop.
No new implementation milestone, merge, release or live acceptance is authorized here.

The prior preparation actually installed isolated OpenWorker 0.3.0, passed supervised private health,
built Desktop and advanced/rebuilt `nexar-plane` to c68; doctor and 7/7 sandbox selftests passed.
This revision raises the floor to **`>=0.3.1 <0.4.0`**, preferred target **0.3.1**. The old runtime
will now be refused. Keep it intact; prepare a separate 0.3.1 runtime only after new-head CI.
The final handoff records whether that update and matching builds completed.

### 0a. Windows OpenWorker 0.3.1 runtime

Official [v0.3.1](https://github.com/andrewyng/openworker/releases/tag/v0.3.1) supplies Windows x64
EXE/MSI installers. Its GUI bundles **`sidecar\openworker-server.exe` and `_internal\`**, which
does not establish `openworker` on PATH or a separate version CLI. Nexar keeps both executable
overrides and the version guard. See [source compatibility evidence](../../research/upstream/openworker-0.3.1-compatibility.md)
and deferred [NXR-069 discovery](../../backlog/069-openworker-runtime-discovery.md).

Supported source route below uses the checked Python 3.13 and exact official tag commit. These are
preparation commands, not provider acceptance. Reuse an already prepared directory only after its
version/provenance is verified; do not reinstall over it or any unrelated runtime.

```powershell
$ErrorActionPreference = 'Stop'
$nxrOw = Join-Path $env:LOCALAPPDATA 'Nexar\Runtimes\openworker-0.3.1'
if (-not (Test-Path -LiteralPath $nxrOw)) {
  py -3.13 -m venv $nxrOw
  if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed.' }
  & "$nxrOw\Scripts\python.exe" -m pip install 'git+https://github.com/andrewyng/openworker.git@b9b35036668dfb1653f3aa35bafb9aeea6d47c3c'
  if ($LASTEXITCODE -ne 0) { throw 'OpenWorker installation failed; stop preparation.' }
}
$nxrVersion = & "$nxrOw\Scripts\openworker.exe" version
if ($LASTEXITCODE -ne 0 -or $nxrVersion.Trim() -ne 'openworker 0.3.1') { throw 'Wrong runtime version.' }
& "$nxrOw\Scripts\openworker-server.exe" --help
if ($LASTEXITCODE -ne 0) { throw 'Server entry point unavailable.' }
```

Verify installation source provenance against the pinned commit before reusing an existing directory.
Do not run `openworker run`, `up`, `join`, its GUI, provider verify/login, or a standalone server.
Nexar supervises its own private server. Headless and OpenShell 0.1.2 adoption remain deferred.

Quit all Nexar Desktop windows before updating settings. Preserve every other setting/provider opt-in;
merge the paths into `cowork` and retain a backup:

```powershell
$nxrSettingsPath = Join-Path $env:APPDATA 'Nexar\desktop-settings.json'
$nxrSettings = Get-Content -LiteralPath $nxrSettingsPath -Raw | ConvertFrom-Json
Copy-Item -LiteralPath $nxrSettingsPath -Destination "$nxrSettingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
if ($null -eq $nxrSettings.cowork) {
  $nxrSettings | Add-Member -NotePropertyName cowork -NotePropertyValue ([pscustomobject]@{allowedProviders=@()}) -Force
}
$nxrSettings.cowork | Add-Member -NotePropertyName executable -NotePropertyValue "$nxrOw\Scripts\openworker-server.exe" -Force
$nxrSettings.cowork | Add-Member -NotePropertyName versionExecutable -NotePropertyValue "$nxrOw\Scripts\openworker.exe" -Force
[IO.File]::WriteAllText($nxrSettingsPath, ($nxrSettings | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
```

### 0b. Matching Desktop build and plane bundle — PowerShell

The clean detached acceptance checkout already exists at c68. Compare the full new SHA with the
handoff's successful CI before using these commands. Reuse only a clean ancestor checkout; stop
on owner edits. Run in the same PowerShell session as 0a:

```powershell
$nxrRepo = 'D:\Nexar-Ai-main'
$nxrHead = (git -C $nxrRepo rev-parse HEAD).Trim()
# Require this exact SHA and successful full CI in the final preparation handoff.
$nxrCheckout = 'D:\Nexar-Ai-acceptance-nxr066'
$nxrBundle = 'D:\Nexar-Ai-main\.nexar\nxr066-owner-acceptance.bundle'
if (Test-Path -LiteralPath $nxrCheckout) {
  if (git -C $nxrCheckout status --porcelain) { throw 'Acceptance checkout has owner edits.' }
  git -C $nxrCheckout merge-base --is-ancestor HEAD $nxrHead
  if ($LASTEXITCODE -ne 0) { throw 'Acceptance checkout diverged; stop.' }
  git -C $nxrCheckout checkout --detach $nxrHead
} else {
  git -C $nxrRepo worktree add --detach $nxrCheckout $nxrHead
}
if ($LASTEXITCODE -ne 0) { throw 'Acceptance checkout update failed.' }
Set-Location -LiteralPath $nxrCheckout
if ((git rev-parse HEAD) -ne $nxrHead) { throw 'Wrong Desktop source revision.' }
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Desktop dependency installation failed.' }
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
git bundle create $nxrBundle HEAD
if ($LASTEXITCODE -ne 0) { throw 'Bundle creation failed.' }
git bundle list-heads $nxrBundle
```

Bundle listing must show `$nxrHead HEAD`. The WSL UNC share was unavailable during c68 preparation.
Use the verified binary stdin route below; it needs no Windows drive mount or Linux credentials:

```powershell
$nxrTransfer = [Diagnostics.ProcessStartInfo]::new()
$nxrTransfer.FileName = "$env:SystemRoot\System32\wsl.exe"
$nxrTransfer.Arguments = '-d nexar-plane -u nexar --exec sh -c "umask 077; test ! -L /home/nexar/bundles/nxr066-owner-acceptance.bundle && cat > /home/nexar/bundles/nxr066-owner-acceptance.bundle && sha256sum /home/nexar/bundles/nxr066-owner-acceptance.bundle"'
$nxrTransfer.UseShellExecute = $false
$nxrTransfer.CreateNoWindow = $true
$nxrTransfer.RedirectStandardInput = $true
$nxrTransfer.RedirectStandardOutput = $true
$nxrTransfer.RedirectStandardError = $true
$nxrProcess = [Diagnostics.Process]::Start($nxrTransfer)
$nxrStream = [IO.File]::OpenRead($nxrBundle)
try { $nxrStream.CopyTo($nxrProcess.StandardInput.BaseStream) } finally { $nxrStream.Dispose(); $nxrProcess.StandardInput.Close() }
if (-not $nxrProcess.WaitForExit(60000)) { $nxrProcess.Kill(); throw 'Bundle transfer timed out.' }
$nxrRemoteHash = $nxrProcess.StandardOutput.ReadToEnd().Split(' ')[0].Trim()
if ($nxrProcess.ExitCode -ne 0 -or $nxrRemoteHash -ne (Get-FileHash -LiteralPath $nxrBundle -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Bundle transfer failed.' }
$nxrProcess.Dispose()
```

### 0c. Matching plane update — PowerShell, then Linux

Previous preparation: user `nexar` uid 1000 (no sudo), clean source c68 on
`feat/nexar-operating-layer`, Node 22.23.3 / pnpm 10.33.0, hardened `/etc/wsl.conf`, no Windows drive
mounts/interop. Validation repository is clean `main @ 40f02fb`; config unchanged.
Source `origin` is a local bundle. Root-owned `/usr/local/bin/nexar` runs
`/home/nexar/src/Nexar-Ai/apps/cli/dist/main.js` with
`NEXAR_CONFIG_PATH=/home/nexar/validation/nexar.config.json`. Toolchain prefixes remain
`/opt/node`, `/opt/claude-code`, `/opt/codex`; Node is `/opt/node/bin/node`.

```powershell
wsl -d nexar-plane -u nexar
```

Inside Linux, stop on any error; no reset, forced checkout or validation repository mutation:

```bash
set -eu
cd /home/nexar/src/Nexar-Ai
test -z "$(git status --porcelain)"
nxr_config_hash="$(sha256sum /home/nexar/validation/nexar.config.json)"
git bundle verify /home/nexar/bundles/nxr066-owner-acceptance.bundle
nxr_head="$(git bundle list-heads /home/nexar/bundles/nxr066-owner-acceptance.bundle HEAD | cut -d ' ' -f 1)"
# Require this full SHA to match Desktop and the successful CI handoff.
printf '%s\n' "$nxr_head"
git fetch /home/nexar/bundles/nxr066-owner-acceptance.bundle HEAD
test "$(git rev-parse FETCH_HEAD)" = "$nxr_head"
git merge --ff-only FETCH_HEAD
test "$(git rev-parse HEAD)" = "$nxr_head"
test "$(node --version)" = v22.23.3
test "$(pnpm --version)" = 10.33.0
pnpm install --frozen-lockfile
pnpm build
nexar doctor
nexar sandbox selftest
test "$(sha256sum /home/nexar/validation/nexar.config.json)" = "$nxr_config_hash"
test -z "$(git -C /home/nexar/validation/repo status --porcelain)"
test "$(git -C /home/nexar/validation/repo rev-parse HEAD)" = 40f02fbec9a5c0bfd6d2ecde013d496e6ec1acc3
test ! -e /mnt/c
test ! -e /mnt/d
! command -v cmd.exe
uname -r
exit 0
```

Require same-head build, unchanged validation/config, A1–A6 in the
[WSL runbook](../../integration/wsl2-engineering-plane.md#7-acceptance-checks) and 7/7 sandbox selftests.
Claude is already authenticated through its supported status probe; optional native Codex login
remains owner-only. No account credential store is read/copied and no native model listing is run.

**STOP — end of non-provider preparation.** The agent may install/version-check 0.3.1, verify
Nexar-supervised private startup/health without provider configuration or sessions, build matching
checkouts and verify the plane. Desktop UI smoke uses a fresh isolated profile. **Do not launch
the owner's existing profile:** startup automatically refreshes a connected ChatGPT inventory.
No real login, provider/catalog refresh, native SDK metadata initialization or allowance-consuming
turn is initiated. Everything below is a future owner-initiated sequence.

### 0d. Owner resume: existing-profile Desktop launch and UI checks

Back in the PowerShell source checkout from 0b:

```powershell
Set-Location -LiteralPath 'D:\Nexar-Ai-acceptance-nxr066'
if ((git rev-parse HEAD) -ne $nxrHead) { throw 'Wrong Desktop source revision.' }
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm --filter @nexar/desktop start
```

The source app uses the existing `%APPDATA%\Nexar` state. Do not set test overrides or copy auth
stores. Config migration preserves a `nexar.config.json.bak-<timestamp>` backup. Launch only when
the owner chooses to begin live provider validation, because existing ChatGPT credentials trigger
automatic route inventory refresh even before clicking **Refresh models**.

1. Settings → **Cowork** → **Refresh**. Record State, Reason and OpenWorker version. This starts
   Nexar's private server/version probe, without a user turn; a missing control inventory can still
   show `configuration-missing`. Version success alone is not live Cowork acceptance.
2. Settings → **Code** → **Refresh**. Confirm `nexar-plane`, plane readiness and the validation
   project. Select/open the existing Desktop validation project, map it to **`nxr055-validation`**,
   and save via **Set plane project**. Mapping uses the project id, never a Windows path in Linux.
3. Settings → **Providers**: inspect existing connection/freshness and Engineering plane facts.
   Do not click Connect, Sign in, Refresh models or enable plan usage yet. Stale native/account
   metadata at this boundary is expected; it is not execution proof.
4. Settings → **AI behavior** → Orchestration: inspect Cowork control/fallback Auto and Code's
   read-only plane policy. Empty fresh choices block live progression; do not invent a model.

Continue with the provider sequence only as the owner. Do not execute it as an automated continuation.

## 1. Providers — configured once (owner live stage, after STOP)

1. Desktop → Settings → Providers → **Anthropic**: Claude Code subscription shows signed in.
   Click **Refresh models** to initialize metadata without a user turn. Record fresh native choices;
   listing alone is not authentication proof. SDK initialization may refresh vendor-owned state.
2. If the existing ChatGPT plan connection is still connected, retain it; do not sign in again.
   Otherwise **OpenAI → ChatGPT plan (Sign in with ChatGPT)** → **Connect**. Sign in in the browser and
   **allow plan usage** for Nexar. Status becomes "Connected" with plan sharing on. (Uses the
   ChatGPT plan's allowance; manage or revoke it in ChatGPT settings.)
3. Refresh the ChatGPT plan inventory. Record its returned model slug, freshness and resource id.
   Resources → details: that resource has `model-turn`, connection OpenAI / subscription / official;
   Claude Code is a native agent (work resource). Empty or stale inventory blocks this step.
4. Settings → Providers → **Engineering plane**: plane resources listed read-only.
5. Optional Google coverage: explicit **Refresh models** reads `agy models`; it may initialize the
   native keyring/sign-in. Record only returned choices; authentication remains unknown. A native
   Google resource remains experimental and is not a model-turn control resource.
6. Native Codex offers **provider default**, which omits `--model`. Explicit native catalog discovery
   remains deferred until a browser-safe `model/list` release is verified; it does not use the
   separate ChatGPT plan Responses catalog. Existing vendor default resources remain usable.
7. Select a fresh explicit resource in AI behavior, then return to Auto. Refresh once more and check
   additions/removals, freshness and retained pins. Empty/stale catalogs must not create a usable
   explicit choice. No credentials or raw native output belong in evidence.

Optional plane review diversity, only when the owner initiates real authentication:

```powershell
wsl -d nexar-plane -u nexar --exec /usr/local/bin/codex login --device-auth
```

The read-only preflight resolved `/usr/local/bin/codex` to `/opt/codex/bin/codex`; recheck this if the
installation changes. Native Codex login is separate from Nexar's ChatGPT plan connection.
Do not configure DSH with a paid API key merely to turn an expected native fallback into a pass.

## 2. Orchestration — Auto

Settings → AI behavior → Orchestration: Cowork control **Auto** (shows "Auto → returned model label"),
fallback **Auto**. Code shows the plane's policy read-only.

### First resumed smoke — read-only

Before SOW, start a conversation in the project and ask: **"Review the files in this project and
give me a short summary. Do not modify any files."** Record the fresh connection/route/model/resource,
selection reason and outcome; confirm zero file modifications and no fabricated model. If inventory
or execution fails, record the fixed reason and refresh outcome before proceeding to Cowork.

## 3. Cowork SOW (acceptance §14.2)

New Cowork conversation in a project with documents. Prompt: **"Create a professional SOW using this
project."** Expect and record:

- lane `cowork` (no fallback); Control line identifies the fresh resource recorded in step 1.3;
- OpenWorker delegated ≥ 1 unit through Nexar, at least one on the Claude Code subscription
  (unit ids, resource ids, outcomes);
- a draft artifact saved by Nexar;
- if the control loop fails with `unsupported-capability` (tool calls refused on the plan route),
  record it: that is the open question of the ChatGPT route; the honest result is a recorded control
  failure / fallback, not a silent switch.

## 4. Code change (acceptance §14.3)

Code conversation on `nxr055-validation`: **"Add a one-line comment at the top of src/slugify.js
describing the module."** Expect: lanes planned by the strategy; executor `engine`/`dsh` if the
plane has a `model-turn` control resource, otherwise **`executor: native` with
`control-unavailable`** (expected today: subscriptions are native agents on the plane); sandbox,
gates, review verdict; approve in Desktop → **local** commit; no push. Record task id, lanes,
resources, executor, reason, gate/review results, commit id.

## 5. Integrated flow (acceptance §14.4)

One conversation: proposal (Cowork) → "Review this repository" (Code report-only) → implementation
(Code write, approval, local commit). No resource chosen by hand. Record each turn's lane and
decisions.

## 6. Close-out

- Disconnect the ChatGPT plan if you do not want it to stay connected (Settings → Providers).
- Evidence file written; `project-current-state.md` updated; PR #39 stays draft until the owner
  accepts v0.6.
