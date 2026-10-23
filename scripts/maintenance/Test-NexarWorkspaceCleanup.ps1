# Run from the canonical checkout. These tests create only disposable private fixtures.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'Invoke-NexarWorkspaceCleanup.ps1'
. $script -Mode Audit | Out-Null
$passed = 0
function Assert-Refused([scriptblock]$Action, [string]$Name) {
    $refused = $false
    try { & $Action | Out-Null } catch { $refused = $true }
    if (-not $refused) { throw "Expected refusal: $Name" }
    $script:passed++
}
Assert-Refused { Get-Candidate 'D:\Nexar-Ai-main' @() @() @() } 'canonical deletion'
Assert-Refused { Get-Candidate 'D:\Unknown' @() @() @() } 'unknown path'
Assert-Refused { & $script -Mode Audit -CanonicalPath 'D:\' } 'wrong canonical path'
Assert-Refused { & $script -Mode Apply -ManifestSha256 'invalid' } 'invalid manifest hash'
$fake = [pscustomobject]@{ Path = 'D:\Nexar-Ai-nxr070-opus-review'; Branch = 'feat/nxr-070b-multi-api-connections'; Locked = $false }
Assert-Refused { Get-Candidate $fake.Path @($fake) @() @() } 'active PR branch'
$fake.Branch = 'future/open-pr'
Assert-Refused { Get-Candidate $fake.Path @($fake) @([pscustomobject]@{ Branch = 'future/open-pr' }) @() } 'new live PR branch'
$fake.Branch = 'retired'; $fake.Locked = $true
Assert-Refused { Get-Candidate $fake.Path @($fake) @() @() } 'locked worktree'
$fixture = Join-Path $canonical ('.nexar\workspace-maintenance\test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$target = Join-Path $fixture 'retained'; $removable = Join-Path $fixture 'generated'
New-Item -ItemType Directory -Path $target, $removable | Out-Null
Set-Content -LiteralPath (Join-Path $target 'sentinel.txt') -Value 'retain'
Set-Content -LiteralPath (Join-Path $removable 'changing.txt') -Value 'before'
$first = Get-TreeState $removable
$originalTime = (Get-Item -LiteralPath (Join-Path $removable 'changing.txt')).LastWriteTimeUtc
Set-Content -LiteralPath (Join-Path $removable 'changing.txt') -Value 'after!'
[IO.File]::SetLastWriteTimeUtc((Join-Path $removable 'changing.txt'), $originalTime)
$second = Get-TreeState $removable
if ($first.Digest -eq $second.Digest) { throw 'Content mutation was not detected.' }; $passed++
New-Item -ItemType Junction -Path (Join-Path $removable 'external') -Target $target | Out-Null
Assert-Refused { Assert-NoReparseAncestor (Join-Path $removable 'external\child') } 'junction ancestor'
[NexarMaintenanceTree]::RemoveGenerated($removable)
if (-not (Test-Path -LiteralPath (Join-Path $target 'sentinel.txt'))) { throw 'No-follow deletion traversed a junction.' }; $passed++
# No recursive shell deletion: this fixture contains exactly the retained sentinel now.
Remove-Item -LiteralPath (Join-Path $target 'sentinel.txt')
Remove-Item -LiteralPath $target
Remove-Item -LiteralPath $fixture
"PASS: $passed cleanup safety checks."
