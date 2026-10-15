import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../lib/config.js';
import { evaluate } from '../lib/evaluate.js';
import { makeEntry } from '../lib/ledger.js';
import { sealRepo, run } from './helpers.js';

const pass = { rubric: 'r.md', files: ['docs/**/*.md'] };
const rejects = (c, re) => assert.throws(() => parseConfig(JSON.stringify(c)), (e) => e instanceof ConfigError && re.test(e.message), JSON.stringify(c));

test('an unknown top-level key is refused, naming it and the closest valid key', () => {
  rejects({ passes: { a: pass }, blockOnFinding: true }, /unknown key "blockOnFinding" in \.seal\/config\.json; did you mean "blockOnFindings"\?/);
  rejects({ passes: { a: pass }, autoreview: 'off' }, /unknown key "autoreview".*did you mean "autoReview"\?/);
  // Nothing close: the valid keys are listed instead.
  rejects({ passes: { a: pass }, zzzzzzzzzzzz: 1 }, /unknown key "zzzzzzzzzzzz" in \.seal\/config\.json; valid keys: passes, /);
});

test('an unknown key in a pass is refused, naming the pass, the key and the closest valid key', () => {
  rejects({ passes: { a: { ...pass, maxAgedays: 30 } } }, /pass "a": unknown key "maxAgedays"; did you mean "maxAgeDays"\?/);
  rejects({ passes: { a: { ...pass, rubrics: 'x' } } }, /pass "a": unknown key "rubrics"; did you mean "rubric"\?/);
  rejects({ passes: { a: { ...pass, tool: ['WebSearch'] } } }, /did you mean "tools"\?/);
});

test('an unknown key in "substantive" is refused', () => {
  rejects({ passes: { a: pass }, substantive: { line: 3 } }, /"substantive": unknown key "line"; did you mean "lines"\?/);
});

test('a pass may set blockOnFindings, which must be true or false', () => {
  assert.equal(parseConfig(JSON.stringify({ passes: { a: { ...pass, blockOnFindings: true } } })).passes.a.blockOnFindings, true);
  rejects({ passes: { a: { ...pass, blockOnFindings: 'yes' } } }, /pass "a": "blockOnFindings" must be true or false/);
});

const H = 'sha256:1111111111111111';
const R = 'sha256:2222222222222222';
const findingsLedger = (passes) => ({ 'docs/a.md': Object.fromEntries(passes.map((p) => [p, makeEntry('docs/a.md', p, { at: '2026-10-12', contentHash: H, rubricHash: R, verdict: 'findings', findings: ['L1: wrong'], reviewer: 'independent', via: 'agent' })])) });
const item = { file: 'docs/a.md', contentHash: H, rubricHashes: { facts: R, style: R }, change: { substantive: true, why: '' } };
const cfgWith = (top, facts, style) => parseConfig(JSON.stringify({
  ...(top === undefined ? {} : { blockOnFindings: top }),
  passes: { facts: { ...pass, ...(facts === undefined ? {} : { blockOnFindings: facts }) }, style: { ...pass, ...(style === undefined ? {} : { blockOnFindings: style }) } },
}));

test('evaluate: a pass\'s blockOnFindings overrides the top-level one for that pass', () => {
  const led = findingsLedger(['facts', 'style']);
  const reasons = (c) => {
    const r = evaluate([item], led, c);
    return { blocks: r.blocks.map((b) => b.pass), warnings: r.warnings.map((w) => w.pass) };
  };
  assert.deepEqual(reasons(cfgWith(undefined, true)), { blocks: ['facts'], warnings: ['style'] });
  assert.deepEqual(reasons(cfgWith(true, undefined, false)), { blocks: ['facts'], warnings: ['style'] });
  assert.deepEqual(reasons(cfgWith(false, false, true)), { blocks: ['style'], warnings: ['facts'] });
  assert.deepEqual(reasons(cfgWith(true)), { blocks: ['facts', 'style'], warnings: [] });
});

test('check exits 2 with the key named when the config has a typo', () => {
  const { root } = sealRepo({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'], maxAgedays: 30 } } });
  const r = run(root, ['check']);
  assert.equal(r.code, 2);
  assert.match(r.err, /pass "consistency": unknown key "maxAgedays"; did you mean "maxAgeDays"\?/);
});

test('per-pass blockOnFindings blocks a commit through check', () => {
  const { root, git } = sealRepo({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'], blockOnFindings: true } } });
  run(root, ['review', 'docs/guide.md'], { env: { FAKE_CLAUDE_MODE: 'findings' } });
  git('add', '-A');
  const r = run(root, ['check', '--staged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /open findings block this commit/);
});

test('a pass setting at the top level, or a top-level setting in a pass, says where it belongs', () => {
  for (const k of ['maxAgeDays', 'tools', 'fetchDomains', 'rubric', 'files']) {
    rejects({ passes: { a: pass }, [k]: 1 }, new RegExp(`"${k}" belongs inside a pass`));
  }
  for (const k of ['autoReview', 'model', 'timeoutSeconds', 'ledger', 'maxFilesPerRun', 'substantive', 'independentFrom', 'passes']) {
    rejects({ passes: { a: { ...pass, [k]: 1 } } }, new RegExp(`pass "a": "${k}" is a top-level setting`));
  }
});
