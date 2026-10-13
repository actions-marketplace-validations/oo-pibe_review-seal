import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeEntry } from '../lib/ledger.js';
import { contentHash } from '../lib/hash.js';
import { sealRepo, write, run } from './helpers.js';

const entry = (root, file, at, over = {}) => makeEntry(file, 'consistency', {
  at,
  contentHash: over.contentHash ?? contentHash(readFileSync(join(root, file), 'utf8')),
  rubricHash: over.rubricHash ?? contentHash(readFileSync(join(root, '.seal/rubrics/consistency.md'), 'utf8')),
  verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent',
});
const other = (led) => { const p = join(mkdtempSync(join(tmpdir(), 'rs-other-')), 'ledger.json'); writeFileSync(p, JSON.stringify(led)); return p; };
const ledger = (root) => JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'));

function repo() {
  const r = sealRepo();
  write(r.root, 'docs/two.md', 'Second file.\n');
  return r;
}

test('merge-ledger takes a newer matching review and keeps the rest', () => {
  const { root } = repo();
  const cur = entry(root, 'docs/guide.md', '2026-01-01');
  write(root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: cur } }));
  const newer = entry(root, 'docs/guide.md', '2026-06-01');
  const two = entry(root, 'docs/two.md', '2026-06-01');
  const r = run(root, ['merge-ledger', other({ 'docs/guide.md': { consistency: newer }, 'docs/two.md': { consistency: two } })]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(ledger(root), { 'docs/guide.md': { consistency: newer }, 'docs/two.md': { consistency: two } });
});

test('merge-ledger refuses stale, older, orphaned and invalid entries', () => {
  const { root } = repo();
  const cur = entry(root, 'docs/guide.md', '2026-06-01');
  write(root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: cur } }));
  const older = entry(root, 'docs/guide.md', '2026-01-01');
  const staleHash = entry(root, 'docs/two.md', '2026-07-01', { contentHash: 'sha256:0000000000000000' });
  const staleRubric = makeEntry('docs/two.md', 'consistency', { ...entry(root, 'docs/two.md', '2026-07-01'), rubricHash: 'sha256:0000000000000000' });
  write(root, 'gone.md', 'x\n');
  const orphan = makeEntry('docs/gone.md', 'consistency', { ...entry(root, 'gone.md', '2026-07-01') });
  const otherPass = makeEntry('docs/two.md', 'style', { ...entry(root, 'docs/two.md', '2026-07-01') });
  const forged = { ...entry(root, 'docs/two.md', '2026-07-01'), verdict: 'findings', findings: ['L1: x'] };
  for (const led of [
    { 'docs/guide.md': { consistency: older } },
    { 'docs/two.md': { consistency: staleHash } },
    { 'docs/two.md': { consistency: staleRubric } },
    { 'docs/gone.md': { consistency: orphan } },
    { 'docs/two.md': { style: otherPass } },
    { 'docs/two.md': { consistency: forged } },
  ]) {
    const r = run(root, ['merge-ledger', other(led)]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(ledger(root), { 'docs/guide.md': { consistency: cur } }, JSON.stringify(led));
  }
});

test('merge-ledger replaces a stale current entry with a matching one of the same day', () => {
  const { root } = repo();
  const cur = entry(root, 'docs/guide.md', '2026-06-01', { contentHash: 'sha256:0000000000000000' });
  write(root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: cur } }));
  const fresh = entry(root, 'docs/guide.md', '2026-06-01');
  assert.equal(run(root, ['merge-ledger', other({ 'docs/guide.md': { consistency: fresh } })]).code, 0);
  assert.deepEqual(ledger(root), { 'docs/guide.md': { consistency: fresh } });
});

test('merge-ledger: bad usage and a malformed file exit 2; it is not in the usage text', () => {
  const { root } = repo();
  assert.equal(run(root, ['merge-ledger']).code, 2);
  assert.equal(run(root, ['merge-ledger', 'nope.json']).code, 2);
  assert.equal(run(root, ['merge-ledger', '--force', other({})]).code, 2);
  assert.equal(run(root, ['merge-ledger', other([1])]).code, 2);
  assert.doesNotMatch(run(root, ['--help']).out, /merge-ledger/);
});
