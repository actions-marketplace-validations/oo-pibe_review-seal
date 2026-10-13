import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEntry, validateEntry, loadLedger, saveLedger, LedgerError } from '../lib/ledger.js';

const base = { at: '2026-10-12', contentHash: 'sha256:aaaaaaaaaaaaaaaa', rubricHash: 'sha256:bbbbbbbbbbbbbbbb', verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent' };

test('a fresh entry validates', () => {
  assert.deepEqual(validateEntry('docs/a.md', 'consistency', makeEntry('docs/a.md', 'consistency', base)), []);
});

test('hand edits break the token', () => {
  const e = makeEntry('docs/a.md', 'consistency', { ...base, verdict: 'findings', findings: ['L3: contradicts L1'] });
  const forged = { ...e, verdict: 'clean', findings: [] };
  assert.match(validateEntry('docs/a.md', 'consistency', forged).join(), /token mismatch/);
  assert.match(validateEntry('docs/a.md', 'consistency', { ...e, reviewer: 'builder' }).join(), /token mismatch/);
});

test('rejects malformed entries', () => {
  const p = (over) => validateEntry('f', 'p', { ...makeEntry('f', 'p', base), ...over }).join(' | ');
  assert.match(p({ verdict: 'maybe' }), /verdict must be/);
  assert.match(p({ reviewer: 'someone' }), /reviewer must be/);
  assert.match(p({ via: 'email' }), /via must be/);
  assert.match(p({ contentHash: 'abc' }), /contentHash/);
  assert.match(p({ at: 'today' }), /date/);
  assert.match(validateEntry('f', 'p', makeEntry('f', 'p', { ...base, verdict: 'findings', findings: [' '] })).join(), /needs at least one finding/);
  assert.deepEqual(validateEntry('f', 'p', undefined), ['no p entry']);
});

test('save sorts keys and ends with a newline; load handles missing and broken files', () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-led-'));
  const cfg = { ledger: '.seal/ledger.json' };
  assert.deepEqual(loadLedger(root, cfg), {});
  saveLedger(root, cfg, { 'z.md': { b: 1, a: 2 }, 'a.md': { x: 3 } });
  const raw = readFileSync(join(root, '.seal/ledger.json'), 'utf8');
  assert.ok(raw.endsWith('}\n'));
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['a.md', 'z.md']);
  assert.deepEqual(Object.keys(JSON.parse(raw)['z.md']), ['a', 'b']);
  writeFileSync(join(root, '.seal/ledger.json'), '{oops');
  assert.throws(() => loadLedger(root, cfg), LedgerError);
});

test('backdating a builder entry breaks the token', () => {
  const e = makeEntry('f', 'p', { ...base, reviewer: 'builder' });
  assert.match(validateEntry('f', 'p', { ...e, at: '2020-01-01' }).join(), /token mismatch/);
});

test('at must be a real calendar date', () => {
  const e = makeEntry('f', 'p', { ...base, at: '2026-02-31' });
  assert.match(validateEntry('f', 'p', e).join(), /malformed date/);
});

test('non-list findings is reported, not thrown', () => {
  const e = { ...makeEntry('f', 'p', base), findings: 'oops' };
  assert.match(validateEntry('f', 'p', e).join(), /findings must be a list/);
  assert.doesNotMatch(validateEntry('f', 'p', e).join(), /token mismatch/);
});

test('loadLedger rejects wrong shapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-led-'));
  const cfg = { ledger: 'l.json' };
  for (const raw of ['null', '[]', '"x"', '{"a.md": null}', '{"a.md": []}', '{"a.md": 3}']) {
    writeFileSync(join(root, 'l.json'), raw);
    assert.throws(() => loadLedger(root, cfg), (e) => e instanceof LedgerError && /must map each file to its passes/.test(e.message), raw);
  }
});

test('saveLedger leaves no temp file behind', () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-led-'));
  saveLedger(root, { ledger: 'l.json' }, { 'a.md': { p: { x: 1 } } });
  assert.deepEqual(readdirSync(root), ['l.json']);
});

test('saveLedger does not use a fixed temp name', () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-led-'));
  mkdirSync(join(root, 'l.json.tmp'));
  saveLedger(root, { ledger: 'l.json' }, { 'a.md': { p: { x: 1 } } });
  assert.deepEqual(readdirSync(root).sort(), ['l.json', 'l.json.tmp']);
});
