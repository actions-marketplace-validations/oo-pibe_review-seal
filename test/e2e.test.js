import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, cleanEnv, FAKE_CLAUDE } from './helpers.js';

const EXAMPLE = fileURLToPath(new URL('../example', import.meta.url));

test('example project ships without local review state', () => {
  assert.ok(existsSync(join(EXAMPLE, '.seal/config.json')));
  assert.ok(!existsSync(join(EXAMPLE, '.seal/.state')));
});

test('example project: blocked, reviewed, committed', () => {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'rs-e2e-'))), 'demo');
  cpSync(EXAMPLE, root, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...cleanEnv(), REVIEW_SEAL_CLAUDE: FAKE_CLAUDE } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  assert.equal(run(root, ['install-hook']).code, 0);
  git('add', '-A');
  assert.throws(() => git('commit', '-qm', 'try'), /never reviewed/);
  assert.equal(run(root, ['review', 'docs/tickets.md', 'docs/getting-there.md'], { env: { FAKE_CLAUDE_MODE: 'findings' } }).code, 0);
  assert.match(run(root, ['list']).out, /2 independent, 0 builder/);
  git('add', '-A');
  git('commit', '-qm', 'try again');
  assert.match(git('show', '--name-only', '--format=', 'HEAD'), /\.seal\/ledger\.json/);
  assert.equal(git('status', '--porcelain'), '');
});
