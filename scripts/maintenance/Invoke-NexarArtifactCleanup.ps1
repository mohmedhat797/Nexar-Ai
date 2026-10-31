<#
.SYNOPSIS
Audits and removes reproducible Nexar build output and superseded DSH runtime generations.
.DESCRIPTION
Audit and Verify change nothing. DryRun classifies an exact path list and writes a private,
digest-bound manifest. Apply requires the reviewed manifest SHA-256, revalidates every
precondition and removes only those paths; it never expands wildcards, never follows links,
and never removes a worktree. Anything no rule recognizes is refused. There is no scheduled or
automatic mode.
#>
[CmdletBinding()]
param(
    [ValidateSet('Audit', 'DryRun', 'Apply', 'Verify')][string]$Mode = 'Audit',
    [string]$CanonicalPath = 'D:\Nexar-Ai-main',
    [string[]]$Paths = @(),
    [string]$ManifestPath,
    [string]$ManifestSha256,
    [switch]$WithInventory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$canonical = [IO.Path]::GetFullPath($CanonicalPath).TrimEnd('\')
$maintenance = Join-Path $canonical '.nexar\workspace-maintenance'
if (-not $ManifestPath) { $ManifestPath = Join-Path $maintenance 'artifact-manifest.json' }
$ManifestPath = [IO.Path]::GetFullPath($ManifestPath)
if ([IO.Path]::GetDirectoryName($ManifestPath) -ine $maintenance) { throw 'Manifest must be directly inside the private maintenance directory.' }
$uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
# Each rule: exact relative shape, retention class, and the sibling proof that must exist.
$rules = @(
    @{ Id = 'release-unpacked'; Pattern = '^release\\desktop\\win-unpacked$'; Class = 'REPRODUCIBLE_BUILD'; Proof = 'InstallerIdentity' },
    @{ Id = 'evidence-unpacked'; Pattern = '^\.nexar\\ci\\(package|electron-startup-original-package)-[A-Za-z0-9-]+\\win-unpacked$'; Class = 'REPRODUCIBLE_BUILD'; Proof = 'InstallerIdentity' },
    @{ Id = 'failed-stage'; Pattern = "^dist\\dsh-runtime\.(stage|promote)-$uuid$"; Class = 'OBSOLETE_GENERATION'; Proof = 'RuntimeMarker' },
    @{ Id = 'previous-generation'; Pattern = "^\.nexar\\dsh-runtime\.previous-$uuid$"; Class = 'OBSOLETE_GENERATION'; Proof = 'RuntimeMarker' },
    @{ Id = 'evidence-runtime-tree'; Pattern = '^\.nexar\\ci\\dsh-[A-Za-z0-9-]+\\node_modules$'; Class = 'OBSOLETE_GENERATION'; Proof = 'ParentRuntimeMarker' },
    @{ Id = 'evidence-runtime-dir'; Pattern = "^\.nexar\\ci\\dsh-[A-Za-z0-9-]+\\runtime(\.stage-$uuid)?$"; Class = 'OBSOLETE_GENERATION'; Proof = 'RuntimeMarker' },
    @{ Id = 'package-output'; Pattern = '^dist\\(desktop-staging|dsh-runtime)$'; Class = 'REPRODUCIBLE_BUILD'; Proof = 'None' }
)

function Invoke-Git([string]$Path, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue' # Windows PowerShell wraps redirected native stderr.
    $output = @(& git.exe -c core.longpaths=true -C $Path @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "Git failed: $($Arguments[0])" }
    return $output
}
function Assert-NoReparseAncestor([string]$Path) {
    $cursor = [IO.DirectoryInfo]::new($Path)
    while ($null -ne $cursor) {
        if ($cursor.Exists -and ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "A path ancestor is a reparse point: $Path" }
        $cursor = $cursor.Parent
    }
}
if (-not ('NexarArtifactTree' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
public class NexarArtifactSnapshot { public string Digest; public long LogicalBytes, Files, Links; }
public static class NexarArtifactTree {
 static string Long(string p) { return p.StartsWith(@"\\?\") ? p : @"\\?\" + p; }
 static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-","").ToLowerInvariant(); }
 // Identity is names, sizes and timestamps; links are recorded as leaves and never entered.
 public static NexarArtifactSnapshot Snapshot(string root, string inventoryGz) {
  var rows=new List<string>(); var result=new NexarArtifactSnapshot();
  var pending=new Stack<string>(); pending.Push(Long(root)); int prefix=Long(root).Length+1;
  StreamWriter inv=null;
  if(!String.IsNullOrEmpty(inventoryGz)) inv=new StreamWriter(new GZipStream(File.Create(inventoryGz),CompressionMode.Compress),Encoding.UTF8);
  using(var sha=SHA256.Create()) {
   while(pending.Count>0) {
    foreach(var e in new DirectoryInfo(pending.Pop()).EnumerateFileSystemInfos()) {
     string rel=e.FullName.Substring(prefix).Replace('\\','/');
     if((e.Attributes&FileAttributes.ReparsePoint)!=0) { result.Links++; rows.Add("L\t"+rel); if(inv!=null) inv.WriteLine("L\t\t\t"+rel); }
     else if((e.Attributes&FileAttributes.Directory)!=0) { pending.Push(e.FullName); rows.Add("D\t"+rel); }
     else {
      var f=(FileInfo)e; result.Files++; result.LogicalBytes+=f.Length;
      rows.Add("F\t"+rel+"\t"+f.Length+"\t"+f.LastWriteTimeUtc.Ticks);
      if(inv!=null) inv.WriteLine("F\t"+f.Length+"\t"+f.LastWriteTimeUtc.ToString("o")+"\t"+rel);
     }
    }
   }
   rows.Sort(StringComparer.Ordinal);
   result.Digest=Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(String.Join("\n",rows))));
  }
  if(inv!=null) inv.Dispose();
  return result;
 }
 public static void Remove(string path) { RemoveInner(Long(path)); }
 static void RemoveInner(string path) {
  var attributes=File.GetAttributes(path);
  if((attributes&FileAttributes.ReadOnly)!=0) File.SetAttributes(path,attributes&~FileAttributes.ReadOnly);
  if((attributes&FileAttributes.ReparsePoint)!=0) {
   if((attributes&FileAttributes.Directory)!=0) Directory.Delete(path,false); else File.Delete(path);
  } else if((attributes&FileAttributes.Directory)!=0) {
   foreach(var e in new DirectoryInfo(path).EnumerateFileSystemInfos()) RemoveInner(e.FullName);
   Directory.Delete(path,false);
  } else File.Delete(path);
 }
}
'@
}
function Get-Worktrees {
    $seen = @()
    foreach ($line in (Invoke-Git $canonical @('worktree', 'list', '--porcelain'))) {
        if ($line.StartsWith('worktree ')) { $seen += [IO.Path]::GetFullPath($line.Substring(9)) }
    }
    return @($seen | Where-Object { Test-Path -LiteralPath $_ })
}
function Get-ProcessReferences([string]$Path) {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $_.ProcessId -ne $PID -and (
            ($_.CommandLine -and ($_.CommandLine.IndexOf($Path, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine.IndexOf($Path.Replace('\', '/'), [StringComparison]::OrdinalIgnoreCase) -ge 0)) -or
            ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($Path + '\', [StringComparison]::OrdinalIgnoreCase))
        )
    } | Select-Object ProcessId, Name)
}
function Test-RuntimeMarker([string]$Directory) {
    $manifest = Join-Path $Directory 'package.json'
    if (-not (Test-Path -LiteralPath $manifest)) { return $false }
    return (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name -ceq 'nexar-dsh-runtime'
}
function Get-Classification([string]$Path, [string[]]$Worktrees) {
    if ([IO.Path]::GetFullPath($Path) -cne $Path) { throw "Path must be exact and canonical: $Path" }
    $owner = @($Worktrees | Where-Object { $Path.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase) } | Sort-Object Length -Descending | Select-Object -First 1)
    if ($owner.Count -ne 1) { throw "Path is not inside a registered worktree: $Path" }
    $relative = $Path.Substring($owner[0].Length + 1)
    $rule = @($rules | Where-Object { $relative -cmatch $_.Pattern } | Select-Object -First 1)
    if ($rule.Count -ne 1) { throw "No retention rule recognizes this path; preserved: $Path" }
    Assert-NoReparseAncestor $Path
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) { throw "Target must be a directory: $Path" }
    $parent = [IO.Path]::GetDirectoryName($Path)
    switch ($rule[0].Proof) {
        'InstallerIdentity' { if (-not @(Get-ChildItem -LiteralPath $parent -File -Filter '*.exe.sha256').Count -and -not @(Get-ChildItem -LiteralPath $parent -File -Filter '*setup.exe').Count) { throw "No retained installer identity beside: $Path" } }
        'RuntimeMarker' { if (-not (Test-RuntimeMarker $Path)) { throw "Unknown ownership (no runtime marker): $Path" } }
        'ParentRuntimeMarker' { if (-not (Test-RuntimeMarker $parent)) { throw "Unknown ownership (no parent runtime marker): $Path" } }
    }
    if ($rule[0].Id -in @('failed-stage', 'previous-generation')) {
        $lockBase = Join-Path $parent 'dsh-runtime.install-lock'
        if (Test-Path -LiteralPath $lockBase) { throw "An installation lock is present; review it first: $lockBase" }
    }
    $tracked = @(Invoke-Git $owner[0] @('ls-files', '--', $relative.Replace('\', '/')))
    if ($tracked.Count) { throw "Target contains tracked files: $Path" }
    return [pscustomobject][ordered]@{ Path = $Path; Worktree = $owner[0]; Rule = $rule[0].Id; Class = $rule[0].Class }
}
function Get-FreeBytes([string]$Path) { return ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($Path))).AvailableFreeSpace }
function Write-Operation([string]$Operation, [string]$Path, [string]$Status) {
    [pscustomobject][ordered]@{ TimeUtc = [DateTime]::UtcNow.ToString('o'); Operation = $Operation; Path = $Path; Status = $Status } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $maintenance 'artifact-operations.jsonl')
}

Assert-NoReparseAncestor $canonical
$common = (Invoke-Git $canonical @('rev-parse', '--path-format=absolute', '--git-common-dir')) -join ''
if ([IO.Path]::GetFullPath($common) -ine (Join-Path $canonical '.git')) { throw 'Canonical checkout must own the common Git directory.' }
$worktrees = @(Get-Worktrees)

if ($Mode -eq 'Audit') {
    $found = foreach ($root in $worktrees) {
        foreach ($relative in @('release\desktop\win-unpacked', 'dist\desktop-staging', 'dist\dsh-runtime')) {
            $candidate = Join-Path $root $relative
            if (Test-Path -LiteralPath $candidate) { $candidate }
        }
        foreach ($folder in @('dist', '.nexar')) {
            $base = Join-Path $root $folder
            if (Test-Path -LiteralPath $base) { @(Get-ChildItem -LiteralPath $base -Directory -Force | Where-Object Name -Match '^dsh-runtime\.(stage|previous)-' | Select-Object -ExpandProperty FullName) }
        }
        $ci = Join-Path $root '.nexar\ci'
        if (Test-Path -LiteralPath $ci) {
            foreach ($dir in @(Get-ChildItem -LiteralPath $ci -Directory -Force)) {
                foreach ($leaf in @('win-unpacked', 'node_modules', 'runtime')) {
                    $candidate = Join-Path $dir.FullName $leaf
                    if (Test-Path -LiteralPath $candidate) { $candidate }
                }
                @(Get-ChildItem -LiteralPath $dir.FullName -Directory -Force | Where-Object Name -Match '^runtime\.stage-' | Select-Object -ExpandProperty FullName)
            }
        }
    }
    foreach ($candidate in @($found)) {
        try { $c = Get-Classification $candidate $worktrees; $c | Add-Member Status 'Eligible'; $c }
        catch { [pscustomobject][ordered]@{ Path = $candidate; Worktree = ''; Rule = ''; Class = 'UNKNOWN'; Status = "Refused: $($_.Exception.Message)" } }
    }
    return
}
New-Item -ItemType Directory -Path $maintenance -ErrorAction SilentlyContinue | Out-Null

if ($Mode -eq 'DryRun') {
    if (-not $Paths.Count) { throw 'DryRun requires an exact path list.' }
    $inventories = Join-Path $maintenance 'inventories'
    if ($WithInventory) { New-Item -ItemType Directory -Path $inventories -ErrorAction SilentlyContinue | Out-Null }
    $targets = foreach ($path in ($Paths | Sort-Object -Unique)) {
        $class = Get-Classification $path $worktrees
        $references = @(Get-ProcessReferences $path)
        if ($references.Count) { throw "A running process references: $path" }
        $inventory = $null
        if ($WithInventory) {
            $inventoryName = ($path -replace '[^A-Za-z0-9.-]', '_') + '.tsv.gz'
            $inventory = Join-Path $inventories $inventoryName
        }
        $snapshot = [NexarArtifactTree]::Snapshot($path, $inventory)
        [pscustomobject][ordered]@{ Path = $path; Worktree = $class.Worktree; Rule = $class.Rule; Class = $class.Class; Digest = $snapshot.Digest; LogicalBytes = $snapshot.LogicalBytes; Files = $snapshot.Files; Links = $snapshot.Links; Inventory = $inventory; Action = 'RemoveDirectoryLeafwise' }
    }
    [pscustomobject][ordered]@{ Version = 1; CreatedUtc = [DateTime]::UtcNow.ToString('o'); CanonicalPath = $canonical; ScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash; Targets = @($targets) } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
    $sum = (@($targets) | Measure-Object -Property LogicalBytes -Sum).Sum
    "Manifest: $ManifestPath"
    "SHA256: $((Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash)"
    "Targets: $(@($targets).Count); logical bytes: $sum (hard links may reduce the physical recovery)."
    return
}

$manifestItem = Get-Item -LiteralPath $ManifestPath -Force
if ($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Manifest cannot be a link.' }
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$receiptPath = Join-Path $maintenance ($manifestItem.BaseName + '-receipt.json')

if ($Mode -eq 'Verify') {
    $remaining = @($manifest.Targets | Where-Object { Test-Path -LiteralPath $_.Path } | ForEach-Object { $_.Path })
    Invoke-Git $canonical @('fsck', '--connectivity-only') | Out-Null
    [pscustomobject][ordered]@{ Targets = @($manifest.Targets).Count; Remaining = $remaining; ReceiptPresent = (Test-Path -LiteralPath $receiptPath); Worktrees = $worktrees.Count; FreeBytes = (Get-FreeBytes $canonical) }
    return
}

if ($ManifestSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Apply requires the reviewed manifest SHA-256.' }
if ((Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash -ine $ManifestSha256) { throw 'Manifest SHA-256 mismatch.' }
if ($manifest.Version -ne 1 -or $manifest.CanonicalPath -cne $canonical -or $manifest.ScriptSha256 -ine (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash) { throw 'Manifest or script binding mismatch.' }
if (([DateTime]::UtcNow - [DateTime]::Parse($manifest.CreatedUtc).ToUniversalTime()).TotalHours -gt 24) { throw 'Manifest is expired; repeat DryRun.' }
if (Test-Path -LiteralPath $receiptPath) { throw 'A receipt already exists for this manifest; review it.' }
# Revalidate everything before the first removal so a stale entry cannot cause a partial run.
foreach ($target in @($manifest.Targets)) {
    $class = Get-Classification $target.Path $worktrees
    if ($class.Rule -cne $target.Rule) { throw "Classification changed: $($target.Path)" }
    if (@(Get-ProcessReferences $target.Path).Count) { throw "A running process references: $($target.Path)" }
    if ([NexarArtifactTree]::Snapshot($target.Path, $null).Digest -cne $target.Digest) { throw "Contents changed since DryRun: $($target.Path)" }
}
$freeBefore = Get-FreeBytes $canonical
$removed = foreach ($target in @($manifest.Targets)) {
    Write-Operation 'remove' $target.Path 'Started'
    [NexarArtifactTree]::Remove($target.Path)
    Write-Operation 'remove' $target.Path 'Completed'
    $target.Path
}
$freeAfter = Get-FreeBytes $canonical
[pscustomobject][ordered]@{ ManifestSha256 = $ManifestSha256.ToLowerInvariant(); Status = 'Completed'; CompletedUtc = [DateTime]::UtcNow.ToString('o'); Removed = @($removed); FreeBytesBefore = $freeBefore; FreeBytesAfter = $freeAfter; RecoveredBytes = ($freeAfter - $freeBefore) } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
"Removed $(@($removed).Count) targets; recovered $($freeAfter - $freeBefore) bytes on the canonical volume."
