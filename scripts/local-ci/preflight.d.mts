import type { PlatformInfo } from './platform.mjs';

export interface PreflightCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED';
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  diagnostics: string[];
}

export function runPreflight(
  platformInfo: PlatformInfo,
  options?: {
    mode?: string;
    allowNodeMismatch?: boolean;
  },
): Promise<PreflightResult>;
