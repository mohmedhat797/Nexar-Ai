<#
.SYNOPSIS
Exercises Invoke-NexarArtifactCleanup.ps1 against a disposable repository; no real workspace data.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'Invoke-NexarArtifactCleanup.ps1'
$base = Join-Path ([IO.Path]::GetTempPath()) ("nexar-artifact-test-" + [guid]::NewGuid())
$repo = Join-Path $base 'repo'
$outside = Join-Path $base 'outside-keep'
$failures = 0
function Expect-Throw([string]$Name, [scriptblock]$Action) {
    try { & $Action | Out-Null; Write-Output "FAIL $Name (did not throw)"; $script:failures++ }
    catch { Write-Output "PASS $Name" }
}
function Expect-True([string]$Name, [bool]$Value) {
    if ($Value) { Write-Output "PASS $Name" } else { Write-Output "FAIL $Name"; $script:failures++ }
}
try {
    New-Item -ItemType Directory -Path $repo, $outside | Out-Null
    Set-Content -LiteralPath (Join-Path $outside 'keep.txt') 'keep'
    git -C $repo init -q
    git -C $repo config user.email 'test@example.invalid'
    git -C $repo config user.name 'test'
    git -C $repo config core.autocrlf false
    Set-Content -LiteralPath (Join-Path $repo 'tracked.txt') 'x'
    Set-Content -LiteralPath (Join-Path $repo '.gitignore') "release/`ndist/`n.nexar/"
    git -C $repo add . ; git -C $repo commit -qm init
    $unpacked = Join-Path $repo 'release\desktop\win-unpacked'
    New-Item -ItemType Directory -Path $unpacked | Out-Null
    Set-Content -LiteralPath (Join-Path $unpacked 'Nexar.exe') 'binary'
    Set-Content -LiteralPath (Join-Path $repo 'release\desktop\app-setup.exe.sha256') 'hash'
    New-Item -ItemType Junction -Path (Join-Path $unpacked 'link') -Target $outside | Out-Null
    $noProof = Join-Path $repo '.nexar\ci\package-noproof\win-unpacked'
    New-Item -ItemType Directory -Path $noProof | Out-Null
    $unknown = Join-Path $repo '.nexar\unknown-state'
    New-Item -ItemType Directory -Path $unknown | Out-Null
    $stage = Join-Path $repo 'dist\dsh-runtime.stage-00000000-0000-0000-0000-000000000000'
    New-Item -ItemType Directory -Path $stage | Out-Null
    Set-Content -LiteralPath (Join-Path $stage 'package.json') '{"name":"something-else"}'

    $manifestDir = Join-Path $repo '.nexar\workspace-maintenance'
    $manifest = Join-Path $manifestDir 'artifact-manifest.json'
    Expect-Throw 'refuses a directory no rule recognizes' { & $script -Mode DryRun -CanonicalPath $repo -Paths @($unknown) }
    Expect-Throw 'refuses win-unpacked without installer identity' { & $script -Mode DryRun -CanonicalPath $repo -Paths @($noProof) }
    Expect-Throw 'refuses a stage without the runtime marker' { & $script -Mode DryRun -CanonicalPath $repo -Paths @($stage) }
    Expect-Throw 'refuses a path outside registered worktrees' { & $script -Mode DryRun -CanonicalPath $repo -Paths @($outside) }
    Expect-Throw 'refuses a non-canonical path spelling' { & $script -Mode DryRun -CanonicalPath $repo -Paths @("$repo\release\desktop\..\desktop\win-unpacked") }
    Expect-Throw 'refuses a manifest outside the maintenance directory' { & $script -Mode DryRun -CanonicalPath $repo -Paths @($unpacked) -ManifestPath (Join-Path $base 'm.json') }

    & $script -Mode DryRun -CanonicalPath $repo -Paths @($unpacked) -WithInventory | Out-Null
    $sha = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
    Expect-Throw 'Apply refuses a wrong manifest hash' { & $script -Mode Apply -CanonicalPath $repo -ManifestSha256 ('0' * 64) }
    Expect-True 'nothing was removed by refused Apply' (Test-Path -LiteralPath $unpacked)

    Add-Content -LiteralPath (Join-Path $unpacked 'Nexar.exe') 'changed'
    Expect-Throw 'Apply refuses contents changed after DryRun' { & $script -Mode Apply -CanonicalPath $repo -ManifestSha256 $sha }

    & $script -Mode DryRun -CanonicalPath $repo -Paths @($unpacked) -WithInventory | Out-Null
    $sha = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
    & $script -Mode Apply -CanonicalPath $repo -ManifestSha256 $sha | Out-Null
    Expect-True 'target removed' (-not (Test-Path -LiteralPath $unpacked))
    Expect-True 'junction target outside survives' (Test-Path -LiteralPath (Join-Path $outside 'keep.txt'))
    Expect-True 'installer identity retained' (Test-Path -LiteralPath (Join-Path $repo 'release\desktop\app-setup.exe.sha256'))
    Expect-True 'unknown directory retained' (Test-Path -LiteralPath $unknown)
    Expect-True 'tracked source retained' (Test-Path -LiteralPath (Join-Path $repo 'tracked.txt'))
    $verify = & $script -Mode Verify -CanonicalPath $repo
    Expect-True 'Verify reports no remaining targets' (@($verify.Remaining).Count -eq 0 -and $verify.ReceiptPresent)
    Expect-Throw 'Apply does not run twice' { & $script -Mode Apply -CanonicalPath $repo -ManifestSha256 $sha }
}
finally {
    $junction = Join-Path $repo 'release\desktop\win-unpacked\link'
    if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction, $false) }
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failures) { throw "$failures artifact cleanup checks failed" }
'All artifact cleanup checks passed.'
