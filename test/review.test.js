import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, write } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { loadLedger, validateEntry } from '../lib/ledger.js';
import { reviewFiles, pendingJobs, drainInbox, appendInbox, STATE_DIR } from '../lib/review.js';

const fake = (verdict = 'clean', findings = []) => async (job) => ({ ok: true, verdict: { file: job.file, pass: job.pass, contentHash: job.contentHash, rubricHash: job.rubricHash, verdict, findings } });

test('writes an independent agent seal and never reviews the same version twice', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  let calls = 0;
  const run = async (job) => { calls++; return fake()(job); };
  const r = await reviewFiles(root, cfg, ['docs/guide.md'], { run });
  assert.equal(r.reviewed.length, 1);
  const e = loadLedger(root, cfg)['docs/guide.md'].consistency;
  assert.equal(e.reviewer, 'independent');
  assert.equal(e.via, 'agent');
  assert.deepEqual(validateEntry('docs/guide.md', 'consistency', e), []);
  await reviewFiles(root, cfg, ['docs/guide.md'], { run });
  assert.equal(calls, 1);
  write(root, 'docs/guide.md', 'changed\n');
  await reviewFiles(root, cfg, ['docs/guide.md'], { run });
  assert.equal(calls, 2);
});

test('refuses a verdict for a different version', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  const run = async (job) => ({ ok: true, verdict: { ...job, contentHash: 'sha256:0000000000000000', verdict: 'clean', findings: [] } });
  const r = await reviewFiles(root, cfg, ['docs/guide.md'], { run });
  assert.match(r.failed[0].error, /different version/);
  assert.deepEqual(loadLedger(root, cfg), {});
});

test('refuses when the file changed during the review', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  const run = async (job) => { write(root, 'docs/guide.md', 'edited mid-review\n'); return fake()(job); };
  const r = await reviewFiles(root, cfg, ['docs/guide.md'], { run });
  assert.match(r.failed[0].error, /changed during review/);
});

test('caps files per run', async () => {
  const { root } = sealRepo({ maxFilesPerRun: 2 });
  for (const n of ['a', 'b', 'c']) write(root, `docs/${n}.md`, n);
  const cfg = loadConfig(root);
  const r = await reviewFiles(root, cfg, ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/guide.md'], { run: fake() });
  assert.equal(r.reviewed.length, 2);
  assert.equal(r.remaining, 2);
});

test('a held lock skips the run', async () => {
  const { root } = sealRepo();
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  writeFileSync(join(root, STATE_DIR, 'review.lock'), '1');
  const r = await reviewFiles(root, loadConfig(root), ['docs/guide.md'], { run: fake() });
  assert.equal(r.skipped, 'locked');
});

test('findings and failures go to the inbox; draining empties it', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  await reviewFiles(root, cfg, ['docs/guide.md'], { run: fake('findings', ['L1: wrong']) });
  write(root, 'docs/other.md', 'x');
  await reviewFiles(root, cfg, ['docs/other.md'], { run: async () => ({ ok: false, error: 'boom' }) });
  const inbox = drainInbox(root);
  assert.deepEqual(inbox.map((i) => i.file), ['docs/guide.md', 'docs/other.md']);
  assert.deepEqual(inbox[0].findings, ['L1: wrong']);
  assert.equal(inbox[1].error, 'boom');
  assert.deepEqual(drainInbox(root), []);
});

test('pendingJobs ignores uncovered and missing files', () => {
  const { root } = sealRepo();
  assert.deepEqual(pendingJobs(root, loadConfig(root), ['src/app.js', 'docs/missing.md', 'docs/guide.md']).map((j) => j.file), ['docs/guide.md']);
});

const lockPath = (root) => join(root, STATE_DIR, 'review.lock');
const putLock = (root, content) => { mkdirSync(join(root, STATE_DIR), { recursive: true }); writeFileSync(lockPath(root), content); };

test('a lock held by a live pid skips the run', async () => {
  const { root } = sealRepo();
  putLock(root, JSON.stringify({ pid: process.pid, nonce: 'x' }));
  const r = await reviewFiles(root, loadConfig(root), ['docs/guide.md'], { run: fake() });
  assert.equal(r.skipped, 'locked');
  assert.equal(r.remaining, null);
});

test('a lock from a dead pid is taken over', async () => {
  const { root } = sealRepo();
  putLock(root, JSON.stringify({ pid: 999999, nonce: 'x' }));
  const r = await reviewFiles(root, loadConfig(root), ['docs/guide.md'], { run: fake() });
  assert.equal(r.reviewed.length, 1);
  assert.equal(existsSync(lockPath(root)), false);
});

test('a live-pid lock older than the stale window is taken over', async () => {
  const { root } = sealRepo();
  putLock(root, JSON.stringify({ pid: process.pid, nonce: 'x' }));
  const old = new Date(Date.now() - 3600_000);
  utimesSync(lockPath(root), old, old);
  const r = await reviewFiles(root, loadConfig(root), ['docs/guide.md'], { run: fake() });
  assert.equal(r.reviewed.length, 1);
});

test('a run never removes a lock that is not its own', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  const other = JSON.stringify({ pid: process.pid, nonce: 'other' });
  const run = async (job) => { writeFileSync(lockPath(root), other); return fake()(job); };
  await reviewFiles(root, cfg, ['docs/guide.md'], { run });
  assert.equal(readFileSync(lockPath(root), 'utf8'), other);
});

test('the lock is touched before each job', async () => {
  const { root } = sealRepo();
  write(root, 'docs/b.md', 'b');
  const cfg = loadConfig(root);
  const ages = [];
  const run = async (job) => {
    ages.push(Date.now() - statSync(lockPath(root)).mtimeMs);
    const old = new Date(Date.now() - 600_000);
    utimesSync(lockPath(root), old, old);
    return fake()(job);
  };
  await reviewFiles(root, cfg, ['docs/guide.md', 'docs/b.md'], { run });
  assert.equal(ages.length, 2);
  assert.ok(ages[1] < 5000, `second job saw lock age ${ages[1]}`);
});

test('one job throwing does not lose the others; both outcomes reach the inbox', async () => {
  const { root } = sealRepo();
  write(root, 'docs/b.md', 'b');
  const cfg = loadConfig(root);
  let n = 0;
  const run = async (job) => { if (++n === 2) throw new Error('kaput'); return fake()(job); };
  const r = await reviewFiles(root, cfg, ['docs/guide.md', 'docs/b.md'], { run });
  assert.equal(r.reviewed.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(Object.keys(loadLedger(root, cfg)).length, 1);
  const inbox = drainInbox(root);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].error, 'kaput');
});

test('a file deleted during review is a failure, not a throw', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  const run = async (job) => { unlinkSync(join(root, 'docs/guide.md')); return fake()(job); };
  const r = await reviewFiles(root, cfg, ['docs/guide.md'], { run });
  assert.match(r.failed[0].error, /removed during review/);
  assert.match(drainInbox(root)[0].error, /removed during review/);
});

test('remaining counts distinct files', async () => {
  const { root } = sealRepo({ maxFilesPerRun: 1 });
  write(root, 'docs/b.md', 'b');
  const r = await reviewFiles(root, loadConfig(root), ['docs/guide.md', 'docs/b.md'], { run: fake() });
  assert.equal(r.remaining, 1);
});

test('items appended after a drain are not lost; a torn last line is skipped', () => {
  const { root } = sealRepo();
  appendInbox(root, [{ file: 'a' }, { file: 'b' }]);
  const p = join(root, STATE_DIR, 'inbox.jsonl');
  writeFileSync(p, readFileSync(p, 'utf8') + '{"file":"to');
  assert.deepEqual(drainInbox(root).map((i) => i.file), ['a', 'b']);
  appendInbox(root, [{ file: 'c' }]);
  assert.deepEqual(drainInbox(root).map((i) => i.file), ['c']);
  assert.deepEqual(drainInbox(root), []);
  assert.deepEqual(readdirSync(join(root, STATE_DIR)).filter((f) => f.startsWith('inbox')), []);
});

test('state dir ignores itself', async () => {
  const { root } = sealRepo();
  await reviewFiles(root, loadConfig(root), ['docs/guide.md'], { run: fake() });
  assert.equal(readFileSync(join(root, STATE_DIR, '.gitignore'), 'utf8'), '*\n');
});

test('a run that lost its lock stops after the current job', async () => {
  const { root } = sealRepo();
  write(root, 'docs/b.md', 'b');
  const cfg = loadConfig(root);
  let calls = 0;
  const run = async (job) => {
    calls++;
    writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, nonce: 'someone-else' }));
    return fake()(job);
  };
  const r = await reviewFiles(root, cfg, ['docs/guide.md', 'docs/b.md'], { run });
  assert.equal(calls, 1);
  assert.equal(r.reviewed.length, 1);
});

test('drain also collects old orphaned drain files, not fresh ones', () => {
  const { root } = sealRepo();
  appendInbox(root, [{ file: 'live' }]);
  const dir = join(root, STATE_DIR);
  writeFileSync(join(dir, 'inbox.jsonl.123.old'), '{"file":"orphan"}\n');
  writeFileSync(join(dir, 'inbox.jsonl.124.fresh'), '{"file":"busy"}\n');
  const old = new Date(Date.now() - 120_000);
  utimesSync(join(dir, 'inbox.jsonl.123.old'), old, old);
  assert.deepEqual(drainInbox(root).map((i) => i.file).sort(), ['live', 'orphan']);
  assert.equal(existsSync(join(dir, 'inbox.jsonl.123.old')), false);
  assert.equal(existsSync(join(dir, 'inbox.jsonl.124.fresh')), true);
});

const failuresPath = (root) => join(root, STATE_DIR, 'failures.json');
const ageFailures = (root, minutes, failures) => {
  const f = JSON.parse(readFileSync(failuresPath(root), 'utf8'));
  for (const v of Object.values(f)) { v.lastAt = new Date(Date.now() - minutes * 60_000).toISOString(); if (failures) v.failures = failures; }
  writeFileSync(failuresPath(root), JSON.stringify(f));
};

test('backoff: a failed review waits 10 minutes, stops after 3 failures, and starts over when the file changes', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  let calls = 0;
  const failing = async () => { calls++; return { ok: false, error: 'boom' }; };
  const opts = { run: failing, backoff: true };
  await reviewFiles(root, cfg, ['docs/guide.md'], opts);
  const f = JSON.parse(readFileSync(failuresPath(root), 'utf8'));
  const [key] = Object.keys(f);
  assert.match(key, /^docs\/guide\.md\|consistency\|sha256:/);
  assert.equal(f[key].failures, 1);
  await reviewFiles(root, cfg, ['docs/guide.md'], opts);
  assert.equal(calls, 1);
  ageFailures(root, 11);
  await reviewFiles(root, cfg, ['docs/guide.md'], opts);
  assert.equal(calls, 2);
  ageFailures(root, 60, 3);
  await reviewFiles(root, cfg, ['docs/guide.md'], opts);
  assert.equal(calls, 2);
  write(root, 'docs/guide.md', 'changed\n');
  await reviewFiles(root, cfg, ['docs/guide.md'], opts);
  assert.equal(calls, 3);
});

test('backoff: a success clears the record; an explicit review (no backoff) always runs', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  let calls = 0;
  const failing = async () => { calls++; return { ok: false, error: 'boom' }; };
  await reviewFiles(root, cfg, ['docs/guide.md'], { run: failing, backoff: true });
  await reviewFiles(root, cfg, ['docs/guide.md'], { run: failing });
  assert.equal(calls, 2);
  await reviewFiles(root, cfg, ['docs/guide.md'], { run: fake() });
  assert.deepEqual(JSON.parse(readFileSync(failuresPath(root), 'utf8')), {});
});

test('inbox: items carry their session; a drain takes its own, untagged and day-old items and leaves the rest', async () => {
  const { root } = sealRepo();
  await reviewFiles(root, loadConfig(root), ['docs/guide.md'], { run: async () => ({ ok: false, error: 'boom' }), session: 'A' });
  const day = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  appendInbox(root, [{ file: 'untagged' }, { file: 'old-B', session: 'B', at: day }, { file: 'fresh-B', session: 'B', at: new Date().toISOString() }]);
  const a = drainInbox(root, 'A');
  assert.deepEqual(a.map((i) => i.file).sort(), ['docs/guide.md', 'old-B', 'untagged']);
  assert.equal(a.find((i) => i.file === 'docs/guide.md').session, 'A');
  assert.deepEqual(drainInbox(root, 'A'), []);
  assert.deepEqual(drainInbox(root, 'B').map((i) => i.file), ['fresh-B']);
});

test('lockWait: a run waits for a held lock and goes ahead once it is released', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  putLock(root, JSON.stringify({ pid: process.pid, nonce: 'other' }));
  setTimeout(() => unlinkSync(lockPath(root)), 300);
  const t0 = Date.now();
  const r = await reviewFiles(root, cfg, ['docs/guide.md'], { run: fake(), lockWait: { ms: 5000, pollMs: 100 } });
  assert.equal(r.skipped, undefined);
  assert.equal(r.reviewed.length, 1);
  assert.ok(Date.now() - t0 >= 250);
});

test('lockWait: still locked at the deadline, the session is told in its inbox what to run', async () => {
  const { root } = sealRepo();
  const cfg = loadConfig(root);
  putLock(root, JSON.stringify({ pid: process.pid, nonce: 'other' }));
  const r = await reviewFiles(root, cfg, ['docs/guide.md'], { run: fake(), lockWait: { ms: 300, pollMs: 100 }, session: 'B' });
  assert.equal(r.skipped, 'locked');
  const items = drainInbox(root, 'B');
  assert.equal(items.length, 1);
  assert.equal(items[0].file, 'docs/guide.md');
  assert.equal(items[0].session, 'B');
  assert.equal(items[0].error, 'review skipped because another review was still running; run review-seal review docs/guide.md');
});
