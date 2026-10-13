import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/review-seal.js', import.meta.url));
export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
chmodSync(FAKE_CLAUDE, 0o755);

for (const k of Object.keys(process.env)) {
  if (/^(GIT_|CLAUDE|FAKE_CLAUDE_)/.test(k)) delete process.env[k];
}
delete process.env.REVIEW_SEAL_CHILD;
delete process.env.PRE_COMMIT;
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', TZ: 'UTC' });

export const cleanEnv = () => ({ ...process.env });

export function write(root, p, c) {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), c);
}

export function tmpRepo(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-seal-')));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe', env: cleanEnv() });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  for (const [p, c] of Object.entries(files)) write(root, p, c);
  return { root, git };
}

export const CONFIG = { passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'] } } };

export function sealRepo(over = {}) {
  return tmpRepo({
    '.seal/config.json': JSON.stringify({ ...CONFIG, ...over }),
    '.seal/rubrics/consistency.md': 'Does the text contradict itself?\n',
    'docs/guide.md': 'Visitors can buy tickets with a passport.\n',
    'src/app.js': 'console.log(1);\n',
  });
}

export function run(root, args, { env = {}, input, cwd = root } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', input, timeout: 120_000,
    env: { ...cleanEnv(), REVIEW_SEAL_CLAUDE: FAKE_CLAUDE, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
