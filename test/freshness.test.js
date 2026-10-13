import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseConfig } from '../lib/config.js';
import { expiryReason, needsReview } from '../lib/evaluate.js';
import { reviewByOf } from '../lib/files.js';
import { makeEntry } from '../lib/ledger.js';
import { contentHash } from '../lib/hash.js';
import { runReviewer } from '../lib/reviewer.js';
import { sealRepo, write, run, FAKE_CLAUDE } from './helpers.js';

const cfgWith = (pass) => parseConfig(JSON.stringify({ passes: { 'fact-check': { rubric: 'r.md', files: ['docs/**'], ...pass } } }));
const entry = (at) => makeEntry('docs/a.md', 'fact-check', { at, contentHash: 'sha256:1111111111111111', rubricHash: 'sha256:2222222222222222', verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent' });

test('config validates maxAgeDays and tools', () => {
  assert.equal(cfgWith({}).passes['fact-check'].maxAgeDays, null);
  assert.deepEqual(cfgWith({}).passes['fact-check'].tools, []);
  assert.deepEqual(cfgWith({ tools: ['WebSearch', 'WebFetch'] }).passes['fact-check'].tools, ['WebSearch', 'WebFetch']);
  assert.throws(() => cfgWith({ tools: ['Write'] }), /only WebSearch and WebFetch/);
  assert.throws(() => cfgWith({ maxAgeDays: 0 }), /positive whole number/);
});

test('reviewByOf reads front matter only', () => {
  assert.equal(reviewByOf('---\ntitle: x\nreview-by: 2026-12-01\n---\nbody'), '2026-12-01');
  assert.equal(reviewByOf('---\nreview-by: "2026-12-01"\n---\n'), '2026-12-01');
  assert.equal(reviewByOf('body\nreview-by: 2026-12-01\n'), null);
});

test('expiry by age and by review-by date', () => {
  const c = cfgWith({ maxAgeDays: 90 });
  assert.equal(expiryReason(entry('2026-07-01'), 'fact-check', c, { today: '2026-09-28' }), null);
  assert.match(expiryReason(entry('2026-07-01'), 'fact-check', c, { today: '2026-10-13' }), /older than 90 days/);
  const n = cfgWith({});
  assert.match(expiryReason(entry('2026-10-01'), 'fact-check', n, { today: '2026-11-01', reviewBy: '2026-11-01' }), /review-by date 2026-11-01/);
  assert.equal(expiryReason(entry('2026-11-02'), 'fact-check', n, { today: '2026-11-05', reviewBy: '2026-11-01' }), null);
  assert.equal(expiryReason(entry('2026-10-01'), 'fact-check', n, {}), null);
  const led = { 'docs/a.md': { 'fact-check': entry('2026-07-01') } };
  const h = { contentHash: 'sha256:1111111111111111', rubricHash: 'sha256:2222222222222222' };
  assert.equal(needsReview('docs/a.md', 'fact-check', led, h, c), false);
  assert.equal(needsReview('docs/a.md', 'fact-check', led, h, c, { today: '2026-10-13' }), true);
});

test('fact-check passes give the reviewer web tools, and only those', async () => {
  const { root } = sealRepo();
  const log = join(mkdtempSync(join(tmpdir(), 'rs-log-')), 'calls.jsonl');
  process.env.FAKE_CLAUDE_LOG = log;
  try {
    await runReviewer({ file: 'docs/guide.md', pass: 'consistency', rubricPath: 'r', contentHash: 'sha256:1111111111111111', rubricHash: 'sha256:2222222222222222', tools: ['WebSearch', 'WebFetch'] }, { root, claude: FAKE_CLAUDE, timeoutSeconds: 10 });
  } finally { delete process.env.FAKE_CLAUDE_LOG; }
  const { args } = JSON.parse(readFileSync(log, 'utf8').trim());
  const toolsAt = args.indexOf('--tools');
  assert.deepEqual(args.slice(toolsAt + 1, toolsAt + 6), ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
  const allowAt = args.indexOf('--allowedTools');
  assert.deepEqual(args.slice(allowAt + 1, allowAt + 3), ['WebSearch', 'WebFetch']);
  assert.match(args[args.indexOf('-p') + 1], /source URL/);
});

test('an aged review shows as EXPIRED, fails check, and review --due renews it', () => {
  const { root } = sealRepo({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'], maxAgeDays: 30 } } });
  const text = readFileSync(join(root, 'docs/guide.md'), 'utf8');
  const rubric = readFileSync(join(root, '.seal/rubrics/consistency.md'), 'utf8');
  const old = makeEntry('docs/guide.md', 'consistency', { at: '2020-01-01', contentHash: contentHash(text), rubricHash: contentHash(rubric), verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent' });
  write(root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: old } }));
  assert.match(run(root, ['list']).out, /consistency\s+EXPIRED/);
  const c = run(root, ['check']);
  assert.equal(c.code, 1);
  assert.match(c.err, /older than 30 days/);
  assert.equal(run(root, ['review', '--due']).code, 0);
  assert.match(run(root, ['list']).out, /consistency\s+fresh/);
  assert.equal(run(root, ['check']).code, 0);
});

test('action has a scheduled "due" mode that opens a PR', () => {
  const y = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(y, /mode:/);
  assert.match(y, /review --due/);
  assert.match(y, /gh pr create/);
});

test('config rejects a tools value that is not a list of distinct web tools', () => {
  assert.throws(() => cfgWith({ tools: 'WebSearch' }), /only WebSearch and WebFetch/);
  assert.throws(() => cfgWith({ tools: ['WebSearch', 'WebSearch'] }), /at most once/);
  assert.throws(() => cfgWith({ maxAgeDays: 1.5 }), /positive whole number/);
  assert.throws(() => cfgWith({ maxAgeDays: '30' }), /positive whole number/);
  assert.equal(cfgWith({ maxAgeDays: null }).passes['fact-check'].maxAgeDays, null);
});

test('reviewByOf ignores dates that are not real', () => {
  assert.equal(reviewByOf('---\nreview-by: 2026-02-30\n---\n'), null);
  assert.equal(reviewByOf('﻿---\r\nreview-by: 2026-12-01\r\n---\r\n'), '2026-12-01');
});

test('a review-by date in front matter blocks check, and the hint names review --due', () => {
  const { root } = sealRepo();
  write(root, 'docs/guide.md', '---\nreview-by: 2021-01-01\n---\nVisitors can buy tickets with a passport.\n');
  const text = readFileSync(join(root, 'docs/guide.md'), 'utf8');
  const rubric = readFileSync(join(root, '.seal/rubrics/consistency.md'), 'utf8');
  const old = makeEntry('docs/guide.md', 'consistency', { at: '2020-06-01', contentHash: contentHash(text), rubricHash: contentHash(rubric), verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent' });
  write(root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: old } }));
  assert.match(run(root, ['list']).out, /consistency\s+EXPIRED/);
  const c = run(root, ['check']);
  assert.equal(c.code, 1);
  assert.match(c.err, /before the file's review-by date 2021-01-01; due for a fresh review/);
  assert.match(c.err, /review-seal review --due\n/);
  assert.equal(run(root, ['review', '--due']).code, 0);
  assert.equal(run(root, ['check']).code, 0);
});

test('without web tools the prompt asks for no sources', async () => {
  const { buildPrompt } = await import('../lib/reviewer.js');
  assert.doesNotMatch(buildPrompt({ file: 'a.md', pass: 'p', rubricPath: 'r', contentHash: 'x', rubricHash: 'y' }), /source URL/);
});

// An expired review of docs/guide.md, committed; returns the repo.
function expiredRepo() {
  const r = sealRepo({ substantive: { patterns: ['\\bonly\\b'] }, passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'], maxAgeDays: 30 } } });
  write(r.root, 'docs/guide.md', 'Visitors can buy tickets with a pasport.\n');
  const text = readFileSync(join(r.root, 'docs/guide.md'), 'utf8');
  const rubric = readFileSync(join(r.root, '.seal/rubrics/consistency.md'), 'utf8');
  const old = makeEntry('docs/guide.md', 'consistency', { at: '2020-01-01', contentHash: contentHash(text), rubricHash: contentHash(rubric), verdict: 'clean', findings: [], reviewer: 'independent', via: 'agent' });
  write(r.root, '.seal/ledger.json', JSON.stringify({ 'docs/guide.md': { consistency: old } }));
  r.git('add', '-A'); r.git('commit', '-qm', 'init');
  return r;
}

test('at commit time, expiry follows the change size: a typo fix only warns', () => {
  const { root, git } = expiredRepo();
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport.\n');
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /WARN\s+docs\/guide\.md \[consistency\] reviewed 2020-01-01, older than 30 days; due for a fresh review/);
});

test('at commit time, a substantive edit to an expired file blocks', () => {
  const { root, git } = expiredRepo();
  write(root, 'docs/guide.md', 'Visitors can buy tickets with a passport.\nOnly residents may buy online.\n');
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /BLOCK\s+docs\/guide\.md \[consistency\] reviewed 2020-01-01, older than 30 days/);
});

test('plain check keeps expiry a hard block', () => {
  const { root } = expiredRepo();
  for (const args of [['check'], ['check', 'docs/guide.md']]) {
    const r = run(root, args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /BLOCK\s+docs\/guide\.md \[consistency\] reviewed 2020-01-01, older than 30 days/);
  }
});

test('review --due or --all with files or --changed-since is bad usage', () => {
  const { root, git } = sealRepo();
  git('add', '-A'); git('commit', '-qm', 'init');
  for (const args of [['review', '--due', 'docs/guide.md'], ['review', '--all', 'docs/guide.md'], ['review', '--due', '--changed-since', 'HEAD'], ['review', '--all', '--changed-since', 'HEAD']]) {
    const r = run(root, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, new RegExp(`use --${args.includes('--due') ? 'due' : 'all'} on its own, or name files`));
  }
});
