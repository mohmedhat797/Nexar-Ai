export interface GitInfo {
  commit: string;
  branch: string;
  isDirty: boolean;
  dirtyFingerprint: string | null;
  summary: string;
  error?: string;
}

export interface NodeInfo {
  currentVersion: string;
  currentExec: string;
  pinnedMajor: string;
  activeExec: string;
  activeVersion: string;
  isMatched: boolean;
  source: string;
}

export interface PnpmInfo {
  expectedVersion: string;
  installedVersion: string | null;
  isMatched: boolean;
}

export interface GitleaksInfo {
  execPath: string | null;
  installedVersion: string | null;
  expectedVersion: string;
  isMatched: boolean;
  available: boolean;
}

export interface DshInfo {
  package: string;
  pinnedVersion: string;
  lockMatches: boolean;
  defaultInstallDir: string;
  cachedEntry: string | null;
}

export interface PlatformInfo {
  os: {
    platform: string;
    release: string;
    arch: string;
    cpus: number;
    totalMemGb: string;
    isWsl?: boolean;
  };
  git: GitInfo;
  node: NodeInfo;
  pnpm: PnpmInfo;
  gitleaks: GitleaksInfo;
  dsh: DshInfo;
  repoRoot: string;
}

export function getGitInfo(cwd?: string): GitInfo;
export function isSupportedNode(version: string, pinnedMajor?: string): boolean;
export function getNodeInfo(customNodeBin?: string | null): NodeInfo;
export function getPnpmInfo(nodeExec?: string): PnpmInfo;
export function getGitleaksInfo(customGitleaksBin?: string | null): GitleaksInfo;
export function getDshInfo(): DshInfo;
export function getPlatformInfo(options?: {
  customNodeBin?: string | null;
  customGitleaksBin?: string | null;
}): PlatformInfo;
