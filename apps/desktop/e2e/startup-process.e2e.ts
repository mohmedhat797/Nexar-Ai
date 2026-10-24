import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  mainProcessIdentity,
  seedE2EConfig,
  stateProcessObservation,
  type Harness,
} from './harness.js';

/** Two predetermined, independent profiles; no provider calls or personal settings. */
describe.skipIf(process.platform !== 'win32')(
  'native startup process identity and normal restart',
  () => {
    let harness: Harness;
    beforeAll(async () => {
      harness = await createHarness();
    });
    afterAll(async () => {
      await harness.dispose();
    });

    it('observes controlled native child cancellation in the actual Electron runtime', async () => {
      const { app } = await harness.launch(harness.newUserData('startup-native-cancellation'));
      const identity = await mainProcessIdentity(app);
      process.stdout.write(`electron runtime process identity ${JSON.stringify(identity)}\n`);
      for (const api of ['execFileSync', 'spawnSync'] as const) {
        const observed = await app.evaluate((_electron, selected) => {
          const childProcess = process.getBuiltinModule('child_process');
          const paths = process.getBuiltinModule('path');
          const crypto = process.getBuiltinModule('crypto');
          const clock = process.getBuiltinModule('perf_hooks');
          if (!childProcess || !paths || !crypto || !clock)
            throw new Error('Native runtime inspection unavailable');
          const systemRoot = Object.entries(process.env).find(
            ([key]) => key.toLowerCase() === 'systemroot',
          )?.[1];
          if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot))
            throw new Error('Native system tool unavailable');
          const command = paths.win32.join(
            systemRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          );
          // A controlled child, not the ACL guard: flush a marker then exceed the unchanged
          // 15-second native deadline. Do not return arguments, script, env or raw output.
          const script = String.raw`
$PSModuleAutoLoadingPreference = 'None'
[Console]::Out.WriteLine('nexar-state-guard:ready')
$own = [System.Diagnostics.Process]::GetCurrentProcess()
[Console]::Out.WriteLine($own.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',
  [System.Globalization.CultureInfo]::InvariantCulture))
$own.Dispose()
[Console]::Out.Flush()
[System.Threading.Thread]::Sleep(30000)
`;
          const args = [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ];
          const options = {
            env: { SystemRoot: systemRoot },
            windowsHide: true,
            shell: false,
            timeout: 15000,
            maxBuffer: 16 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[],
          };
          const startedAtUtc = new Date().toISOString();
          const started = clock.performance.now();
          let native: unknown;
          if (selected === 'execFileSync') {
            try {
              childProcess.execFileSync(command, args, options);
            } catch (error) {
              native = error;
            }
          } else {
            native = childProcess.spawnSync(command, args, options);
          }
          const elapsedMs = Math.round(clock.performance.now() - started);
          const endedAtUtc = new Date().toISOString();
          const result = native as
            | {
                pid?: number;
                status?: number | null;
                code?: unknown;
                error?: { code?: unknown };
                signal?: unknown;
                stdout?: unknown;
                output?: unknown[];
              }
            | undefined;
          const stdout = result?.stdout;
          const alternate = result?.output?.[1];
          const text = (value: unknown): string => {
            if (typeof value === 'string' || Buffer.isBuffer(value)) return String(value);
            if (ArrayBuffer.isView(value))
              return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
            return '';
          };
          const captured = text(stdout) || text(alternate);
          const created = captured
            .split(/\r?\n/)
            .find((line) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(line));
          const childPid =
            Number.isInteger(result?.pid) && result!.pid! > 0 ? result!.pid : undefined;
          let childExit: 'absent' | 'reused-pid' | 'still-present' | 'unknown' = 'unknown';
          let verificationChildPid: number | undefined;
          let verificationExitCode: number | null | undefined;
          if (childPid && created) {
            const query =
              `try { $p = [System.Diagnostics.Process]::GetProcessById(${childPid}); ` +
              `$t = $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture); ` +
              `$p.Dispose(); if ($t -eq '${created}') { [Console]::Out.WriteLine('still-present') } ` +
              `else { [Console]::Out.WriteLine('reused-pid') } } ` +
              `catch [System.ArgumentException] { [Console]::Out.WriteLine('absent') }`;
            const checked = childProcess.spawnSync(
              command,
              [
                '-NoProfile',
                '-NonInteractive',
                '-EncodedCommand',
                Buffer.from(query, 'utf16le').toString('base64'),
              ],
              options,
            );
            verificationChildPid = checked.pid;
            verificationExitCode = checked.status;
            const status = text(checked.stdout).trim();
            if (
              checked.status === 0 &&
              ['absent', 'reused-pid', 'still-present'].includes(status)
            ) {
              childExit = status as 'absent' | 'reused-pid' | 'still-present';
            }
          }
          const code = result?.error?.code ?? result?.code;
          return {
            scope: 'controlled-child-not-private-state-validation',
            api: selected,
            parentPid: process.pid,
            childPid,
            startedAtUtc,
            endedAtUtc,
            elapsedMs,
            timeoutMs: 15000,
            nativeCode: code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'other',
            termination: code === 'ETIMEDOUT' ? 'timeout' : 'other',
            exitCode: Number.isInteger(result?.status) ? result?.status : undefined,
            signal:
              result?.signal === 'SIGTERM' || result?.signal === 'SIGKILL'
                ? result.signal
                : undefined,
            stdoutBuffer: Buffer.isBuffer(stdout),
            stdoutView: ArrayBuffer.isView(stdout),
            stdoutReadiness: text(stdout).includes('nexar-state-guard:ready'),
            alternateReadiness: text(alternate).includes('nexar-state-guard:ready'),
            childCreatedAtUtc: created,
            childExit,
            verificationChildPid,
            verificationExitCode,
            versions: {
              node: process.versions.node,
              electron: process.versions.electron,
              uv: process.versions.uv,
            },
            functionSha256: crypto
              .createHash('sha256')
              .update(childProcess[selected].toString())
              .digest('hex'),
          };
        }, api);
        process.stdout.write(`electron controlled native outcome ${JSON.stringify(observed)}\n`);
        expect(observed.parentPid).toBe(identity.pid);
        expect(observed.nativeCode).toBe('ETIMEDOUT');
        expect(observed.elapsedMs).toBeGreaterThanOrEqual(15000);
        expect(observed.stdoutReadiness || observed.alternateReadiness).toBe(true);
        expect(['absent', 'reused-pid']).toContain(observed.childExit);
      }
      await harness.close(app);
    }, 120_000);

    it('fails closed on a junction before native initialization and leaves its target intact', async () => {
      const userData = harness.newUserData('startup-invalid');
      await seedE2EConfig(userData);
      const target = join(harness.base, 'startup-owned-target');
      await mkdir(target);
      const sentinel = join(target, 'sentinel.txt');
      await writeFile(sentinel, 'controlled-test-target');
      await symlink(target, join(userData, 'redirect'), 'junction');
      const failure = await harness.launch(userData).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/PrivateStateError.*"category":"preflight"/);
      expect(message).toMatch(/process did exit: exitCode=1/);
      expect(await readFile(sentinel, 'utf8')).toBe('controlled-test-target');
      const pid = /<launched> pid=(\d+)/.exec(message)?.[1];
      process.stdout.write(
        `desktop startup controlled failure ${JSON.stringify({
          kind: 'junction-preflight',
          parentPid: pid ? Number(pid) : undefined,
          exitObserved: true,
          targetIntact: true,
        })}\n`,
      );
    }, 120_000);

    it.each([1, 2])(
      'creates and rechecks private state with owned cleanup (attempt %i)',
      async (attempt) => {
        const userData = harness.newUserData(`startup-${attempt}`);
        let previousCorrelation: string | undefined;
        let previousRequest: string | undefined;
        for (const phase of ['fresh', 'restart'] as const) {
          const { app } = await harness.launch(userData);
          const identity = await mainProcessIdentity(app);
          const events = await stateProcessObservation(app);
          const result = events.find((event) => event.event === 'result');
          if (result?.event !== 'result') throw new Error('Missing native startup observation');
          expect(result.parentPid).toBe(identity.pid);
          expect(result.correlationId).not.toBe(previousCorrelation);
          // Numeric PIDs may be reused by Windows; compare fresh invocation evidence instead.
          expect(result.spawnRequestedAtUtc).not.toBe(previousRequest);
          expect(result.childCreated).toBe(true);
          expect(result.childPid).not.toBe(result.parentPid);
          expect(result.readinessCaptured).toBe(true);
          expect(result.exitCode).toBe(0);
          expect(result.termination).toBe('exited');
          expect(result.timeoutMs).toBe(15000);
          expect(result.scriptPhases.map((item) => item.phase)).toEqual([
            'ready',
            'tree-checked',
            'acl-verified',
            'complete',
          ]);
          expect(result.scriptPhases.every((item) => item.childPid === result.childPid)).toBe(true);
          process.stdout.write(
            `desktop startup matrix ${JSON.stringify({ attempt, phase, events })}\n`,
          );
          previousCorrelation = result.correlationId;
          previousRequest = result.spawnRequestedAtUtc;
          const owned = app.process();
          await harness.close(app);
          expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
          const present = (): boolean => {
            try {
              process.kill(identity.pid, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
              throw new Error('Cannot observe the owned main process after close', {
                cause: error,
              });
            }
          };
          process.stdout.write(
            `desktop startup main exit ${JSON.stringify({
              mainPid: identity.pid,
              launcherPid: identity.launcherPid,
              mainPidPresentAfterLauncherExit: present(),
            })}\n`,
          );
          await expect.poll(present, { timeout: 5000, interval: 50 }).toBe(false);
        }
      },
      120_000,
    );
  },
);
