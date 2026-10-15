import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sealRepo, write, run } from './helpers.js';

const hook = (root, event, payload = {}) => run(root, ['hook', event], { input: JSON.stringify({ session_id: 's1', cwd: root, ...payload }) });
const ctx = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : '');

test('a broken config is reported once per session at the prompt and after a tool; Stop stays silent', () => {
  const { root } = sealRepo();
  write(root, '.seal/config.json', JSON.stringify({ passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'], maxAgedays: 3 } } }));
  const want = /^review-seal: \.seal\/config\.json: pass "consistency": unknown key "maxAgedays"; did you mean "maxAgeDays"\? Automatic reviews are off until it's fixed\.$/;
  const p = hook(root, 'user-prompt');
  assert.equal(p.code, 0);
  assert.equal(JSON.parse(p.out).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(ctx(p), want);
  assert.equal(hook(root, 'user-prompt').out, '');
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(root, 'docs/guide.md') } };
  const t = hook(root, 'post-tool', edit);
  assert.equal(JSON.parse(t.out).hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(ctx(t), want);
  assert.equal(hook(root, 'post-tool', edit).out, '');
  assert.equal(hook(root, 'stop').out, '');
  // Another session hears it again.
  assert.match(ctx(hook(root, 'user-prompt', { session_id: 's2' })), want);
});

test('the reported message is flattened and stripped of control characters', () => {
  const { root } = sealRepo();
  write(root, '.seal/config.json', '{"passes": {"Bad\\u001b[31m": {}}}');
  const c = ctx(hook(root, 'user-prompt'));
  assert.match(c, /^review-seal: \.seal\/config\.json: pass name "Bad/);
  assert.doesNotMatch(c, /\x1b|\n/);
});

test('not valid JSON names the file once', () => {
  const { root } = sealRepo();
  write(root, '.seal/config.json', '{');
  const c = ctx(hook(root, 'user-prompt'));
  assert.match(c, /^review-seal: \.seal\/config\.json is not valid JSON: .*\. Automatic reviews are off until it's fixed\.$/);
});
