<#
.SYNOPSIS
Audits Nexar worktrees and retires only explicitly allowlisted, verified worktrees.
.DESCRIPTION
Audit and Verify do not change source. DryRun writes a private manifest. Apply requires
the exact reviewed manifest SHA-256, revalidates all preconditions, and never uses force.
The narrow retirement registry is intentional; extend it only after an independent audit.
Requires Windows, Git, and an authenticated GitHub CLI for live open-PR protection.
#>
[CmdletBinding()]
param(
    [ValidateSet('Audit', 'DryRun', 'Apply', 'Verify')][string]$Mode = 'Audit',
    [string]$CanonicalPath = 'D:\Nexar-Ai-main',
    [string[]]$Allowlist = @(),
    [string]$ManifestPath,
    [string]$ManifestSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$officialRemote = 'https://github.com/mohmedhat797/Nexar-Ai.git'
$protectedBranches = @('feat/nxr-070b-multi-api-connections', 'feat/nxr-070c-review-diversity')
$canonical = [IO.Path]::GetFullPath($CanonicalPath).TrimEnd('\')
if ($canonical -cne 'D:\Nexar-Ai-main') { throw 'The canonical path must match the audited repository.' }
$maintenance = Join-Path $canonical '.nexar\workspace-maintenance'
if (-not $ManifestPath) { $ManifestPath = Join-Path $maintenance 'cleanup-manifest.json' }
$ManifestPath = [IO.Path]::GetFullPath($ManifestPath)
if ([IO.Path]::GetDirectoryName($ManifestPath) -ine $maintenance) { throw 'Manifest must be directly inside the private maintenance directory.' }
$registry = @(
    'D:\Nexar-Ai-acceptance-nxr066',
    'D:\Nexar-Ai-main\.nexar\nxr066-main-baseline',
    'D:\Nexar-Ai-nxr070-opus-review'
)

function Invoke-Git([string]$Path, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue' # Windows PowerShell wraps redirected native stderr.
    $output = @(& git.exe -C $Path @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "Git failed: $($Arguments[0])" }
    return $output
}
function Get-Digest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Assert-NoReparseAncestor([string]$Path) {
    $cursor = [IO.DirectoryInfo]::new($Path)
    while ($null -ne $cursor) {
        if ($cursor.Exists -and ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'A path ancestor is a reparse point.' }
        $cursor = $cursor.Parent
    }
}
Assert-NoReparseAncestor $canonical
Assert-NoReparseAncestor $maintenance
if ((Invoke-Git $canonical @('remote', 'get-url', 'origin')) -join '' -cne $officialRemote) { throw 'Unexpected repository remote.' }
$common = (Invoke-Git $canonical @('rev-parse', '--path-format=absolute', '--git-common-dir')) -join ''
if ([IO.Path]::GetFullPath($common) -ine (Join-Path $canonical '.git')) { throw 'Canonical checkout must own the common Git directory.' }

if (-not ('NexarMaintenanceTree' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
public class NexarTreeSnapshot { public string Digest; public long LogicalBytes, Files; }
public static class NexarMaintenanceTree {
 public static NexarTreeSnapshot Snapshot(string root) {
  var rows=new List<string>(); var pending=new Stack<string>(); pending.Push(root);
  var result=new NexarTreeSnapshot();
  using(var sha=SHA256.Create()) {
   while(pending.Count>0) {
    foreach(var e in new DirectoryInfo(pending.Pop()).EnumerateFileSystemInfos()) {
     bool link=(e.Attributes&FileAttributes.ReparsePoint)!=0;
     bool dir=(e.Attributes&FileAttributes.Directory)!=0;
     using(var stream=new MemoryStream()) {
      using(var writer=new BinaryWriter(stream,Encoding.UTF8,true)) {
       writer.Write(link?"L":dir?"D":"F");
       writer.Write(e.FullName.Substring(root.Length+1).Replace('\\','/'));
       writer.Write((int)e.Attributes);
       if(link) writer.Write(e.LastWriteTimeUtc.Ticks);
       else if(dir) pending.Push(e.FullName);
       else {
        var f=(FileInfo)e; result.Files++; result.LogicalBytes+=f.Length;
        writer.Write(f.Length); writer.Write(f.LastWriteTimeUtc.Ticks);
        using(var input=f.OpenRead()) writer.Write(sha.ComputeHash(input));
       }
      }
      rows.Add(Convert.ToBase64String(stream.ToArray()));
     }
    }
   }
   rows.Sort(StringComparer.Ordinal);
   result.Digest=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(String.Join("\n",rows)))).Replace("-","").ToLowerInvariant();
  }
  return result;
 }
 public static string[] Links(string[] roots) {
  var result=new List<string>(); var pending=new Stack<string>(roots);
  var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  while(pending.Count>0) {
   string p=pending.Pop(); if(!seen.Add(p)) continue;
   if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0) throw new IOException("Linked scan root");
   foreach(var e in new DirectoryInfo(p).EnumerateFileSystemInfos()) {
    if((e.Attributes&FileAttributes.ReparsePoint)!=0) result.Add(e.FullName);
    else if((e.Attributes&FileAttributes.Directory)!=0 && e.Name!=".git") pending.Push(e.FullName);
   }
  }
  result.Sort(StringComparer.Ordinal); return result.ToArray();
 }
 public static void RemoveGenerated(string path) {
  var attributes=File.GetAttributes(path);
  if((attributes&FileAttributes.ReparsePoint)!=0) {
   if((attributes&FileAttributes.Directory)!=0) Directory.Delete(path,false); else File.Delete(path);
  } else if((attributes&FileAttributes.Directory)!=0) {
   foreach(var e in new DirectoryInfo(path).EnumerateFileSystemInfos()) RemoveGenerated(e.FullName);
   Directory.Delete(path,false);
  } else File.Delete(path);
 }
}
'@
}
function Get-Worktrees {
    $result = @(); $entry = $null
    foreach ($line in (Invoke-Git $canonical @('worktree', 'list', '--porcelain'))) {
        if ($line.StartsWith('worktree ')) {
            if ($null -ne $entry) { $result += [pscustomobject]$entry }
            $entry = [ordered]@{ Path = [IO.Path]::GetFullPath($line.Substring(9)); Head = ''; Branch = ''; Locked = $false }
        } elseif ($line.StartsWith('HEAD ')) { $entry.Head = $line.Substring(5) }
        elseif ($line.StartsWith('branch ')) { $entry.Branch = $line.Substring(7).Replace('refs/heads/', '') }
        elseif ($line.StartsWith('locked')) { $entry.Locked = $true }
    }
    if ($null -ne $entry) { $result += [pscustomobject]$entry }
    return $result
}
function Get-OpenPrs {
    $output = @(& gh api --paginate --slurp 'repos/mohmedhat797/Nexar-Ai/pulls?state=open&per_page=100')
    if ($LASTEXITCODE -ne 0) { throw 'Live PR lookup failed; retirement is disabled.' }
    $pages = ($output -join "`n") | ConvertFrom-Json
    $result = foreach ($page in $pages) {
        foreach ($pr in $page) { [pscustomobject][ordered]@{ Number = $pr.number; Branch = $pr.head.ref; Head = $pr.head.sha; Base = $pr.base.ref; Draft = $pr.draft } }
    }
    return @($result | Sort-Object Number)
}
function Get-ProcessReferences([string]$Path) {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $_.ProcessId -ne $PID -and (
            ($_.CommandLine -and ($_.CommandLine.IndexOf($Path, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine.IndexOf($Path.Replace('\', '/'), [StringComparison]::OrdinalIgnoreCase) -ge 0)) -or
            ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($Path + '\', [StringComparison]::OrdinalIgnoreCase))
        )
    } | Select-Object ProcessId, Name)
}
function Get-LinkState($Worktrees) {
    $roots = @(Get-ChildItem -LiteralPath 'D:\' -Directory -Force | Where-Object Name -Match '^nexar' | Select-Object -ExpandProperty FullName)
    if (Test-Path -LiteralPath 'D:\.pnpm-store') { $roots += 'D:\.pnpm-store' }
    $roots += @($Worktrees | Where-Object { -not $_.Path.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase) } | Select-Object -ExpandProperty Path)
    $rows = foreach ($path in [NexarMaintenanceTree]::Links([string[]]$roots)) {
        $item = Get-Item -LiteralPath $path -Force
        if (-not $item.Target -or -not $item.LinkType) { throw 'Unresolved reparse point; retirement is disabled.' }
        $parent = [IO.Path]::GetDirectoryName($path)
        foreach ($target in $item.Target) {
            if ($target.StartsWith('\\')) { throw 'Network reparse target requires manual review.' }
            $resolved = if ([IO.Path]::IsPathRooted($target)) { [IO.Path]::GetFullPath($target) } else { [IO.Path]::GetFullPath((Join-Path $parent $target)) }
            [pscustomobject][ordered]@{ Path = $path; Type = $item.LinkType; Target = $resolved }
        }
    }
    return @($rows)
}
function Get-TreeState([string]$Root) {
    # The global link digest separately binds every link target; Snapshot never follows links.
    $snapshot = [NexarMaintenanceTree]::Snapshot($Root)
    return [pscustomobject][ordered]@{ Digest = $snapshot.Digest; LogicalBytes = $snapshot.LogicalBytes; Files = $snapshot.Files }
}
function Get-Candidate([string]$Path, $Worktrees, $OpenPrs, $Links) {
    if ($Path -notin $registry -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'Path is outside the exact retirement registry.' }
    if ($Path -ieq $canonical -or (Get-Location).Path.StartsWith($Path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cannot retire canonical or current execution directory.' }
    Assert-NoReparseAncestor $Path
    $wt = @($Worktrees | Where-Object Path -IEQ $Path)
    if ($wt.Count -ne 1 -or $wt[0].Locked) { throw 'Target must be one unlocked registered worktree.' }
    if ($wt[0].Branch -in $protectedBranches -or $wt[0].Branch -in @($OpenPrs | Select-Object -ExpandProperty Branch)) { throw 'Active PR worktree is protected.' }
    if (@($Worktrees | Where-Object { $_.Path.StartsWith($Path + '\', [StringComparison]::OrdinalIgnoreCase) }).Count) { throw 'Nested worktrees are protected.' }
    if (@(Get-ProcessReferences $Path).Count) { throw 'A running process references the worktree.' }
    $targetCommon = (Invoke-Git $Path @('rev-parse', '--path-format=absolute', '--git-common-dir')) -join ''
    if ([IO.Path]::GetFullPath($targetCommon) -ine [IO.Path]::GetFullPath($common)) { throw 'Worktree belongs to another repository.' }
    $gitDir = (Invoke-Git $Path @('rev-parse', '--absolute-git-dir')) -join ''
    if (@(Get-ChildItem -LiteralPath $gitDir -Filter '*.lock' -Force).Count) { throw 'Git lock present.' }
    if (@(Invoke-Git $Path @('status', '--porcelain=v1', '--untracked-files=all')).Count) { throw 'Uncommitted or untracked files require preservation.' }
    $unpublished = (Invoke-Git $Path @('rev-list', '--count', 'HEAD', '--not', '--remotes=origin')) -join ''
    if ($unpublished -ne '0') { throw 'Unpublished commits require preservation.' }
    $incoming = @($Links | Where-Object { ($_.Target -ieq $Path -or $_.Target.StartsWith($Path + '\', [StringComparison]::OrdinalIgnoreCase)) -and -not $_.Path.StartsWith($Path + '\', [StringComparison]::OrdinalIgnoreCase) })
    $registrations = @($incoming | Where-Object { $_.Path -match '^D:\\\.pnpm-store\\v10\\projects\\[a-f0-9]{32}$' -and $_.Target -ceq $Path -and $_.Type -eq 'Junction' })
    if ($incoming.Count -ne $registrations.Count) { throw 'Retained workspace has an inbound dependency link to the target.' }
    $ignored = @(Invoke-Git $Path @('ls-files', '--others', '--ignored', '--exclude-standard', '--directory'))
    $generated = foreach ($relative in $ignored) {
        if ($relative -notmatch '^(?:[^/]+/)*?(?:node_modules/|dist/|[^/]+\.tsbuildinfo)$') { throw 'Ignored runtime, evidence, or unknown data requires retention.' }
        if ($relative -match '(^|/)(\.nexar|release|research|evidence)(/|$)|^(sessions|memory)(/|$)') { throw 'Protected artifact path.' }
        $full = [IO.Path]::GetFullPath((Join-Path $Path $relative))
        if (-not $full.StartsWith($Path + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Generated path escaped the target.' }
        $tracked = @(Invoke-Git $Path @('ls-files', '--', $relative))
        if ($tracked.Count) { throw 'Generated path contains tracked files.' }
        $full
    }
    $tree = Get-TreeState $Path
    return [pscustomobject][ordered]@{ Path = $Path; Head = $wt[0].Head; Branch = $wt[0].Branch; CommonDirectory = [IO.Path]::GetFullPath($common); Tree = $tree; GeneratedPaths = @($generated | Sort-Object -Unique); RegistrationLinks = $registrations; Reason = 'Retired baseline/review; published source; no local state/evidence or inbound dependency links; generated files only.' }
}
function Write-Operation([string]$Operation, [string]$Path, [string]$Status) {
    [pscustomobject][ordered]@{ TimeUtc = [DateTime]::UtcNow.ToString('o'); Operation = $Operation; Path = $Path; Status = $Status } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $maintenance 'cleanup-operations.jsonl')
}

$worktrees = @(Get-Worktrees)
if ($Mode -eq 'Audit') { $worktrees | ConvertTo-Json -Depth 5; return }
if ($Mode -eq 'Verify') {
    Invoke-Git $canonical @('fsck', '--connectivity-only')
    $worktrees | ConvertTo-Json -Depth 5
    return
}
New-Item -ItemType Directory -Path $maintenance -ErrorAction SilentlyContinue | Out-Null
if ($Mode -eq 'Apply') {
    if ($ManifestSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Apply requires the reviewed manifest SHA-256.' }
    $manifestItem = Get-Item -LiteralPath $ManifestPath -Force
    if ($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Manifest cannot be a link.' }
    if ((Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash -ine $ManifestSha256) { throw 'Manifest SHA-256 mismatch.' }
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if (@($manifest.Targets).Count -eq 0) { throw 'Manifest has no verified eligible targets.' }
    if ($manifest.Version -ne 1 -or $manifest.CanonicalPath -cne $canonical -or $manifest.ScriptSha256 -ine (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash) { throw 'Manifest or script binding mismatch.' }
    $receiptPath = Join-Path $maintenance ($manifestItem.BaseName + '-receipt.json')
    if (Test-Path -LiteralPath $receiptPath) {
        $prior = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        if ($prior.ManifestSha256 -ieq $ManifestSha256 -and $prior.Status -eq 'Completed' -and @($manifest.Targets | Where-Object { Test-Path -LiteralPath $_.Path }).Count -eq 0) { 'Already applied; no changes.'; return }
        throw 'Prior receipt requires manual review.'
    }
    if (([DateTime]::UtcNow - [DateTime]::Parse($manifest.CreatedUtc).ToUniversalTime()).TotalHours -gt 24) { throw 'Manifest is expired; repeat DryRun.' }
    if ($Allowlist.Count -and ($Allowlist -join '|') -cne (@($manifest.Targets.Path) -join '|')) { throw 'Apply allowlist differs from the manifest.' }
} elseif (-not $Allowlist.Count) { throw 'DryRun requires an exact directory allowlist.' }

$prs = @(Get-OpenPrs)
$links = @(Get-LinkState $worktrees)
$linkDigest = Get-Digest ($links | ConvertTo-Json -Compress -Depth 4)
$prDigest = Get-Digest ($prs | ConvertTo-Json -Compress -Depth 4)
if ($Mode -eq 'DryRun') {
    $targets = @(); $blocked = @()
    foreach ($path in $Allowlist) {
        try { $targets += Get-Candidate $path $worktrees $prs $links }
        catch { $blocked += [pscustomobject]@{ Path = $path; Status = 'MANUAL_REVIEW_REQUIRED'; Reason = $_.Exception.Message } }
    }
    $manifest = [pscustomobject][ordered]@{ Version = 1; CreatedUtc = [DateTime]::UtcNow.ToString('o'); CanonicalPath = $canonical; CanonicalHead = (Invoke-Git $canonical @('rev-parse', 'HEAD')) -join ''; ScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash; LinkDigest = $linkDigest; PrDigest = $prDigest; Targets = $targets; Blocked = $blocked }
    if (Test-Path -LiteralPath $ManifestPath) { throw 'Manifest already exists; select a new exact filename.' }
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
    Write-Operation 'DryRun' $ManifestPath 'Created'
    [pscustomobject]@{ Manifest = $ManifestPath; Sha256 = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash; Eligible = $targets.Count; Blocked = $blocked } | ConvertTo-Json -Depth 6
    return
}
if ($manifest.LinkDigest -cne $linkDigest -or $manifest.PrDigest -cne $prDigest -or $manifest.CanonicalHead -cne ((Invoke-Git $canonical @('rev-parse', 'HEAD')) -join '')) { throw 'Workspace links, PRs, or canonical HEAD changed; repeat DryRun.' }
if (@($manifest.Targets | Group-Object Path | Where-Object Count -GT 1).Count) { throw 'Duplicate manifest targets.' }
foreach ($target in $manifest.Targets) {
    $current = Get-Candidate $target.Path $worktrees $prs $links
    if (($current | ConvertTo-Json -Compress -Depth 8) -cne ($target | ConvertTo-Json -Compress -Depth 8)) { throw 'Target state changed; repeat DryRun.' }
}
$before = (Get-Volume -DriveLetter D).SizeRemaining
$completed = @(); $failed = @()
foreach ($target in $manifest.Targets) {
    try {
        $current = Get-Candidate $target.Path @(Get-Worktrees) $prs $links
        if ($current.Tree.Digest -cne $target.Tree.Digest) { throw 'Target changed immediately before removal.' }
        Write-Operation 'RetireWorktree' $target.Path 'Started'
        foreach ($registration in $target.RegistrationLinks) {
            $link = Get-Item -LiteralPath $registration.Path -Force
            $linkTargets = @($link.Target) # Target is a scalar on PS7 and an array on Windows PS5.
            if ($link.LinkType -ne 'Junction' -or $linkTargets.Count -ne 1 -or $linkTargets[0] -cne $target.Path) { throw 'pnpm project registration changed.' }
            Write-Operation 'UnlinkPnpmProjectRegistration' $registration.Path 'Started'
            [IO.Directory]::Delete($registration.Path, $false)
            Write-Operation 'UnlinkPnpmProjectRegistration' $registration.Path 'Completed'
        }
        foreach ($generated in $target.GeneratedPaths) {
            # Validate every absolute path again immediately before the no-follow traversal.
            if (-not $generated.StartsWith($target.Path + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid generated path.' }
            Write-Operation 'RemoveGenerated' $generated 'Started'
            [NexarMaintenanceTree]::RemoveGenerated($generated)
            Write-Operation 'RemoveGenerated' $generated 'Completed'
        }
        Invoke-Git $canonical @('worktree', 'remove', '--', $target.Path)
        if (Test-Path -LiteralPath $target.Path) { throw 'Path still exists after worktree removal.' }
        Write-Operation 'RetireWorktree' $target.Path 'Completed'
        $completed += $target.Path
    } catch {
        Write-Operation 'RetireWorktree' $target.Path ('Failed: ' + $_.Exception.Message)
        $failed += [pscustomobject]@{ Path = $target.Path; Error = $_.Exception.Message }
    }
}
$receipt = [pscustomobject][ordered]@{ ManifestSha256 = $ManifestSha256; Status = $(if ($failed.Count) { 'Partial' } else { 'Completed' }); CompletedUtc = [DateTime]::UtcNow.ToString('o'); Removed = $completed; Failed = $failed; FreeBeforeBytes = $before; FreeAfterBytes = (Get-Volume -DriveLetter D).SizeRemaining }
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
$receipt | ConvertTo-Json -Depth 6
if ($failed.Count) { throw 'Cleanup partially failed; inspect the receipt and log before another attempt.' }
