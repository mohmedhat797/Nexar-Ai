import {
  SandboxLauncher,
  checkSandboxAvailability,
  runSandboxSelfTest,
  type SandboxAvailability,
  type SelfTestResult,
} from '@nexar/sandbox';
import type { Command, CommandContext } from '../args.js';
import { loadCliConfig } from '../composition.js';
import { EXIT, UsageError } from '../io.js';

const USAGE = 'nexar sandbox selftest [--json]';

/** Text that comes from a probe: never let it write control sequences to a terminal. */
function plain(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
}

function print(ctx: CommandContext, view: unknown, text: string): void {
  ctx.io.stdout(ctx.json ? JSON.stringify(view, null, 2) + '\n' : text);
}

/** Availability, then the isolation checks against real processes in the configured profile. */
async function selftest(ctx: CommandContext): Promise<number> {
  const loaded = await loadCliConfig(ctx.io, ctx.configPath);
  const availability: SandboxAvailability = await (
    ctx.seams.sandbox?.availability ?? checkSandboxAvailability
  )();

  if (!availability.available) {
    print(
      ctx,
      { ok: false, available: false, detail: availability.detail, checks: [] },
      `✖ sandbox: unavailable — ${plain(availability.detail)}\n`,
    );
    return EXIT.sandboxUnavailable;
  }

  const launcher = new SandboxLauncher({
    toolchainPaths: loaded.config.engineering?.toolchainPaths ?? [],
    availability: () => Promise.resolve(availability),
  });
  const results: SelfTestResult[] = await (ctx.seams.sandbox?.runSelfTest ?? runSandboxSelfTest)(
    launcher,
    { socatAvailable: availability.socatPath !== undefined },
  );
  const ok = results.length > 0 && results.every((r) => r.passed);

  const lines = [`✔ sandbox: ${plain(availability.detail)}`];
  for (const r of results) {
    lines.push(r.passed ? `✔ ${plain(r.name)}` : `✖ ${plain(r.name)}: ${plain(r.detail)}`);
  }
  print(
    ctx,
    { ok, available: true, detail: availability.detail, checks: results },
    lines.join('\n') + '\n',
  );
  return ok ? EXIT.ok : EXIT.failure;
}

export const sandboxCommand: Command = {
  name: 'sandbox',
  summary: 'Check that the bubblewrap sandbox isolates as documented (no model calls)',
  usage: USAGE,
  options: {},
  async run(ctx) {
    const [action, ...rest] = ctx.positionals;
    if (action !== 'selftest' || rest.length > 0) throw new UsageError(`usage: ${USAGE}`);
    return selftest(ctx);
  },
};
