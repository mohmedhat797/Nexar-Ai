import { describe, expect, it, vi } from 'vitest';
import { ownerCodexSubscription } from './subscriptions.js';

const signal = new AbortController().signal;
const home = process.platform === 'win32' ? 'C:\\homes\\one\\codex' : '/homes/one/codex';

type Run = NonNullable<Parameters<typeof ownerCodexSubscription>[0]['runCommand']>;

function fakeRun() {
  return vi.fn<Run>(() =>
    Promise.resolve({
      kind: 'exited',
      exitCode: 0,
      stdout: 'Logged in using ChatGPT',
      stderr: '',
    }),
  );
}

describe('ownerCodexSubscription', () => {
  it('runs login and its status checks only in the given home', async () => {
    const run = fakeRun();
    const runtime = ownerCodexSubscription({
      env: { CODEX_HOME: '/vendor/default', codex_home: '/other', PATH: '/bin' },
      cwd: '/',
      home,
      runCommand: run,
    });
    await runtime.probe(signal);
    await runtime.login(signal);
    expect(run.mock.calls.map(([call]) => call.args.join(' '))).toEqual([
      '--version',
      'login status',
      'login',
    ]);
    for (const [call] of run.mock.calls) expect(call.env['CODEX_HOME']).toBe(home);
  });

  it('does not pass key variables to the login process', async () => {
    const run = fakeRun();
    await ownerCodexSubscription({
      env: { OPENAI_API_KEY: 'sk-sentinel', CODEX_API_KEY: 'sk-sentinel', PATH: '/bin' },
      cwd: '/',
      home,
      runCommand: run,
    }).login(signal);
    expect(run).toHaveBeenCalled();
    expect(JSON.stringify(run.mock.calls)).not.toContain('sk-sentinel');
  });

  it.each(['relative/home', '', 'bad\nhome'])(
    'runs nothing rather than fall back to the vendor default for %j',
    async (bad) => {
      const run = fakeRun();
      const runtime = ownerCodexSubscription({
        env: { CODEX_HOME: home, PATH: '/bin' },
        cwd: '/',
        home: bad,
        runCommand: run,
      });
      expect((await runtime.probe(signal)).status).not.toBe('connected');
      expect(await runtime.login(signal)).toBe('unavailable');
      expect(run).not.toHaveBeenCalled();
    },
  );
});
