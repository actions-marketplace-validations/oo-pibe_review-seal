import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sealRepo, run, write } from './helpers.js';
import { makeEntry, validateEntry } from '../lib/ledger.js';

const base = { at: '2026-10-12', contentHash: 'sha256:aaaaaaaaaaaaaaaa', rubricHash: 'sha256:bbbbbbbbbbbbbbbb', verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent' };
const BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

test('reviewedBlob is kept, bound by the token, and checked for format; entries without it stay valid', () => {
  const e = makeEntry('f', 'p', { ...base, reviewedBlob: BLOB });
  assert.equal(e.reviewedBlob, BLOB);
  assert.deepEqual(validateEntry('f', 'p', e), []);
  assert.match(validateEntry('f', 'p', { ...e, reviewedBlob: 'f'.repeat(40) }).join(), /token mismatch/);
  const noBlob = { ...e };
  delete noBlob.reviewedBlob;
  assert.match(validateEntry('f', 'p', noBlob).join(), /token mismatch/);
  assert.match(validateEntry('f', 'p', makeEntry('f', 'p', { ...base, reviewedBlob: 'nope' })).join(), /reviewedBlob/);
  const old = makeEntry('f', 'p', base);
  assert.equal('reviewedBlob' in old, false);
  assert.deepEqual(validateEntry('f', 'p', old), []);
});

const ledger = (root) => JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'));

test('review and seal store the reviewed bytes as a git object and record its id', () => {
  const { root, git } = sealRepo();
  assert.equal(run(root, ['review', 'docs/guide.md']).code, 0);
  const id = ledger(root)['docs/guide.md'].consistency.reviewedBlob;
  assert.match(id, /^[0-9a-f]{40,64}$/);
  assert.equal(git('cat-file', 'blob', id), readFileSync(join(root, 'docs/guide.md'), 'utf8'));
  write(root, 'docs/guide.md', 'Visitors need a passport and a ticket.\n');
  assert.equal(run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'clean']).code, 0);
  const id2 = ledger(root)['docs/guide.md'].consistency.reviewedBlob;
  assert.notEqual(id2, id);
  assert.equal(git('cat-file', 'blob', id2), 'Visitors need a passport and a ticket.\n');
});

const thirty = () => Array.from({ length: 30 }, (_, i) => `Line ${i + 1} says the gate opens at nine.`).join('\n') + '\n';

test('salami edits: small commits block once the drift from the reviewed version crosses the threshold', () => {
  const { root, git } = sealRepo({ substantive: { lines: 8, patterns: ['\\bonly\\b'] } });
  write(root, 'docs/guide.md', thirty());
  assert.equal(run(root, ['install-hook']).code, 0);
  assert.equal(run(root, ['review', 'docs/guide.md']).code, 0);
  git('add', '-A'); git('commit', '-qm', 'init');
  const results = [];
  for (let k = 0; k < 5; k++) {
    let t = readFileSync(join(root, 'docs/guide.md'), 'utf8');
    for (let j = 1; j <= 5; j++) t = t.replace(`Line ${k * 5 + j} says the gate opens at nine.`, `Line ${k * 5 + j} says the gate opens at ten.`);
    writeFileSync(join(root, 'docs/guide.md'), t);
    try { git('commit', '-qam', `edit ${k}`); results.push('ok'); } catch (e) { results.push(String(e.stderr)); break; }
  }
  assert.equal(results[0], 'ok'); // 5 lines from the reviewed version: under the threshold
  assert.equal(results.length, 2);
  assert.match(results[1], /BLOCK\s+docs\/guide\.md \[consistency\] reviewed \d{4}-\d{2}-\d{2}, then the file changed \(touches 10 lines\)/);
});

function commitWithEntry(over) {
  const { root, git } = sealRepo({ substantive: { lines: 8, patterns: ['\\bonly\\b'] } });
  const reviewed = 'Visitors can buy tickets with a passport.\n';
  const ch = run(root, ['hash', 'docs/guide.md']).out.trim();
  const rh = run(root, ['hash', '.seal/rubrics/consistency.md']).out.trim();
  const e = makeEntry('docs/guide.md', 'consistency', { ...base, at: new Date().toISOString().slice(0, 10), contentHash: ch, rubricHash: rh, ...over(git, reviewed) });
  write(root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: e } }));
  return { root, git };
}

test('a reviewed blob that is missing (garbage collected) counts as a substantive change', () => {
  const { root, git } = commitWithEntry(() => ({ reviewedBlob: 'f'.repeat(40) }));
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport. Bring a jacket.\n');
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /BLOCK\s+docs\/guide\.md \[consistency\] reviewed .*then the file changed/);
});

test('an entry without reviewedBlob is measured against HEAD only when HEAD holds the reviewed version', () => {
  {
    const { root, git } = commitWithEntry(() => ({}));
    git('add', '-A'); git('commit', '-qm', 'base');
    write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport. Bring a jacket.\n');
    git('add', '-A');
    const r = run(root, ['check', '--staged']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /WARN\s+docs\/guide\.md/);
  }
  {
    const { root, git } = commitWithEntry(() => ({}));
    write(root, 'docs/guide.md', 'Visitors can buy tickets with an ID card.\n');
    git('add', '-A'); git('commit', '-qm', 'base', '--no-verify'); // HEAD is not the reviewed version
    write(root, 'docs/guide.md', 'Visitors can buy tickets with an ID card. Bring a jacket.\n');
    git('add', '-A');
    const r = run(root, ['check', '--staged']);
    assert.equal(r.code, 1);
    assert.match(r.err, /BLOCK\s+docs\/guide\.md/);
  }
});

test('the reviewed blob uses the same filters as git add, so line endings do not count as changes', () => {
  const { root, git } = sealRepo({ substantive: { lines: 8, patterns: ['\\bonly\\b'] } });
  git('config', 'core.autocrlf', 'true');
  write(root, 'docs/guide.md', 'Line one.\r\nLine two.\r\nLine three.\r\n');
  assert.equal(run(root, ['review', 'docs/guide.md']).code, 0);
  const id = ledger(root)['docs/guide.md'].consistency.reviewedBlob;
  assert.equal(execFileSync('git', ['cat-file', 'blob', id], { cwd: root, encoding: 'utf8' }), 'Line one.\nLine two.\nLine three.\n');
});
