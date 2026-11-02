import { lstatSync, readdirSync } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  runWindowsStateProcess,
  STATE_GUARD_PHASE,
  STATE_GUARD_READY,
  WindowsStateProcessError,
  type WindowsStateProcessEvent,
  type WindowsStateProcessResult,
  type WindowsStateToolOptions,
} from './private-state-process.js';
const FAILURE = 'Cannot secure the Desktop state directory';
const READY = STATE_GUARD_READY;
/** Directly under the state root. Vendor CLIs write here, so its contents are not state files. */
export const RUNTIME_HOMES_DIRECTORY = 'runtime-homes';

type WindowsOptions = WindowsStateToolOptions;

/** Dependency seams for testing tool failures without changing the host's system directory. */
export interface PrivateStateOptions {
  /** Additional shared directories, such as Electron's appData base, that cannot be state roots. */
  readonly forbiddenPaths?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly systemRoot?: string;
  /** Safe allowlisted metadata only. Native initialization remains synchronous. */
  readonly onProcessTrace?: (event: WindowsStateProcessEvent) => void;
  readonly runWindows?: (
    command: string,
    args: readonly string[],
    options: WindowsOptions,
  ) => Promise<void>;
}

// The path is data in a private environment variable, never interpolated into this script.
// Windows PowerShell uses .NET Framework's ACL-aware CreateDirectory overload, which creates
// a missing state root with the private descriptor instead of inheriting a broad parent ACL.
// Module auto-loading stays off: the script uses only .NET and core language features, so no
// module from PSModulePath is imported and no first-use module analysis delays startup.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
try {
  [Console]::Out.WriteLine('${READY}')
  [Console]::Out.Flush()
  $guardReadyAt = [System.DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ',
    [System.Globalization.CultureInfo]::InvariantCulture)
  $guardClock = [System.Diagnostics.Stopwatch]::StartNew()
  $guardProcess = [System.Diagnostics.Process]::GetCurrentProcess()
  $guardCreatedAt = $guardProcess.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',
    [System.Globalization.CultureInfo]::InvariantCulture)
  $guardProcess.Dispose()
  function Write-GuardPhase([string] $phase) {
    $at = [System.DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ',
      [System.Globalization.CultureInfo]::InvariantCulture)
    $pidText = $PID.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    $duration = $guardClock.ElapsedMilliseconds.ToString(
      [System.Globalization.CultureInfo]::InvariantCulture)
    [Console]::Out.WriteLine(('${STATE_GUARD_PHASE}|{0}|{1}|{2}|{3}|{4}|{5}' -f
      $phase, $pidText, $guardCreatedAt, $guardReadyAt, $at, $duration))
    [Console]::Out.Flush()
  }
  Write-GuardPhase 'ready'
  $path = [System.IO.Path]::GetFullPath($env:NEXAR_PRIVATE_STATE_PATH)
  $reserved = @([System.IO.Path]::GetPathRoot($path), [System.IO.Path]::GetTempPath())
  foreach ($folder in @('UserProfile', 'ApplicationData', 'LocalApplicationData', 'Desktop', 'MyDocuments')) {
    $reserved += [System.Environment]::GetFolderPath([System.Environment+SpecialFolder] $folder)
  }
  foreach ($reservedPath in $reserved) {
    if ($reservedPath -and $path.TrimEnd('\') -ieq $reservedPath.TrimEnd('\')) {
      throw 'State root is a shared location'
    }
  }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $caller = [System.Security.Principal.WindowsPrincipal]::new($identity)
  $principals = @($sid,
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor
    [System.Security.AccessControl.AccessControlSections]::Owner

  function Attributes-OrMissing([string] $itemPath) {
    try { return [System.IO.File]::GetAttributes($itemPath) }
    catch [System.IO.FileNotFoundException] { return $null }
    catch [System.IO.DirectoryNotFoundException] { return $null }
  }
  function Assert-NotReparse([System.IO.FileAttributes] $attributes) {
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'State reparse point'
    }
  }
  function Private-Security([bool] $directory) {
    if ($directory) {
      $security = [System.Security.AccessControl.DirectorySecurity]::new()
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      $security = [System.Security.AccessControl.FileSecurity]::new()
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($principal in $principals) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal,
        [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
      [void] $security.AddAccessRule($rule)
    }
    return $security
  }
  function Assert-Owned([System.IO.FileSystemInfo] $item) {
    $item.Refresh()
    Assert-NotReparse $item.Attributes
    $security = $item.GetAccessControl($sections)
    $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $sid.Value) {
      # Elevated Windows tokens may create files owned by local Administrators. Normalize
      # only trusted owners, and only using rights the caller already has: no elevation or
      # privilege enabling. Normal SetAccessControl checks still enforce the effective ACL.
      if ($owner -ne 'S-1-5-18' -and $owner -ne 'S-1-5-32-544') { throw 'State owner mismatch' }
      $required = [int] [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [int] [System.Security.AccessControl.FileSystemRights]::TakeOwnership
      $allowed = 0
      $denied = 0
      foreach ($accessRule in $security.GetAccessRules($true, $true,
        [System.Security.Principal.SecurityIdentifier])) {
        if (($accessRule.PropagationFlags -band
          [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($accessRule.IdentityReference.Value -ne $sid.Value -and
          -not $caller.IsInRole($accessRule.IdentityReference)) { continue }
        if ($accessRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
          $allowed = $allowed -bor [int] $accessRule.FileSystemRights
        } else { $denied = $denied -bor [int] $accessRule.FileSystemRights }
      }
      if (($allowed -band $required) -ne $required -or ($denied -band $required) -ne 0) {
        throw 'State owner cannot be normalized'
      }
    }
    return $security
  }
  function Assert-Private([System.IO.FileSystemInfo] $item) {
    $security = Assert-Owned $item
    if ($security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
      throw 'State owner not normalized'
    }
    if (-not $security.AreAccessRulesProtected) { throw 'State ACL unprotected' }
    $rules = @($security.GetAccessRules($true, $true,
      [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) { throw 'State ACL rule count' }
    $directory = $item -is [System.IO.DirectoryInfo]
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($directory) {
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    foreach ($principal in $principals) {
      $matching = @($rules | Where-Object { $_.IdentityReference.Value -eq $principal.Value })
      if ($matching.Count -ne 1) { throw 'State ACL principal mismatch' }
      $rule = $matching[0]
      if ($rule.IsInherited -or
        $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne $inheritance -or
        $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
        throw 'State ACL rights mismatch'
      }
    }
  }

  # Inspect ancestors without changing their ACLs; a junction in the path redirects state too.
  $ancestor = [System.IO.DirectoryInfo]::new($path)
  while ($null -ne $ancestor) {
    $attributes = Attributes-OrMissing $ancestor.FullName
    if ($null -ne $attributes) {
      Assert-NotReparse $attributes
      if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
        throw 'State ancestor is not a directory'
      }
    }
    $ancestor = $ancestor.Parent
  }

  $attributes = Attributes-OrMissing $path
  if ($null -eq $attributes) {
    [void] [System.IO.Directory]::CreateDirectory($path, (Private-Security $true))
  }
  $root = [System.IO.DirectoryInfo]::new($path)
  [void] (Assert-Owned $root)
  $marker = [System.IO.Path]::Combine($path, '.nexar-desktop-state')
  $config = [System.IO.Path]::Combine($path, 'nexar.config.json')
  if ($root.GetFileSystemInfos().Length -gt 0 -and
    -not [System.IO.File]::Exists($config) -and -not [System.IO.File]::Exists($marker)) {
    throw 'State tree not recognized'
  }
  $pending = [System.Collections.Generic.Stack[System.IO.FileSystemInfo]]::new()
  $items = [System.Collections.Generic.List[System.IO.FileSystemInfo]]::new()
  $pending.Push($root)
  # Preflight the entire dedicated app-state tree before replacing any existing ACL.
  # Do not recurse with /T or Get-ChildItem -Recurse: neither is our link boundary.
  while ($pending.Count -gt 0) {
    $item = $pending.Pop()
    if ($items.Count -ge 10000) { throw 'State tree too large' }
    [void] (Assert-Owned $item)
    $items.Add($item)
    # Native runtime homes hold vendor files and are guarded at every use, not on startup.
    if ($item -is [System.IO.DirectoryInfo] -and -not ($item.Name -ieq '${RUNTIME_HOMES_DIRECTORY}' -and
      $item.Parent.FullName -ieq $root.FullName)) {
      foreach ($child in $item.GetFileSystemInfos()) { $pending.Push($child) }
    }
  }
  Write-GuardPhase 'tree-checked'
  foreach ($item in $items) {
    [void] (Assert-Owned $item)
    $item.SetAccessControl((Private-Security ($item -is [System.IO.DirectoryInfo])))
    Assert-Private $item
  }
  Write-GuardPhase 'acl-verified'
  if (-not [System.IO.File]::Exists($marker)) {
    # The root is already private: the marker inherits its restricted grants from creation.
    $stream = [System.IO.File]::Open($marker, [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $stream.Dispose()
  }
  Write-GuardPhase 'complete'
  exit 0
} catch {
  # A fixed category code only: never the message, path or account in the exception.
  $codes = @{
    'State root is a shared location' = 2; 'State reparse point' = 3
    'State ancestor is not a directory' = 4; 'State owner mismatch' = 5
    'State owner cannot be normalized' = 6; 'State tree not recognized' = 7
    'State tree too large' = 8; 'State owner not normalized' = 9; 'State ACL unprotected' = 9
    'State ACL rule count' = 9; 'State ACL principal mismatch' = 9; 'State ACL rights mismatch' = 9
  }
  $code = $codes[[string] $_.Exception.Message]
  if ($null -eq $code) { $code = 1 }
  exit $code
}
`;

const EXIT_CATEGORIES: Readonly<Record<number, string>> = {
  1: 'tool-error',
  2: 'shared-location',
  3: 'reparse-point',
  4: 'ancestor-not-directory',
  5: 'owner-mismatch',
  6: 'owner-not-normalizable',
  7: 'unrecognized-tree',
  8: 'tree-too-large',
  9: 'acl-verification',
};

/** Safe failure metadata: a fixed category, phase, exit code and duration. Never paths or output. */
export interface PrivateStateDiagnostic {
  readonly category: string;
  /** `startup` means no readiness was captured, not proof the script never executed. */
  readonly phase: 'preflight' | 'startup' | 'execution';
  readonly exitCode?: number;
  readonly elapsedMs?: number;
  readonly process?: WindowsStateProcessResult;
}

export class PrivateStateError extends Error {
  constructor(readonly diagnostic: PrivateStateDiagnostic) {
    super(FAILURE);
    this.name = 'PrivateStateError';
  }
}

function toolDiagnostic(error: unknown, elapsedMs: number): PrivateStateDiagnostic {
  const observed = error instanceof WindowsStateProcessError ? error.result : undefined;
  const failure = (
    error instanceof WindowsStateProcessError
      ? { code: error.nativeCode, status: error.result.exitCode, signal: error.result.signal }
      : typeof error === 'object' && error !== null
        ? error
        : {}
  ) as {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly signal?: unknown;
    readonly stdout?: unknown;
  };
  const stdout = failure.stdout;
  const started =
    observed?.readinessCaptured ??
    ((typeof stdout === 'string' || Buffer.isBuffer(stdout)) && String(stdout).includes(READY));
  const phase = started ? 'execution' : 'startup';
  const timing = {
    elapsedMs: observed?.elapsedMs ?? Math.round(elapsedMs),
    ...(observed ? { process: observed } : {}),
  };
  if (failure.code === 'ETIMEDOUT') return { category: 'timeout', phase, ...timing };
  if (failure.code === 'ENOENT') return { category: 'tool-unavailable', phase, ...timing };
  if (typeof failure.status === 'number') {
    return {
      category: EXIT_CATEGORIES[failure.status] ?? 'tool-error',
      phase,
      exitCode: failure.status,
      ...timing,
    };
  }
  return {
    category: typeof failure.signal === 'string' ? 'killed' : 'tool-error',
    phase,
    ...timing,
  };
}

function windowsFileBoundary(path: string): void {
  // A hard link is not a reparse point: changing its DACL changes the outside file too.
  // lstat reports the link count without following a junction or symlink. Check ancestors
  // before enumerating, and bound the dedicated state tree before starting the ACL tool.
  let ancestor = path;
  while (true) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error(FAILURE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const pending = [path];
  let count = 0;
  while (pending.length > 0) {
    const itemPath = pending.pop()!;
    let info;
    try {
      info = lstatSync(itemPath);
    } catch (error) {
      if (itemPath === path && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (++count > 10_000 || info.isSymbolicLink()) throw new Error(FAILURE);
    if (info.isDirectory()) {
      if (itemPath === join(path, RUNTIME_HOMES_DIRECTORY)) continue;
      const children = readdirSync(itemPath);
      if (count + pending.length + children.length > 10_000) throw new Error(FAILURE);
      if (
        itemPath === path &&
        children.length > 0 &&
        !children.includes('nexar.config.json') &&
        !children.includes('.nexar-desktop-state')
      ) {
        throw new Error(FAILURE);
      }
      for (const child of children) pending.push(join(itemPath, child));
    } else if (!info.isFile() || info.nlink !== 1) {
      throw new Error(FAILURE);
    }
  }
}

async function securePosix(path: string, forbiddenPaths: readonly string[]): Promise<void> {
  const reserved = [
    homedir(),
    tmpdir(),
    join(homedir(), '.config'),
    join(homedir(), 'Library', 'Application Support'),
    resolve('/'),
    ...forbiddenPaths,
  ];
  if (reserved.some((item) => resolve(item) === path)) throw new Error(FAILURE);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(FAILURE);
  }
  // Chromium's POSIX SingletonLock and related entries are symlinks. Do not recurse through
  // Electron's runtime data; config/settings writes already create owner-only atomic files.
  await chmod(path, 0o700);
}

/**
 * Secures a dedicated Desktop state tree before reading configuration or creating state files.
 * Windows replaces inherited AND explicit grants, allowing only this user, SYSTEM and local
 * Administrators. Windows foreign owners, reparse points and hard links fail closed; trusted
 * SYSTEM/Admin-owned entries may be normalized using the caller's existing DACL/owner rights.
 * A nonempty Windows tree must contain a Nexar config or the Desktop state marker. Parent ACLs
 * are never changed. This is startup validation, not handle-based containment against races.
 */
export async function ensurePrivateStateDirectory(
  path: string,
  options: PrivateStateOptions = {},
): Promise<void> {
  try {
    if ((options.platform ?? process.platform) !== 'win32') {
      await securePosix(resolve(path), options.forbiddenPaths ?? []);
      return;
    }
    const systemRoot =
      options.systemRoot ??
      Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
    if (systemRoot === undefined || !/^[a-z]:[\\/]/i.test(systemRoot)) throw new Error(FAILURE);
    if (!win32.isAbsolute(path) || !/^[a-z]:[\\/]/i.test(path)) throw new Error(FAILURE);
    const statePath = win32.resolve(path);
    if (statePath === win32.parse(statePath).root) throw new Error(FAILURE);
    const reserved = [
      homedir(),
      tmpdir(),
      join(homedir(), 'Desktop'),
      join(homedir(), 'Documents'),
      join(homedir(), 'Downloads'),
      ...Object.entries(process.env)
        .filter(([key]) => ['appdata', 'localappdata'].includes(key.toLowerCase()))
        .map(([, value]) => value)
        .filter((value): value is string => value !== undefined && value !== ''),
      ...(options.forbiddenPaths ?? []),
    ];
    if (reserved.some((item) => win32.resolve(item).toLowerCase() === statePath.toLowerCase())) {
      throw new Error(FAILURE);
    }
    if (process.platform === 'win32') windowsFileBoundary(statePath);
    const runWindows =
      options.runWindows ??
      ((command, args, toolOptions) => {
        // Complete native Windows creation/normalization before yielding to Electron's
        // readiness event: Chromium otherwise creates unrecognized first-run cache files.
        // stdout carries only fixed markers and parsed numeric/time metadata; never forward it.
        runWindowsStateProcess(command, args, toolOptions, {
          ...(options.onProcessTrace ? { onEvent: options.onProcessTrace } : {}),
        });
        return Promise.resolve();
      });
    const started = performance.now();
    try {
      await runWindows(
        win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64'),
        ],
        {
          env: { SystemRoot: systemRoot, NEXAR_PRIVATE_STATE_PATH: statePath },
          windowsHide: true,
          shell: false,
          timeout: 15_000,
          maxBuffer: 16 * 1024,
        },
      );
    } catch (error) {
      throw new PrivateStateError(toolDiagnostic(error, performance.now() - started));
    }
  } catch (error) {
    // Never include subprocess output, account identifiers, paths or a sensitive cause.
    if (error instanceof PrivateStateError) throw error;
    throw new PrivateStateError({ category: 'preflight', phase: 'preflight' });
  }
}
