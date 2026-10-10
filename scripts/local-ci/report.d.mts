import type { GitInfo, PlatformInfo } from './platform.mjs';
import type { PreflightResult } from './preflight.mjs';
import type { StageRecord, VitestStats } from './stages.mjs';

export interface RunData {
  mode: string;
  profile: string;
  platformInfo: PlatformInfo;
  preflightResult: PreflightResult;
  stageResults: StageRecord[];
  startTime: number;
  endTime: number;
  durationMs: number;
  sourceEnd?: GitInfo;
  interrupted?: boolean;
}

export interface ReportOutputs {
  finalStatus: string;
  reportObject: unknown;
  jsonPath: string;
  mdPath: string;
  latestJsonPath: string;
  latestMdPath: string;
}

export interface StageTestMetric {
  stageId: string;
  stageName: string;
  testFilesPassed: number;
  testFilesTotal: number;
  testsPassed: number;
  testsSkipped: number;
  testsFailed: number;
  testsTotal: number;
  testsPending?: number;
  testsTodo?: number;
  testsUnclassified?: number;
}

export interface CrossPlatformEvidence {
  verdict: 'NEXAR_CROSS_PLATFORM_ACCEPTANCE_PASS' | 'NEXAR_CROSS_PLATFORM_ACCEPTANCE_INCOMPLETE';
  reasons: string[];
  matchedCommit: string | null;
  details: unknown;
}

export const EXPECTED_STAGES: {
  quick: string[];
  windows_full: string[];
  linux_full: string[];
};

export function computeFinalStatus(
  mode: string,
  stageResults?: StageRecord[],
  options?: { platform?: string; isWsl?: boolean },
): string;
export function aggregateTestCounts(stageResults: StageRecord[]): VitestStats;
export function extractStageTestMetrics(stageResults: StageRecord[]): StageTestMetric[];
export function aggregateCrossPlatformEvidence(
  windowsReport: { finalStatus: string; metadata?: any },
  linuxReport: { finalStatus: string; metadata?: any },
): CrossPlatformEvidence;
export function generateReports(runData: RunData): ReportOutputs;
export function sourceIdentityMatches(before: GitInfo, after: GitInfo): boolean;
export function showLatestReport(repoRoot: string): void;
