import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, computeToken, normalize } from '../lib/hash.js';

test('contentHash ignores CRLF, trailing spaces and outer whitespace', () => {
  const a = contentHash('Line one\nLine two\n');
  assert.equal(contentHash('Line one  \r\nLine two\r\n\n\n'), a);
  assert.equal(contentHash('\n\nLine one\nLine two'), a);
  assert.match(a, /^sha256:[0-9a-f]{16}$/);
});

test('contentHash changes when a word changes', () => {
  assert.notEqual(contentHash('buy with a passport'), contentHash('buy with a tax number'));
});

test('normalize keeps inner blank lines', () => {
  assert.equal(normalize('a\n\nb  \n'), 'a\n\nb');
});

test('computeToken binds every field and sorts findings', () => {
  const e = { at: '2026-10-12', contentHash: 'sha256:aaaaaaaaaaaaaaaa', rubricHash: 'sha256:bbbbbbbbbbbbbbbb', verdict: 'findings', findings: ['b', 'a'], reviewer: 'independent', via: 'agent' };
  const t = computeToken('docs/x.md', 'consistency', e);
  assert.match(t, /^rv_[0-9a-f]{12}$/);
  assert.equal(computeToken('docs/x.md', 'consistency', { ...e, findings: ['a', 'b'] }), t);
  for (const change of [{ verdict: 'clean' }, { reviewer: 'builder' }, { via: 'manual' }, { rubricHash: 'sha256:cccccccccccccccc' }, { contentHash: 'sha256:dddddddddddddddd' }, { findings: ['a'] }, { at: '2020-01-01' }]) {
    assert.notEqual(computeToken('docs/x.md', 'consistency', { ...e, ...change }), t, JSON.stringify(change));
  }
  assert.notEqual(computeToken('docs/y.md', 'consistency', e), t);
  assert.notEqual(computeToken('docs/x.md', 'fact-check', e), t);
});

test('contentHash of bytes: valid UTF-8 hashes like its text, other bytes hash as they are', () => {
  const text = '﻿Line one  \r\nLine two\n';
  assert.equal(contentHash(Buffer.from(text, 'utf8')), contentHash(text));
  // Latin-1 "café" and "cafè": both decode to U+FFFD as UTF-8 text, but they are different bytes.
  assert.notEqual(contentHash(Buffer.from([0x63, 0x61, 0x66, 0xe9])), contentHash(Buffer.from([0x63, 0x61, 0x66, 0xe8])));
  assert.notEqual(contentHash(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x0a])), contentHash(Buffer.from([0x63, 0x61, 0x66, 0xe9])));
});
