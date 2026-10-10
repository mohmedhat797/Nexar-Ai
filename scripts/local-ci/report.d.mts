import type { PlatformInfo } from './platform.mjs';
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
}

export interface ReportOutputs {
  finalStatus: string;
  reportObject: unknown;
  jsonPath: string;
  mdPath: string;
  latestJsonPath: string;
  latestMdPath: string;
}

export function computeFinalStatus(mode: string, stageResults: StageRecord[]): string;
export function aggregateTestCounts(stageResults: StageRecord[]): VitestStats;
export function generateReports(runData: RunData): ReportOutputs;
export function showLatestReport(repoRoot: string): void;
