import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, write } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { loadLedger, validateEntry } from '../lib/ledger.js';
import { reviewFiles, pendingJobs, drainInbox, STATE_DIR } from '../lib/review.js';

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
