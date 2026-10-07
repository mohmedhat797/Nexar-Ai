# NXR-066 live acceptance runbook (owner)

Owner-initiated, never CI. Prepared 2026-10-07; no live acceptance was executed. Live stages use real
subscriptions and plan allowance. Acceptance produces only local commits; nothing is pushed. Results go
to `docs/devlog/evidence/nxr-066-owner-acceptance.md` (ids, resource ids, reason codes, timings —
never prompts, outputs, tokens or account identifiers).

## 0. Preconditions

**Implementation/CI ready for `0244d974704b9350a2ddec873872514db8d5de1a`:** NXR-068 passed
strengthened local gates ([evidence](nxr-068-local-gates.md)) and full
[CI 37553210679 attempt 2](https://github.com/mohmedhat797/Nexar-Ai/actions/runs/37553210679/attempts/2)
(Ubuntu, Windows, secret scan, installer/SHA256 upload). The prior billing block is cleared for
this revision. The documentation checkpoint creates a new head: require full CI on that exact
SHA before continuing environment setup or owner acceptance. Record its SHA/run in the handoff
without creating a commit loop solely to update this file.

**Initial preflight (before installation/rebuild):** Windows OpenWorker CLI/server unavailable; plane source still
`2dbb070`. The owner's first smoke confirmed ChatGPT authentication but exposed an unsupported
assumed model and unavailable OpenWorker. Use only a fresh returned model for the selected account
and route. Both preparation builds must use the same verified documentation-checkpoint SHA,
whose implementation generation is `0244d97`. No further implementation milestone is authorized here.

### 0a. Windows OpenWorker availability — verified without starting it

Read-only checks on 2026-10-07 found no `openworker` or `openworker-server` on this shell's PATH,
no `openworker` package in Python 3.13, and no executable override in the owner's
`%APPDATA%\Nexar\desktop-settings.json`. Therefore installed 0.3.x readiness is **not verified**.

Upstream [v0.3.0](https://github.com/andrewyng/openworker/releases/tag/v0.3.0) publishes Windows x64
EXE/MSI installers. Its [Windows source instructions](https://github.com/andrewyng/openworker/blob/v0.3.0/README.md#run-from-source)
also identify `.venv\Scripts\openworker-server.exe`; the
[package entry points](https://github.com/andrewyng/openworker/blob/v0.3.0/pyproject.toml) separate
`openworker` (version CLI) from `openworker-server`. Installing its GUI alone does not establish
Nexar's two executable paths. Nexar accepts `>=0.3.0 <0.4.0`; do not use a newer unverified major/minor.

Owner-only setup option for the separate runtime (requires the checked Python 3.13 and Git):

```powershell
$ErrorActionPreference = 'Stop'
$nxrOw = Join-Path $env:LOCALAPPDATA 'Nexar\Runtimes\openworker-0.3.0'
# Use a new directory; do not overwrite an existing installation.
if (Test-Path -LiteralPath $nxrOw) { throw 'Runtime directory exists; inspect it before proceeding.' }
py -3.13 -m venv $nxrOw
if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed.' }
& "$nxrOw\Scripts\python.exe" -m pip install 'git+https://github.com/andrewyng/openworker.git@e8923509a9e91d2825313f8418f6129a00b1603e'
if ($LASTEXITCODE -ne 0) { throw 'OpenWorker installation failed; do not start acceptance.' }
& "$nxrOw\Scripts\openworker.exe" version
if ($LASTEXITCODE -ne 0) { throw 'OpenWorker version check failed.' }
Test-Path -LiteralPath "$nxrOw\Scripts\openworker-server.exe"
```

Require `openworker 0.3.0` and `True`. At this documentation checkpoint these commands were prepared,
**not executed**; the final preparation handoff records subsequent checks. Windows
installation/dependency compatibility and private-server startup remain unverified. Do not run
`openworker up`, `join`, the GUI, or a standalone server. Nexar must supervise its own private server.

Quit all Nexar Desktop windows before editing settings. Preserve every other setting and existing
provider opt-in; merge these two paths into the existing `cowork` object (do not replace the file):

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

### 0b. Exact-head Desktop build and plane bundle — owner PowerShell

Close the installed Desktop before launch. Use an isolated source checkout to prevent a later
branch update or documentation edit from changing the accepted implementation. Run this in the
same PowerShell session as 0a. The checkout path must be new:

```powershell
$nxrRepo = 'D:\Nexar-Ai-main'
$nxrHead = (git -C $nxrRepo rev-parse HEAD).Trim()
# Compare this full SHA with the preparation handoff and its successful exact-head CI first.
$nxrCheckout = 'D:\Nexar-Ai-acceptance-nxr066'
$nxrBundle = 'D:\Nexar-Ai-main\.nexar\nxr066-owner-acceptance.bundle'
if (Test-Path -LiteralPath $nxrCheckout) { throw 'Acceptance checkout exists; inspect before reusing.' }
git -C $nxrRepo worktree add --detach $nxrCheckout $nxrHead
if ($LASTEXITCODE -ne 0) { throw 'Acceptance checkout creation failed.' }
Set-Location -LiteralPath $nxrCheckout
if ((git rev-parse HEAD) -ne $nxrHead) { throw 'Wrong Desktop source revision.' }
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Desktop dependency installation failed.' }
npx --yes --package=node@22.23.3 --package=pnpm@10.33.0 -- pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
git bundle create $nxrBundle HEAD
if ($LASTEXITCODE -ne 0) { throw 'Bundle creation failed.' }
git bundle list-heads $nxrBundle
Copy-Item -LiteralPath $nxrBundle -Destination '\\wsl.localhost\nexar-plane\home\nexar\bundles\nxr066-owner-acceptance.bundle'
```

Bundle listing must show the full `$nxrHead` and `HEAD`. If the distro has stopped, first run
`wsl -d nexar-plane -u nexar --exec true`, then retry the copy. Copy through the WSL share; never
enable automount/interop or place the plane checkout under `/mnt/c` or `/mnt/d`.

### 0c. Exact-head plane update — owner PowerShell, then Linux shell

Read-only preparation verified user `nexar` (no sudo), clean source at `2dbb070` on
`feat/nexar-operating-layer`, Node 22.23.3 / pnpm 10.33.0, hardened `/etc/wsl.conf`, no Windows drive
mounts, and validation repository `main @ 40f02fb` clean. The source `origin` is a local bundle,
not GitHub. The root-owned launcher `/usr/local/bin/nexar` executes
`/home/nexar/src/Nexar-Ai/apps/cli/dist/main.js` with
`NEXAR_CONFIG_PATH=/home/nexar/validation/nexar.config.json`. Toolchain mount prefixes remain
`/opt/node`, `/opt/claude-code`, `/opt/codex`; Node's actual executable is `/opt/node/bin/node`.
No config, credential mount, validation branch or launcher was changed during preparation.

Open the plane as its unprivileged owner:

```powershell
wsl -d nexar-plane -u nexar
```

Then run inside Linux (stop on any error; no reset or forced checkout):

```bash
set -eu
cd /home/nexar/src/Nexar-Ai
test -z "$(git status --porcelain)"
git bundle verify /home/nexar/bundles/nxr066-owner-acceptance.bundle
nxr_head="$(git bundle list-heads /home/nexar/bundles/nxr066-owner-acceptance.bundle HEAD | cut -d ' ' -f 1)"
# Require this full SHA to match Desktop's $nxrHead and the successful CI handoff.
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
git -C /home/nexar/validation/repo status --short
git -C /home/nexar/validation/repo rev-parse HEAD
uname -r
exit
```

Require current-head source/build, `nxr055-validation` unchanged, A1–A6 from the
[WSL runbook](../../integration/wsl2-engineering-plane.md#7-acceptance-checks) still satisfied, and
all sandbox selftests passing. No provider login, native model refresh, engineering task or paid
turn is included. At this documentation checkpoint the update/build/selftests were prepared,
**not executed**; the final preparation handoff records subsequent checks.

**STOP — end of non-provider preparation.** The agent may install/version-check OpenWorker,
verify its supervised private startup, build both checkouts and verify the plane without a live
turn. Desktop UI smoke uses a fresh isolated profile with no real provider connections. It must
not launch the owner's existing profile: startup automatically refreshes an existing ChatGPT plan
inventory. No real provider login, metadata refresh or model turn is initiated during preparation.
Everything below is a future owner-initiated sequence.

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
