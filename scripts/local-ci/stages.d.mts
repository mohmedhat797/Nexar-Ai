import type { PlatformInfo } from './platform.mjs';
import type { SubprocessResult } from './process-util.mjs';

export interface VitestStats {
  testFilesPassed: number;
  testFilesFailed: number;
  testFilesTotal: number;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  testsTotal: number;
}

export interface WindowsPackageArtifacts {
  installerName: string;
  installerPath: string;
  sizeBytes: number;
  sha256: string;
  shaMatchesActual?: boolean;
  unpackedExists: boolean;
  unpackedPath: string;
  bundledDshExists?: boolean;
  bundledDshVersion?: string | null;
  bundledDshMatches?: boolean;
  signed: boolean;
  signatureStatus?: string;
  mtimeMs?: number;
  isStale?: boolean;
  staleReason?: string;
}

export interface StageDefinition {
  id: string;
  name: string;
  command?: string[];
  timeoutMs?: number;
  required: boolean;
  env?: NodeJS.ProcessEnv;
  customRun?: (ctx: StageContext) => Promise<SubprocessResult>;
}

export interface StageContext {
  repoRoot: string;
  signal?: AbortSignal | null;
  dshEntry?: string | null;
  packageStartTime?: number;
}

export interface StageRecord {
  id: string;
  name: string;
  command: string;
  startTime: string;
  durationMs: number;
  exitCode: number | null;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED' | 'NOT_RUN';
  required: boolean;
  failureCategory: string | null;
  logExcerpt: string;
  vitestStats: VitestStats | null;
}

export function parseVitestStats(stdout?: string): VitestStats;
export function inspectWindowsPackage(
  repoRoot: string,
  options?: { minMtimeMs?: number | null },
): WindowsPackageArtifacts | null;
export function getStages(
  mode: string,
  platformInfo: PlatformInfo,
  options?: { dshDir?: string | null; workers?: string | null },
): StageDefinition[];
export function executeStage(stage: StageDefinition, context: StageContext): Promise<StageRecord>;
