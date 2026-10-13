import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, needsReview } from '../lib/evaluate.js';
import { makeEntry } from '../lib/ledger.js';
import { parseConfig } from '../lib/config.js';

const H1 = 'sha256:1111111111111111', H2 = 'sha256:2222222222222222', R1 = 'sha256:aaaaaaaaaaaaaaaa', R2 = 'sha256:bbbbbbbbbbbbbbbb';
const cfg = (over = {}) => parseConfig(JSON.stringify({ passes: { consistency: { rubric: 'r.md', files: ['docs/**'] } }, ...over }));
const seal = (over = {}) => ({ 'docs/a.md': { consistency: makeEntry('docs/a.md', 'consistency', { at: '2026-10-12', contentHash: H1, rubricHash: R1, verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent', ...over }) } });
const item = (over = {}) => ({ file: 'docs/a.md', contentHash: H1, rubricHashes: { consistency: R1 }, change: { substantive: true, why: 'changes the text' }, ...over });

test('fresh independent seal passes and is counted', () => {
  const r = evaluate([item()], seal(), cfg());
  assert.deepEqual(r.blocks, []);
  assert.deepEqual(r.counts, { independent: 1, builder: 0 });
});

test('never reviewed: blocks if substantive, warns if trivial', () => {
  assert.equal(evaluate([item()], {}, cfg()).blocks[0].reason, 'never-reviewed');
  const r = evaluate([item({ change: { substantive: false, why: 'tiny' } })], {}, cfg());
  assert.equal(r.blocks.length, 0);
  assert.equal(r.warnings[0].reason, 'never-reviewed');
});

test('edited after the review: stale', () => {
  assert.equal(evaluate([item({ contentHash: H2 })], seal(), cfg()).blocks[0].reason, 'stale');
});

test('checklist edited after the review: blocks', () => {
  assert.equal(evaluate([item({ rubricHashes: { consistency: R2 } })], seal(), cfg()).blocks[0].reason, 'rubric-changed');
});

test('tampered ledger: blocks', () => {
  const led = seal();
  led['docs/a.md'].consistency.verdict = 'findings';
  assert.equal(evaluate([item()], led, cfg()).blocks[0].reason, 'invalid');
});

test('builder seal: passes before independentFrom, blocks on or after', () => {
  const b = seal({ reviewer: 'builder', via: 'manual' });
  assert.equal(evaluate([item()], b, cfg({ independentFrom: '2026-10-13' })).blocks.length, 0);
  assert.equal(evaluate([item()], b, cfg({ independentFrom: '2026-10-12' })).blocks[0].reason, 'self-review');
  assert.deepEqual(evaluate([item()], b, cfg()).counts, { independent: 0, builder: 1 });
});

test('findings warn by default and block only when blockOnFindings is set', () => {
  const f = seal({ verdict: 'findings', findings: ['L1: wrong'] });
  const r = evaluate([item()], f, cfg());
  assert.equal(r.blocks.length, 0);
  assert.equal(r.warnings[0].reason, 'findings');
  assert.match(r.warnings[0].message, /open finding from the 2026-10-12 review: L1: wrong/);
  assert.equal(evaluate([item()], f, cfg({ blockOnFindings: true })).blocks[0].reason, 'findings');
});

test('needsReview mirrors the same rules', () => {
  const h = { contentHash: H1, rubricHash: R1 };
  assert.equal(needsReview('docs/a.md', 'consistency', seal(), h, cfg()), false);
  assert.equal(needsReview('docs/a.md', 'consistency', {}, h, cfg()), true);
  assert.equal(needsReview('docs/a.md', 'consistency', seal(), { ...h, contentHash: H2 }, cfg()), true);
  assert.equal(needsReview('docs/a.md', 'consistency', seal(), { ...h, rubricHash: R2 }, cfg()), true);
  assert.equal(needsReview('docs/a.md', 'consistency', seal({ reviewer: 'builder', via: 'manual' }), h, cfg({ independentFrom: '2026-01-01' })), true);
});
