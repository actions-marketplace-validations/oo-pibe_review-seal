import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, extractVerdict, runReviewer } from '../lib/reviewer.js';
import { sealRepo, FAKE_CLAUDE } from './helpers.js';

const job = { file: 'docs/guide.md', pass: 'consistency', rubricPath: '.seal/rubrics/consistency.md', contentHash: 'sha256:1111111111111111', rubricHash: 'sha256:2222222222222222' };

test('prompt names the file, the checklist and the hashes, and forbids edits', () => {
  const p = buildPrompt(job);
  for (const s of ['docs/guide.md', '.seal/rubrics/consistency.md', job.contentHash, job.rubricHash, 'must not edit']) assert.ok(p.includes(s), s);
});

test('extractVerdict reads the claude json envelope, fenced json and bare json', () => {
  const v = { ...job, verdict: 'findings', findings: ['L1: x'] };
  delete v.rubricPath;
  assert.deepEqual(extractVerdict(JSON.stringify({ result: JSON.stringify(v) })).findings, ['L1: x']);
  assert.equal(extractVerdict('Sure.\n```json\n' + JSON.stringify(v) + '\n```\nDone {not json}').verdict, 'findings');
  assert.equal(extractVerdict(JSON.stringify({ ...v, verdict: 'clean', findings: ['ignored'] })).findings.length, 0);
});

test('extractVerdict rejects junk and findings with no findings', () => {
  assert.equal(extractVerdict('looks fine'), null);
  assert.equal(extractVerdict(JSON.stringify({ verdict: 'findings', findings: [] })), null);
  assert.equal(extractVerdict(JSON.stringify({ verdict: 'great' })), null);
  assert.equal(extractVerdict('{"a": "}"} {"verdict":"clean","findings":[]}').verdict, 'clean');
});

for (const [mode, expect] of [['clean', { ok: true }], ['findings', { ok: true }], ['garbage', { ok: false, error: /could not read a verdict/ }], ['fail', { ok: false, error: /exited 1/ }]]) {
  test(`runReviewer with a fake claude: ${mode}`, async () => {
    const { root } = sealRepo();
    process.env.FAKE_CLAUDE_MODE = mode;
    try {
      const r = await runReviewer(job, { root, claude: FAKE_CLAUDE, model: 'sonnet', timeoutSeconds: 10 });
      assert.equal(r.ok, expect.ok);
      if (expect.error) assert.match(r.error, expect.error);
      if (r.ok) assert.equal(r.verdict.contentHash, job.contentHash);
    } finally { delete process.env.FAKE_CLAUDE_MODE; }
  });
}

test('runReviewer times out', async () => {
  const { root } = sealRepo();
  process.env.FAKE_CLAUDE_MODE = 'sleep';
  try {
    const r = await runReviewer(job, { root, claude: FAKE_CLAUDE, timeoutSeconds: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
  } finally { delete process.env.FAKE_CLAUDE_MODE; }
});

test('runReviewer reports a missing claude binary plainly', async () => {
  const { root } = sealRepo();
  const r = await runReviewer(job, { root, claude: '/nonexistent/claude', timeoutSeconds: 5 });
  assert.match(r.error, /not found/);
});
