// Repository guard (ADR-008, security model):
//  1. Upstream packages may only be imported by their own integration package.
//  2. Files that commonly hold secrets or local runtime state must never be tracked.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Upstream import prefix → the only directory allowed to import it. */
const UPSTREAMS = [
  { prefix: '@earendil-works/', owner: 'integrations/pi/' },
  { prefix: '@modelcontextprotocol/', owner: 'integrations/mcp/' },
  { prefix: '@mariozechner/', owner: null }, // deprecated scope: never allowed
  { prefix: '@deepseek-ai/', owner: null }, // Nexar speaks the DSH wire protocol, no npm deps (ADR-002)
  { prefix: '@anthropic-ai/', owner: null },
  { prefix: '@openai/', owner: null },
];

const FORBIDDEN_TRACKED = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/,
  /(^|\/)\.nexar\//,
  /\.(pem|key|p12|pfx)$/,
  /\.(sqlite|sqlite3|db)$/,
  /(^|\/)\.credentials\.(json|ya?ml)$/,
  /(^|\/)auth\.json$/,
];

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const problems = [];

for (const file of tracked) {
  if (FORBIDDEN_TRACKED.some((re) => re.test(file))) {
    problems.push(`${file}: file type must never be committed (secrets / local state)`);
  }
}

const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
for (const file of tracked) {
  const isSource = /\.(ts|mts|cts|js|mjs|cjs)$/.test(file) && !file.startsWith('scripts/');
  const isManifest = file.endsWith('package.json');
  if (!isSource && !isManifest) continue;
  const text = readFileSync(file, 'utf8');
  const specifiers = isManifest
    ? Object.keys({
        ...(JSON.parse(text).dependencies ?? {}),
        ...(JSON.parse(text).devDependencies ?? {}),
      })
    : [...text.matchAll(importRe)].map((m) => m[1]);
  for (const spec of specifiers) {
    const rule = UPSTREAMS.find((u) => spec.startsWith(u.prefix));
    if (rule === undefined) continue;
    if (rule.owner === null || !file.startsWith(rule.owner)) {
      problems.push(
        `${file}: imports "${spec}" — only ${rule.owner ?? '(no package)'} may depend on ${rule.prefix}*`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`Boundary check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Boundary check passed (${String(tracked.length)} tracked files).`);
