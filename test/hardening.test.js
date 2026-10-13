import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { makeEntry } from '../lib/ledger.js';
import { parseConfig, ConfigError } from '../lib/config.js';
import { dueBody } from '../lib/due.js';
import { sealRepo, write, run, cleanEnv } from './helpers.js';

const H = (c) => `sha256:${c.repeat(16)}`;
const e = (file, at) => makeEntry(file, 'consistency', { at, contentHash: H('a'), rubricHash: H('b'), verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent' });
const tmp = (o) => { const p = join(mkdtempSync(join(tmpdir(), 'rs-hd-')), 'f.json'); writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o)); return p; };

test('merge-driver refuses a side that is JSON but not a ledger, and leaves it for git to report', () => {
  const { root } = sealRepo();
  const good = { 'docs/a.md': { consistency: e('docs/a.md', '2026-01-01') } };
  for (const bad of [{ 'docs/a.md': { consistency: { name: 'x' } } }, { 'package.json': { scripts: { test: 'x' } } }]) {
    const a = tmp(bad);
    const before = readFileSync(a, 'utf8');
    assert.equal(run(root, ['merge-driver', tmp(good), a, tmp(good)]).code, 1, JSON.stringify(bad));
    assert.equal(readFileSync(a, 'utf8'), before);
    assert.equal(run(root, ['merge-driver', tmp(good), tmp(good), tmp(bad)]).code, 1);
  }
  // An empty ledger and a file with no passes left are still ledgers.
  assert.equal(run(root, ['merge-driver', tmp({}), tmp({}), tmp({ 'docs/a.md': {} })]).code, 0);
});

test('install-hook does not set up the merge driver for a ledger path .gitattributes would read as a pattern', () => {
  for (const ledger of ['.seal/led[1].json', '.seal/l*.json', '.seal/l?.json']) {
    const { root, git } = sealRepo({ ledger });
    const r = run(root, ['install-hook']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Not setting up the ledger merge driver/);
    assert.ok(!existsSync(join(root, '.gitattributes')) || !readFileSync(join(root, '.gitattributes'), 'utf8').includes('merge=review-seal'));
    assert.throws(() => git('config', 'merge.review-seal.driver'));
  }
});

test('the merge driver falls back to node from PATH, not this machine\'s node path', () => {
  const { root, git } = sealRepo();
  run(root, ['install-hook']);
  const d = git('config', 'merge.review-seal.driver');
  assert.ok(!d.includes(process.execPath), d);
  assert.match(d, /else node '[^']*review-seal\.js' merge-driver %O %A %B; fi/);
});

test('a review is not taken over from a file outside a sparse checkout', () => {
  const { root, git } = sealRepo();
  write(root, 'docs/team/secret.md', 'Secret plan.\n');
  run(root, ['review', 'docs/guide.md', 'docs/team/secret.md']);
  git('add', '-A'); git('commit', '-qm', 'base');
  git('sparse-checkout', 'set', '--no-cone', '/*', '!/docs/team/');
  assert.ok(!existsSync(join(root, 'docs/team/secret.md')));
  write(root, 'docs/copy.md', 'Secret plan.\n');
  const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls');
  const r = run(root, ['review', 'docs/copy.md'], { env: { FAKE_CLAUDE_LOG: log } });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(log), 'the copy is reviewed, not taken over');
  assert.ok(JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'))['docs/team/secret.md'], 'the sparse file keeps its review');
});

test('a file moved with plain mv still takes its review over', () => {
  const { root } = sealRepo();
  run(root, ['review', 'docs/guide.md']);
  execFileSync('git', ['add', '-A'], { cwd: root, env: cleanEnv() });
  execFileSync('git', ['commit', '-qm', 'base', '--no-verify'], { cwd: root, env: cleanEnv() });
  execFileSync('mv', [join(root, 'docs/guide.md'), join(root, 'docs/moved.md')]);
  const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls');
  const r = run(root, ['review', 'docs/moved.md'], { env: { FAKE_CLAUDE_LOG: log } });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(log));
  assert.match(r.out, /the review of docs\/guide\.md, same text/);
});

test('dueBody caps each finding and keeps the whole body, fences included, under the limit', () => {
  const H16 = 'sha256:0123456789abcdef';
  const next = {};
  for (let i = 0; i < 40; i++) {
    const f = `docs/p${i}.md`;
    next[f] = { consistency: makeEntry(f, 'consistency', { at: '2026-10-01', contentHash: H16, rubricHash: H16, verdict: 'findings', findings: ['L1: ' + '~'.repeat(3000) + 'y'.repeat(2000)], reviewer: 'independent', via: 'agent' }) };
  }
  const body = dueBody({ baseLedger: '{}', newLedger: JSON.stringify(next), log: '~'.repeat(5000) + '\n' + ('x'.repeat(500) + '\n').repeat(200) });
  assert.ok(body.length <= 60000, String(body.length));
  for (const line of body.split('\n')) assert.ok(line.length <= 1100, String(line.length));
  // Every fence that opens is closed: the body ends outside any fence.
  const fences = body.split('\n').filter((l) => /^~{3,}$/.test(l));
  assert.equal(fences.length % 2, 0);
  assert.match(body, /log truncated; see the workflow run/);
});

test('config paths with control characters are refused', () => {
  const base = { passes: { c: { rubric: 'r.md', files: ['docs/**'] } } };
  assert.throws(() => parseConfig(JSON.stringify({ ...base, ledger: '.seal/l\u001b]0;x\u0007.json' })), ConfigError);
  assert.throws(() => parseConfig(JSON.stringify({ passes: { c: { rubric: 'r\u001b[31m.md', files: ['docs/**'] } } })), ConfigError);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, ledger: '.seal/l‮.json' })), ConfigError);
});

test('a submodule under a covered glob is not read as a file', () => {
  const sub = sealRepo();
  sub.git('add', '-A'); sub.git('commit', '-qm', 's', '--no-verify');
  const { root, git } = sealRepo({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**'] } } });
  run(root, ['review', 'docs/guide.md']);
  git('add', '-A'); git('commit', '-qm', 'base');
  git('-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub.root, 'docs/vendor');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 0, r.err);
  git('commit', '-qm', 'sub', '--no-verify');
  const c = run(root, ['check', '--changed-since', 'HEAD~1']);
  assert.equal(c.code, 0, c.err);
});

test('an unexpected error is printed as plain text', () => {
  const { root } = sealRepo();
  const name = 'docs/\u001b]0;pwned\u0007x.md';
  write(root, name, 'x\n');
  chmodSync(join(root, name), 0o000);
  const r = run(root, ['list'], { env: { GITHUB_ACTIONS: 'true' } });
  chmodSync(join(root, name), 0o644);
  assert.equal(r.code, 2);
  assert.match(r.err, /^review-seal: /);
  assert.doesNotMatch(r.err, /[\u001b\u0007]/);
});
