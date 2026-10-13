import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { sealRepo, write, run, cleanEnv, FAKE_CLAUDE } from './helpers.js';
import { makeEntry } from '../lib/ledger.js';
import { contentHash } from '../lib/hash.js';

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
function step(root, name, env = {}, cwd = root) {
  if (!runnerTemp.has(root)) runnerTemp.set(root, mkdtempSync(join(tmpdir(), 'review-seal-runner-')));
  // Composite bash steps run as: bash --noprofile --norc -eo pipefail {0}
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepScript(name)], {
    cwd, encoding: 'utf8',
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
  const ok = { MODE: 'pr', BASE: 'main', ANTHROPIC_API_KEY: 'k' };
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

test('action steps run from the repo root, even when the workspace is a subdirectory', () => {
  const { root, git } = prRepo();
  const remote = mkdtempSync(join(tmpdir(), 'review-seal-remote-'));
  execFileSync('git', ['init', '-q', '--bare', remote], { env: cleanEnv() });
  git('remote', 'add', 'origin', remote); git('push', '-qu', 'origin', 'pr');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD~1');
  const sub = join(root, 'src');
  assert.equal(step(root, 'Review changed files', { BASE: 'main' }, sub).code, 0);
  const c = step(root, 'Commit the ledger', {}, sub);
  assert.equal(c.code, 0, c.err);
  assert.match(git('show', '--name-only', '--format=%s', 'HEAD'), /^review-seal: record independent reviews\n[\s\S]*\.seal\/ledger\.json/);
  assert.equal(step(root, 'Check', { BASE: 'main' }, sub).code, 0);
});

test('action, mode "due": validation needs only the key, and a bad mode is refused', () => {
  const { root } = sealRepo();
  assert.equal(step(root, 'Validate inputs', { MODE: 'due', BASE: '', ANTHROPIC_API_KEY: 'k' }).code, 0);
  const noKey = step(root, 'Validate inputs', { MODE: 'due', BASE: '', ANTHROPIC_API_KEY: '' });
  assert.equal(noKey.code, 1);
  assert.match(noKey.out, /^::error::review-seal: anthropic-api-key is empty/m);
  const bad = step(root, 'Validate inputs', { MODE: 'nightly', BASE: 'main', ANTHROPIC_API_KEY: 'k' });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /^::error::review-seal: mode must be "pr" or "due"/m);
});

test('action: pull-request steps run only in "pr" mode, due steps only in "due" mode', () => {
  const y = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const cond = (name) => (y.split(`- name: ${name}\n`)[1] || '').match(/^\s+if: (.*)$/m)?.[1];
  for (const n of ['Review changed files', 'Commit the ledger', 'Restore the ledger', 'Check']) assert.match(cond(n), /^inputs\.mode == 'pr'( && |$)/, n);
  for (const n of ['Re-review what is due', 'Open or update the pull request']) assert.equal(cond(n), "inputs.mode == 'due'", n);
});

// A repository on main whose one review is past its shelf life, with a bare origin and a stub gh that logs its calls.
function dueRepo({ expired = true, prState = '' } = {}) {
  const r = sealRepo({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'], maxAgeDays: 30 } } });
  const text = readFileSync(join(r.root, 'docs/guide.md'), 'utf8');
  const rubric = readFileSync(join(r.root, '.seal/rubrics/consistency.md'), 'utf8');
  const at = expired ? '2020-01-01' : new Date().toISOString().slice(0, 10);
  const e = makeEntry('docs/guide.md', 'consistency', { at, contentHash: contentHash(text), rubricHash: contentHash(rubric), verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent' });
  write(r.root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: e } }) + '\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'base');
  const remote = mkdtempSync(join(tmpdir(), 'review-seal-remote-'));
  execFileSync('git', ['init', '-q', '--bare', remote], { env: cleanEnv() });
  r.git('remote', 'add', 'origin', remote); r.git('push', '-qu', 'origin', 'main');
  const bin = mkdtempSync(join(tmpdir(), 'review-seal-gh-'));
  const calls = join(bin, 'calls');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
if [ "$1 $2" = "pr view" ]; then [ -n "${prState}" ] && { echo "${prState}"; exit 0; }; echo "no pull requests found" >&2; exit 1; fi
for a in "$@"; do if [ "$prev" = "--body-file" ]; then cp "$a" "${calls}.body"; fi; prev="$a"; done
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' };
  return { ...r, remote, calls, env };
}

test('action, mode "due": expired reviews are renewed on a branch and a pull request is opened', () => {
  const { root, git, remote, calls, env } = dueRepo();
  assert.equal(step(root, 'Re-review what is due', env).code, 0);
  const o = step(root, 'Open or update the pull request', env);
  assert.equal(o.code, 0, o.err);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'review-seal/scheduled');
  assert.match(git('show', '--name-only', '--format=%s', 'HEAD'), /^review-seal: scheduled re-review\n[\s\S]*\.seal\/ledger\.json/);
  assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'review-seal/scheduled'], { encoding: 'utf8', env: cleanEnv() }), git('rev-parse', 'HEAD'));
  const log = readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(log.length, 2);
  assert.match(log[0], /^pr view review-seal\/scheduled/);
  assert.match(log[1], /^pr create --head review-seal\/scheduled --base main --title review-seal: scheduled re-review --body-file /);
  assert.match(readFileSync(calls + '.body', 'utf8'), /docs\/guide\.md \[consistency\] clean/);
  assert.equal(run(root, ['check']).code, 0);
});

test('action, mode "due": an open scheduled pull request is updated, not duplicated', () => {
  const { root, calls, env } = dueRepo({ prState: 'OPEN' });
  assert.equal(step(root, 'Re-review what is due', env).code, 0);
  assert.equal(step(root, 'Open or update the pull request', env).code, 0);
  const log = readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(log.length, 2);
  assert.match(log[1], /^pr edit review-seal\/scheduled --body-file /);
});

test('action, mode "due": nothing due means no branch and no pull request', () => {
  const { root, git, calls, env } = dueRepo({ expired: false });
  assert.equal(step(root, 'Re-review what is due', env).code, 0);
  const o = step(root, 'Open or update the pull request', env);
  assert.equal(o.code, 0, o.err);
  assert.match(o.out, /nothing was due/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.ok(!existsSync(calls));
});
