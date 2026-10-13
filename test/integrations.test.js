import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { sealRepo, write, run, cleanEnv, FAKE_CLAUDE } from './helpers.js';

test('review/check --changed-since behave as the Action uses them', () => {
  const { root, git } = sealRepo();
  git('add', '-A'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  write(root, 'docs/guide.md', 'A changed claim.\n');
  git('commit', '-qam', 'change');
  assert.equal(run(root, ['check', '--changed-since', 'origin/main']).code, 1);
  assert.equal(run(root, ['review', '--changed-since', 'origin/main'], { env: { REVIEW_SEAL_CLAUDE: FAKE_CLAUDE } }).code, 0);
  assert.equal(run(root, ['check', '--changed-since', 'origin/main']).code, 0);
});

// language: script runs the file from the hook repo's checkout with the system node; language: node would
// have pre-commit npm-install the repo, which npm 11 refuses for git sources.
test('pre-commit manifest runs the script directly with check --staged', () => {
  const y = readFileSync(new URL('../.pre-commit-hooks.yaml', import.meta.url), 'utf8');
  assert.match(y, /^ {2}entry: bin\/review-seal\.js$/m);
  assert.match(y, /^ {2}args: \[check, --staged\]$/m);
  assert.match(y, /^ {2}language: script$/m);
  assert.match(y, /^ {2}pass_filenames: false$/m);
  assert.match(y, /^ {2}always_run: true$/m);
});

// Expressions may appear only as an input default, an if: condition or an env: value, never in a run: body.
const exprOutsideEnv = (y) => y.split('\n').filter((l) => l.includes('${{') && !/^\s+(default|if|[A-Z_][A-Z0-9_]*):/.test(l));

test('action passes inputs through env only', () => {
  const y = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.deepEqual(exprOutsideEnv(y), []);
  // The check catches an expression inside a multi-line run body.
  const bad = y.replace(/(\n(\s+)run: \|\n)/, '$1$2  echo "${{ inputs.base }}"\n');
  assert.notEqual(bad, y);
  assert.deepEqual(exprOutsideEnv(bad).map((l) => l.trim()), ['echo "${{ inputs.base }}"']);
});

// The run: body of the action step with this name, dedented.
function stepScript(name) {
  const lines = readFileSync(new URL('../action.yml', import.meta.url), 'utf8').split('\n');
  let i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `no step named ${name}`);
  while (!/^\s+run:/.test(lines[i])) i++;
  const m = lines[i].match(/^(\s+)run:\s*(.*)$/);
  if (m[2] !== '|') return m[2];
  const body = [];
  for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].match(/^\s*/)[0].length > m[1].length); i++) body.push(lines[i]);
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return body.map((l) => l.slice(pad)).join('\n');
}
const ACTION_PATH = fileURLToPath(new URL('..', import.meta.url));
// One runner temp dir per repo, shared by its steps as on a real runner.
const runnerTemp = new Map();
function step(root, name, env = {}) {
  if (!runnerTemp.has(root)) runnerTemp.set(root, mkdtempSync(join(tmpdir(), 'review-seal-runner-')));
  // Composite bash steps run as: bash --noprofile --norc -eo pipefail {0}
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepScript(name)], {
    cwd: root, encoding: 'utf8',
    env: { ...cleanEnv(), GITHUB_ACTION_PATH: ACTION_PATH, RUNNER_TEMP: runnerTemp.get(root), REVIEW_SEAL_CLAUDE: FAKE_CLAUDE, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
// A pull request: base on origin/main, one commit changing a covered file on branch "pr".
function prRepo({ trackLedger = true } = {}) {
  const r = sealRepo();
  if (trackLedger) write(r.root, '.seal/ledger.json', '{}\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'base');
  r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  r.git('checkout', '-qb', 'pr');
  write(r.root, 'docs/guide.md', 'A changed claim.\n');
  r.git('commit', '-qam', 'change');
  return r;
}

test('action: inputs are validated before anything is installed', () => {
  const { root } = prRepo();
  const ok = { BASE: 'main', ANTHROPIC_API_KEY: 'k' };
  assert.equal(step(root, 'Validate inputs', ok).code, 0);
  const noBase = step(root, 'Validate inputs', { ...ok, BASE: '' });
  assert.equal(noBase.code, 1);
  assert.match(noBase.out, /^::error::review-seal: no base branch \(this action runs on pull_request events\)/m);
  const noKey = step(root, 'Validate inputs', { ...ok, ANTHROPIC_API_KEY: '' });
  assert.equal(noKey.code, 1);
  assert.match(noKey.out, /^::error::review-seal: anthropic-api-key is empty \(fork pull request or missing secret\)/m);
  const noRef = step(root, 'Validate inputs', { ...ok, BASE: 'develop' });
  assert.equal(noRef.code, 1);
  assert.match(noRef.out, /^::error::review-seal: origin\/develop not found; use actions\/checkout with fetch-depth: 0/m);
});

test('action, commit "true": the ledger is committed on the branch and the check passes', () => {
  for (const trackLedger of [true, false]) {
    const { root, git } = prRepo({ trackLedger });
    const remote = mkdtempSync(join(tmpdir(), 'review-seal-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote], { env: cleanEnv() });
    git('remote', 'add', 'origin', remote); git('push', '-qu', 'origin', 'pr');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    assert.equal(step(root, 'Review changed files', { BASE: 'main' }).code, 0);
    const c = step(root, 'Commit the ledger');
    assert.equal(c.code, 0, c.err);
    assert.match(git('show', '--name-only', '--format=%s', 'HEAD'), /^review-seal: record independent reviews\n[\s\S]*\.seal\/ledger\.json/);
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/pr'));
    assert.equal(step(root, 'Check', { BASE: 'main' }).code, 0);
  }
});

test('action, commit "true" on a detached HEAD fails with a plain instruction', () => {
  const { root, git } = prRepo();
  git('checkout', '-q', '--detach');
  assert.equal(step(root, 'Review changed files', { BASE: 'main' }).code, 0);
  const c = step(root, 'Commit the ledger');
  assert.equal(c.code, 1);
  assert.match(c.out, /^::error::review-seal: check out the PR branch \(actions\/checkout with ref: the PR head branch\) or set commit: false/m);
});

test('action, commit "false": the ledger is restored, so the check judges the branch as it is', () => {
  for (const trackLedger of [true, false]) {
    const { root, git } = prRepo({ trackLedger });
    const before = git('status', '--porcelain');
    const rv = step(root, 'Review changed files', { BASE: 'main' });
    assert.equal(rv.code, 0);
    assert.notEqual(git('status', '--porcelain'), before);
    const restore = step(root, 'Restore the ledger');
    assert.equal(restore.code, 0, restore.err);
    assert.match(restore.out, /docs\/guide\.md \[consistency\] clean/);
    assert.equal(git('status', '--porcelain'), before);
    assert.equal(step(root, 'Check', { BASE: 'main' }).code, 1);
  }
});
