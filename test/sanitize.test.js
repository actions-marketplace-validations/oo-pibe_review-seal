import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, write, run } from './helpers.js';
import { sanitizeText } from '../lib/text.js';
import { computeToken, contentHash } from '../lib/hash.js';
import { appendInbox } from '../lib/review.js';

// Control characters other than a newline between lines, and bidi overrides, must never be printed or stored.
const BAD = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const HOSTILE = 'L1: \x1b[2J\x1b]0;pwned\x07 red\x1b[31m text\u202e\u2066 x\x9b1m\x00\x7f end';
// Arguments and environment values cannot carry a NUL.
const NO_NUL = HOSTILE.replace('\x00', '');

test('sanitizeText strips control characters and bidi overrides, and keeps text on one line', () => {
  assert.equal(sanitizeText('a\tb\r\nc\nd'), 'a b  c d');
  assert.equal(sanitizeText('\x1b[31mred\x1b[0m'), '[31mred[0m');
  assert.equal(sanitizeText('\x1b]0;title\x07x'), ']0;titlex');
  assert.equal(sanitizeText('a\u202eb\u2066c\u2069d\u202ae'), 'abcde');
  assert.equal(sanitizeText('a\x85b\x9fc\x7fd\x00e'), 'abcde');
  assert.equal(sanitizeText('line\u2028sep\u2029x'), 'line sep x');
  assert.equal(sanitizeText('plain é ü ✓'), 'plain é ü ✓');
  assert.equal(sanitizeText(undefined), '');
});

test('reviewer findings with escape sequences are stored and printed clean', () => {
  const { root, git } = sealRepo();
  const env = { FAKE_CLAUDE_MODE: 'custom', FAKE_CLAUDE_FINDINGS: JSON.stringify([HOSTILE]) };
  const rv = run(root, ['review', 'docs/guide.md'], { env });
  assert.equal(rv.code, 0, rv.err);
  assert.match(rv.out, /L1: .*red.*end/);
  assert.doesNotMatch(rv.out + rv.err, BAD);
  const ledger = JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'));
  const [f] = ledger['docs/guide.md'].consistency.findings;
  assert.doesNotMatch(f, BAD);
  git('add', '-A');
  for (const args of [['check', '--staged'], ['check'], ['list']]) {
    const r = run(root, args);
    assert.doesNotMatch(r.out + r.err, BAD, args.join(' '));
  }
});

// A cloned repository can ship a ledger written by anyone; its text is printed only after sanitising.
function hostileLedger(root) {
  const text = readFileSync(join(root, 'docs/guide.md'));
  const rubric = readFileSync(join(root, '.seal/rubrics/consistency.md'));
  const e = { at: '2026-01-01', contentHash: contentHash(text), rubricHash: contentHash(rubric), verdict: 'findings', findings: [HOSTILE], reviewer: 'independent', via: 'agent' };
  e.token = computeToken('docs/guide.md', 'consistency', e);
  const bad = { at: '2026\x1b]0;x\x07-01-01', contentHash: 'sha256:\x1b[2J', rubricHash: 'x', verdict: 'findings\x1b[31m', findings: [HOSTILE], reviewer: 'builder\x1b[0m', via: 'agent', token: 'x' };
  write(root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: e }, 'docs/gone\x1b[31m.md': { consistency: bad } }));
}

test('a pre-built ledger with escape sequences prints clean in check and list', () => {
  const { root, git } = sealRepo();
  hostileLedger(root);
  git('add', '-A');
  for (const args of [['check', '--staged'], ['check'], ['check', 'docs/guide.md'], ['list']]) {
    const r = run(root, args);
    assert.doesNotMatch(r.out + r.err, BAD, args.join(' '));
  }
  const ci = run(root, ['check'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.match(ci.out, /^::warning /m);
  assert.doesNotMatch(ci.out + ci.err, BAD);
});

test('an invalid hostile entry prints clean when it blocks', () => {
  const { root, git } = sealRepo();
  const bad = { at: '2026\x1b]0;x\x07-01-01', contentHash: 'sha256:\x1b[2J', rubricHash: 'x', verdict: 'findings\x1b[31m', findings: [HOSTILE], reviewer: 'builder\x1b[0m', via: 'agent', token: 'x' };
  write(root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: bad } }));
  git('add', '-A');
  for (const args of [['check', '--staged'], ['check'], ['list']]) {
    const r = run(root, args);
    assert.doesNotMatch(r.out + r.err, BAD, args.join(' '));
  }
});

test('hook context carries no escape sequences from findings or errors', () => {
  const { root } = sealRepo();
  appendInbox(root, [{ file: 'docs/guide.md', pass: 'consistency', findings: [HOSTILE] }, { file: 'docs/guide.md', pass: 'consistency', error: `reviewer exited 1: ${HOSTILE}` }]);
  const r = run(root, ['hook', 'user-prompt'], { input: JSON.stringify({ session_id: 's1', cwd: root }) });
  const c = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(c, /red/);
  assert.doesNotMatch(c, BAD);
});

test('reviewer errors from stderr are printed clean', () => {
  const { root } = sealRepo();
  const r = run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'fail', FAKE_CLAUDE_STDERR: NO_NUL } });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out + r.err, BAD);
});

test('seal --reviewer builder stores findings clean', () => {
  const { root } = sealRepo();
  const r = run(root, ['seal', 'docs/guide.md', '--pass', 'consistency', '--reviewer', 'builder', '--verdict', 'findings', '--finding', NO_NUL]);
  assert.equal(r.code, 0, r.err);
  const ledger = JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'));
  assert.doesNotMatch(ledger['docs/guide.md'].consistency.findings[0], BAD);
  assert.equal(run(root, ['check', 'docs/guide.md']).code, 0);
});
