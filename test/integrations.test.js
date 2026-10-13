import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, realpathSync, rmSync } from 'node:fs';
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
  // A stand-in for gh with a pull request state that "pr create" sets; a "create-fails" file makes the next create fail.
  if (prState) writeFileSync(join(bin, 'state'), prState + '\n');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
if [ "$1 $2" = "pr view" ]; then [ -s "${bin}/state" ] && { cat "${bin}/state"; exit 0; }; echo "no pull requests found" >&2; exit 1; fi
for a in "$@"; do if [ "$prev" = "--body-file" ]; then cp "$a" "${calls}.body"; fi; prev="$a"; done
if [ "$1 $2" = "pr create" ]; then
  if [ -f "${bin}/create-fails" ]; then rm -f "${bin}/create-fails"; echo "HTTP 502" >&2; exit 1; fi
  echo OPEN > "${bin}/state"
fi
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' };
  return { ...r, remote, calls, env, bin };
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

const AUTH_KEY = 'http.https://github.com/.extraheader';
const AUTH = 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0';
const reviewerCalls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.args) : []);

test('action: checkout credentials are out of git config while the reviewer runs, and back afterwards', () => {
  for (const mode of ['clean', 'fail']) {
    const { root, git } = prRepo();
    git('config', '--local', AUTH_KEY, AUTH);
    const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls.jsonl');
    assert.equal(step(root, 'Review changed files', { BASE: 'main', FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: mode }).code, 0);
    const calls = reviewerCalls(log);
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((c) => c.gitAuth === false), mode);
    assert.equal(git('config', '--local', '--get-all', AUTH_KEY).trim(), AUTH);
  }
  const { root, git, env } = dueRepo();
  git('config', '--local', AUTH_KEY, AUTH);
  const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls.jsonl');
  assert.equal(step(root, 'Re-review what is due', { ...env, FAKE_CLAUDE_LOG: log }).code, 0);
  const calls = reviewerCalls(log);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].gitAuth, false);
  assert.equal(git('config', '--local', '--get-all', AUTH_KEY).trim(), AUTH);
});

// Puts a commit by `email` on origin's review-seal/scheduled, on top of main, from another clone.
function pushScheduled(r, email) {
  const other = join(mkdtempSync(join(tmpdir(), 'review-seal-clone-')), 'c');
  const g = (...a) => execFileSync('git', a, { cwd: other, encoding: 'utf8', stdio: 'pipe', env: cleanEnv() });
  execFileSync('git', ['clone', '-q', '-b', 'main', r.remote, other], { env: cleanEnv() });
  write(other, 'docs/note.md', 'A note.\n');
  g('add', '-A');
  g('-c', 'user.name=someone', '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'note');
  g('push', '-qf', 'origin', 'HEAD:refs/heads/review-seal/scheduled');
  return g('rev-parse', 'HEAD');
}
const remoteTip = (r) => execFileSync('git', ['--git-dir', r.remote, 'rev-parse', 'review-seal/scheduled'], { encoding: 'utf8', env: cleanEnv() }).trim();
const BOT = '41898282+github-actions[bot]@users.noreply.github.com';

test('action, mode "due": a scheduled branch with commits from people is left alone', () => {
  const r = dueRepo();
  const before = pushScheduled(r, 'person@example.com');
  const d = step(r.root, 'Re-review what is due', r.env);
  assert.equal(d.code, 0);
  assert.match(d.out, /^::warning::review-seal: review-seal\/scheduled has commits from people; not overwriting/m);
  const o = step(r.root, 'Open or update the pull request', r.env);
  assert.equal(o.code, 0, o.err);
  assert.equal(execFileSync('git', ['--git-dir', r.remote, 'rev-parse', 'review-seal/scheduled'], { encoding: 'utf8', env: cleanEnv() }), before);
  assert.ok(!existsSync(r.calls));
});

test('action, mode "due": reviews already on the scheduled branch are reused, not paid for twice', () => {
  const r = dueRepo();
  assert.equal(step(r.root, 'Re-review what is due', r.env).code, 0);
  assert.equal(step(r.root, 'Open or update the pull request', r.env).code, 0);
  r.git('checkout', '-q', 'main');
  const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls.jsonl');
  const d = step(r.root, 'Re-review what is due', { ...r.env, FAKE_CLAUDE_LOG: log });
  assert.equal(d.code, 0, d.err);
  assert.deepEqual(reviewerCalls(log), []);
  assert.equal(run(r.root, ['check']).code, 0);
  const tip = remoteTip(r);
  const ghCalls = readFileSync(r.calls, 'utf8');
  const o = step(r.root, 'Open or update the pull request', r.env);
  assert.equal(o.code, 0, o.err);
  assert.match(o.out, /already has these reviews/);
  assert.equal(remoteTip(r), tip, 'no new commit when nothing new was reviewed');
  assert.equal(readFileSync(r.calls, 'utf8').slice(ghCalls.length).trim(), 'pr view review-seal/scheduled --json state -q .state', 'the open pull request is left as it is');
});

test('action, mode "due": a merged scheduled branch left behind does not roll back newer reviews on main', () => {
  const r = dueRepo();
  assert.equal(step(r.root, 'Re-review what is due', r.env).code, 0);
  assert.equal(step(r.root, 'Open or update the pull request', r.env).code, 0);
  r.git('checkout', '-q', 'main');
  r.git('merge', '-q', '--ff-only', 'review-seal/scheduled');
  write(r.root, 'docs/guide.md', 'A newer claim.\n');
  assert.equal(run(r.root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'findings' } }).code, 0);
  r.git('add', '-A'); r.git('commit', '-qm', 'newer'); r.git('push', '-q', 'origin', 'main');
  const ledgerOnMain = r.git('show', 'HEAD:.seal/ledger.json');
  const tip = remoteTip(r);
  const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls.jsonl');
  assert.equal(step(r.root, 'Re-review what is due', { ...r.env, FAKE_CLAUDE_LOG: log }).code, 0);
  assert.deepEqual(reviewerCalls(log), []);
  assert.equal(readFileSync(join(r.root, '.seal/ledger.json'), 'utf8'), ledgerOnMain);
  const o = step(r.root, 'Open or update the pull request', r.env);
  assert.equal(o.code, 0, o.err);
  assert.match(o.out, /nothing was due/);
  assert.equal(remoteTip(r), tip);
});

test('action, mode "due": a push to the scheduled branch during the run is not overwritten', () => {
  const r = dueRepo();
  assert.equal(step(r.root, 'Re-review what is due', r.env).code, 0);
  pushScheduled(r, BOT);
  const o = step(r.root, 'Open or update the pull request', r.env);
  assert.notEqual(o.code, 0);
  assert.match(o.err, /stale info|rejected/);
  assert.ok(!existsSync(r.calls));
});

test('action, mode "due": failed reviews fail the run, after the pull request for the rest', () => {
  const r = dueRepo();
  assert.equal(step(r.root, 'Re-review what is due', { ...r.env, FAKE_CLAUDE_MODE: 'fail' }).code, 0);
  const o = step(r.root, 'Open or update the pull request', r.env);
  assert.equal(o.code, 1);
  assert.match(o.out, /^::error::review-seal: some reviews failed; see the log/m);
  assert.doesNotMatch(o.out, /nothing was due/);

  const r2 = dueRepo();
  assert.equal(step(r2.root, 'Re-review what is due', r2.env).code, 0);
  writeFileSync(join(runnerTemp.get(r2.root), 'review-seal-due.status'), '1\n');
  const o2 = step(r2.root, 'Open or update the pull request', r2.env);
  assert.equal(o2.code, 1);
  assert.match(o2.out, /^::error::review-seal: some reviews failed; see the log/m);
  assert.match(readFileSync(r2.calls, 'utf8'), /^pr create /m);
});

test('action, mode "due": the PR body is fenced safely and kept under GitHub\'s limit', () => {
  const r = dueRepo();
  assert.equal(step(r.root, 'Re-review what is due', r.env).code, 0);
  writeFileSync(join(runnerTemp.get(r.root), 'review-seal-due.log'), 'L1: ~~~~~ breaks out\n' + 'x'.repeat(70000));
  assert.equal(step(r.root, 'Open or update the pull request', r.env).code, 0);
  const body = readFileSync(r.calls + '.body', 'utf8');
  assert.ok(body.length < 61000, String(body.length));
  assert.match(body, /\n~~~~~~\nL1: ~~~~~ breaks out/);
  assert.match(body, /x\n~~~~~~\n/);
  assert.match(body, /log truncated; see the workflow run/);
});

test('action: the mode input says which permissions due mode needs', () => {
  const y = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const desc = y.split('\n  mode:\n')[1].split('\n  github-token:')[0];
  assert.match(desc, /contents: write/);
  assert.match(desc, /pull-requests: write/);
  assert.match(desc, /Allow GitHub Actions to create and approve pull requests/);
});

// A fresh fetch-depth 1 checkout of dueRepo's remote, as actions/checkout makes on every run by default.
function shallowClone(r) {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'review-seal-shallow-'))), 'c');
  execFileSync('git', ['clone', '-q', '--depth', '1', '-b', 'main', `file://${r.remote}`, root], { env: cleanEnv() });
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe', env: cleanEnv() });
  git('config', 'commit.gpgsign', 'false');
  assert.equal(git('rev-parse', '--is-shallow-repository').trim(), 'true');
  return { ...r, root, git };
}
// A person's commit on main, so the scheduled branch's base falls out of the next shallow checkout.
function advanceMain(r) {
  write(r.root, 'notes.txt', `more ${Math.random()}\n`); r.git('add', 'notes.txt'); r.git('commit', '-qm', 'more'); r.git('push', '-q', 'origin', 'main');
}

test('action, mode "due": works in shallow checkouts, run after run', () => {
  const r = dueRepo();
  advanceMain(r);
  const a = shallowClone(r);
  assert.equal(step(a.root, 'Re-review what is due', a.env).code, 0);
  const o1 = step(a.root, 'Open or update the pull request', a.env);
  assert.equal(o1.code, 0, o1.err);
  advanceMain(r);
  const b = shallowClone(r);
  const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls.jsonl');
  const d2 = step(b.root, 'Re-review what is due', { ...b.env, FAKE_CLAUDE_LOG: log });
  assert.equal(d2.code, 0, d2.err);
  assert.doesNotMatch(d2.out, /::warning::/);
  assert.deepEqual(reviewerCalls(log), []);
  assert.equal(step(b.root, 'Open or update the pull request', b.env).code, 0);
  pushScheduled(r, 'person@example.com');
  const c = shallowClone(r);
  const d3 = step(c.root, 'Re-review what is due', c.env);
  assert.equal(d3.code, 0);
  assert.match(d3.out, /^::warning::review-seal: review-seal\/scheduled has commits from people; not overwriting\. Merge or close the pull request and delete the branch to resume\./m);
});

test('action, mode "due": a merge at the tip of the scheduled branch is left alone', () => {
  const r = dueRepo();
  const other = join(mkdtempSync(join(tmpdir(), 'review-seal-clone-')), 'c');
  const g = (...a) => execFileSync('git', a, { cwd: other, encoding: 'utf8', stdio: 'pipe', env: cleanEnv() });
  execFileSync('git', ['clone', '-q', '-b', 'main', r.remote, other], { env: cleanEnv() });
  for (const [k, v] of [['user.name', 'bot'], ['user.email', BOT], ['commit.gpgsign', 'false']]) g('config', k, v);
  g('checkout', '-qb', 'side'); write(other, 'docs/side.md', 'Side.\n'); g('add', '-A'); g('commit', '-qm', 'side');
  g('checkout', '-q', 'main'); write(other, 'docs/main.md', 'Main.\n'); g('add', '-A'); g('commit', '-qm', 'main');
  g('merge', '-q', '--no-ff', '-m', 'merge', 'side');
  g('push', '-qf', 'origin', 'HEAD:refs/heads/review-seal/scheduled');
  const d = step(r.root, 'Re-review what is due', r.env);
  assert.equal(d.code, 0);
  assert.match(d.out, /^::warning::review-seal: review-seal\/scheduled has commits from people/m);
});

test('action, mode "due": a pull request that failed to open is opened on the next run', () => {
  const r = dueRepo();
  writeFileSync(join(r.bin, 'create-fails'), '');
  assert.equal(step(r.root, 'Re-review what is due', r.env).code, 0);
  assert.notEqual(step(r.root, 'Open or update the pull request', r.env).code, 0);
  const tip = remoteTip(r);
  r.git('checkout', '-q', 'main');
  writeFileSync(r.calls, '');
  assert.equal(step(r.root, 'Re-review what is due', r.env).code, 0);
  const o = step(r.root, 'Open or update the pull request', r.env);
  assert.equal(o.code, 0, o.err);
  assert.match(o.out, /already has these reviews/);
  assert.equal(remoteTip(r), tip);
  assert.match(readFileSync(r.calls, 'utf8'), /^pr create --head review-seal\/scheduled --base main --title review-seal: scheduled re-review --body-file /m);
  assert.match(readFileSync(r.calls + '.body', 'utf8'), /^The reviews on this branch were recorded by an earlier scheduled run/);
});

test('action, mode "due": a closed or merged scheduled pull request is not reopened', () => {
  for (const state of ['CLOSED', 'MERGED']) {
    for (const second of [false, true]) {
      const r = dueRepo({ prState: state });
      if (second) {
        // The branch already carries these reviews, so this is the "already has these reviews" path.
        rmSync(join(r.bin, 'state')); writeFileSync(join(r.bin, 'create-fails'), '');
        assert.equal(step(r.root, 'Re-review what is due', r.env).code, 0);
        step(r.root, 'Open or update the pull request', r.env);
        writeFileSync(join(r.bin, 'state'), state + '\n');
        r.git('checkout', '-q', 'main');
      }
      writeFileSync(r.calls, '');
      assert.equal(step(r.root, 'Re-review what is due', r.env).code, 0);
      const o = step(r.root, 'Open or update the pull request', r.env);
      assert.equal(o.code, 0, o.err);
      assert.match(o.out, /^::warning::review-seal: the scheduled pull request was closed; delete the review-seal\/scheduled branch to resume/m, `${state} ${second}`);
      assert.doesNotMatch(readFileSync(r.calls, 'utf8'), /^pr (create|edit|reopen)/m, `${state} ${second}`);
    }
  }
});
