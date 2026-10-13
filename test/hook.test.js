import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { sealRepo, tmpRepo, write, run, FAKE_CLAUDE } from './helpers.js';
import { touchedFiles, onPostTool } from '../lib/hook.js';
import { appendInbox } from '../lib/review.js';
import { workingTreeChanges } from '../lib/git.js';

const hook = (root, event, payload, env) => run(root, ['hook', event], { input: JSON.stringify({ session_id: 's1', cwd: root, ...payload }), env });
const ctx = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : '');

test('touchedFiles: edit tools by path, Bash by any path form in the command', () => {
  const covered = ['docs/guide.md', 'docs/other.md'];
  const root = '/repo';
  assert.deepEqual(touchedFiles({ tool_name: 'Edit', tool_input: { file_path: '/repo/docs/guide.md' }, cwd: root }, root, covered), ['docs/guide.md']);
  assert.deepEqual(touchedFiles({ tool_name: 'Write', tool_input: { file_path: '/repo/src/x.js' }, cwd: root }, root, covered), []);
  assert.deepEqual(touchedFiles({ tool_name: 'Bash', tool_input: { command: "python3 - <<'EOF'\nopen('docs/other.md','w')\nEOF" }, cwd: root }, root, covered), ['docs/other.md']);
  assert.deepEqual(touchedFiles({ tool_name: 'Bash', tool_input: { command: 'sed -i "" s/a/b/ guide.md' }, cwd: '/repo/docs' }, root, covered), ['docs/guide.md']);
  assert.deepEqual(touchedFiles({ tool_name: 'Read', tool_input: { file_path: '/repo/docs/guide.md' }, cwd: root }, root, covered), []);
});

// Claude Code may report paths through a symlinked alias of the repo (macOS: /var vs /private/var),
// while git reports the real path as the root.
function aliasOf(root) {
  try {
    const link = join(mkdtempSync(join(tmpdir(), 'review-seal-alias-')), 'repo');
    symlinkSync(root, link, 'dir');
    return realpathSync(link) === root && link !== root ? link : null;
  } catch { return null; }
}

test('touchedFiles: paths through a non-realpath alias of the repo map into the repo', (t) => {
  const { root } = sealRepo();
  const alias = aliasOf(root);
  if (!alias) return t.skip('cannot make a symlink alias here');
  const covered = ['docs/guide.md', 'docs/new.md'];
  assert.deepEqual(touchedFiles({ tool_name: 'Edit', tool_input: { file_path: join(alias, 'docs/guide.md') }, cwd: alias }, root, covered), ['docs/guide.md']);
  assert.deepEqual(touchedFiles({ tool_name: 'Write', tool_input: { file_path: join(alias, 'docs/new.md') }, cwd: alias }, root, covered), ['docs/new.md']);
  assert.deepEqual(touchedFiles({ tool_name: 'Edit', tool_input: { file_path: 'guide.md' }, cwd: join(alias, 'docs') }, root, covered), ['docs/guide.md']);
  assert.deepEqual(touchedFiles({ tool_name: 'Bash', tool_input: { command: `cat > ${join(alias, 'docs/guide.md')}` }, cwd: '/' }, root, covered), ['docs/guide.md']);
  assert.deepEqual(touchedFiles({ tool_name: 'Bash', tool_input: { command: 'sed -i "" s/a/b/ guide.md' }, cwd: join(alias, 'docs') }, root, covered), ['docs/guide.md']);
  assert.deepEqual(touchedFiles({ tool_name: 'Edit', tool_input: { file_path: join(alias, 'src/app.js') }, cwd: alias }, root, covered), []);
});

test('post-tool: fires when the payload uses an alias of the repo path', (t) => {
  const { root } = sealRepo();
  const alias = aliasOf(root);
  if (!alias) return t.skip('cannot make a symlink alias here');
  const r = hook(root, 'post-tool', { cwd: alias, tool_name: 'Edit', tool_input: { file_path: join(alias, 'docs/guide.md') } });
  assert.match(ctx(r), /docs\/guide\.md \[consistency\]: review is now out of date/);
});

test('post-tool: says the review is stale and briefs the rubric once per session', () => {
  const { root } = sealRepo();
  const p = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, 'docs/guide.md') } };
  const first = ctx(hook(root, 'post-tool', p));
  assert.match(first, /docs\/guide\.md \[consistency\]: review is now out of date/);
  assert.match(first, /Does the text contradict itself\?/);
  const second = ctx(hook(root, 'post-tool', p));
  assert.doesNotMatch(second, /contradict itself/);
});

test('post-tool after a heredoc edit through Bash still fires', () => {
  const { root } = sealRepo();
  const r = hook(root, 'post-tool', { tool_name: 'Bash', tool_input: { command: "cat > docs/guide.md <<'EOF'\nnew\nEOF" } });
  assert.match(ctx(r), /out of date/);
});

test('stop: starts a background review of files touched this session', async () => {
  const { root } = sealRepo();
  hook(root, 'post-tool', { tool_name: 'Edit', tool_input: { file_path: join(root, 'docs/guide.md') } });
  const r = hook(root, 'stop', { hook_event_name: 'Stop' }, { REVIEW_SEAL_CLAUDE: FAKE_CLAUDE });
  assert.equal(r.code, 0);
  for (let i = 0; i < 50 && !existsSync(join(root, '.seal/ledger.json')); i++) await sleep(100);
  for (let i = 0; i < 50 && existsSync(join(root, '.seal/.state/review.lock')); i++) await sleep(100);
  const led = JSON.parse(readFileSync(join(root, '.seal/ledger.json'), 'utf8'));
  assert.equal(led['docs/guide.md'].consistency.reviewer, 'independent');
});

test('stop: does nothing when autoReview is off or nothing was touched', () => {
  const off = sealRepo({ autoReview: 'off' }).root;
  hook(off, 'post-tool', { tool_name: 'Edit', tool_input: { file_path: join(off, 'docs/guide.md') } });
  hook(off, 'stop', {});
  const quiet = sealRepo().root;
  hook(quiet, 'stop', {});
  for (const r of [off, quiet]) assert.ok(!existsSync(join(r, '.seal/.state/review.log')));
});

test('user-prompt: delivers findings once', () => {
  const { root } = sealRepo();
  mkdirSync(join(root, '.seal/.state'), { recursive: true });
  appendInbox(root, [{ file: 'docs/guide.md', pass: 'consistency', findings: ['L1: wrong'] }, { file: 'docs/x.md', pass: 'consistency', error: 'boom' }]);
  const c = ctx(hook(root, 'user-prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }));
  assert.match(c, /L1: wrong/);
  assert.match(c, /could not run \(boom\)/);
  assert.equal(hook(root, 'user-prompt', {}).out, '');
});

test('hooks are silent and exit 0: no config, not a repo, broken config, inside a reviewer', () => {
  const plain = tmpRepo().root;
  assert.deepEqual([hook(plain, 'post-tool', { tool_name: 'Edit', tool_input: { file_path: join(plain, 'a.md') } }).code, hook(plain, 'post-tool', {}).out], [0, '']);
  const broken = sealRepo().root;
  write(broken, '.seal/config.json', '{');
  const b = hook(broken, 'post-tool', { tool_name: 'Edit', tool_input: { file_path: join(broken, 'docs/guide.md') } });
  assert.deepEqual([b.code, b.out], [0, '']);
  const child = sealRepo().root;
  const c = hook(child, 'post-tool', { tool_name: 'Edit', tool_input: { file_path: join(child, 'docs/guide.md') } }, { REVIEW_SEAL_CHILD: '1' });
  assert.equal(c.out, '');
  const notJson = run(child, ['hook', 'post-tool'], { input: 'not json' });
  assert.deepEqual([notJson.code, notJson.out], [0, '']);
});

// A root that is not a git repository: listing its files would throw, so these prove the hook never listed.
const NO_REPO = join(tmpdir(), 'review-seal-no-such-repo');
const CFG = { passes: { consistency: { rubric: '.seal/rubrics/consistency.md', files: ['docs/**/*.md'] } }, autoReview: 'stop' };

test('post-tool: tools that cannot edit files return at once, without listing the repo', () => {
  for (const tool_name of ['Read', 'Grep', 'Glob', 'WebFetch']) {
    assert.equal(onPostTool({ session_id: 's', cwd: NO_REPO, tool_name, tool_input: { file_path: join(NO_REPO, 'docs/guide.md') } }, NO_REPO, CFG), '');
  }
});

test('post-tool: edit tools check only the edited path, without listing the repo', () => {
  const p = (file_path) => ({ session_id: 's', cwd: NO_REPO, tool_name: 'Edit', tool_input: { file_path } });
  assert.equal(onPostTool(p(join(NO_REPO, 'src/x.js')), NO_REPO, CFG), '');
  assert.equal(onPostTool(p(join(NO_REPO, 'docs/missing.md')), NO_REPO, CFG), '');
});

test('post-tool: a Bash command naming nothing like a covered path returns without listing the repo', () => {
  const b = (command) => ({ session_id: 's', cwd: NO_REPO, tool_name: 'Bash', tool_input: { command } });
  assert.equal(onPostTool(b('ls -la && npm test'), NO_REPO, CFG), '');
  assert.throws(() => onPostTool(b('cat docs/guide.md'), NO_REPO, CFG));
});


const waitFor = async (cond, ms = 5000) => { for (let t = 0; t < ms && !cond(); t += 100) await sleep(100); return cond(); };
const committedRepo = (over) => {
  const r = sealRepo(over);
  r.git('add', '-A');
  r.git('commit', '-qm', 'init');
  return r;
};
const reviewedAtStop = async (root, command, cwd = root) => {
  hook(root, 'post-tool', { cwd, tool_name: 'Bash', tool_input: { command } });
  hook(root, 'stop', {});
  const led = join(root, '.seal/ledger.json');
  await waitFor(() => existsSync(led) && !existsSync(join(root, '.seal/.state/review.lock')));
  return existsSync(led) ? Object.keys(JSON.parse(readFileSync(led, 'utf8'))) : [];
};

test('touchedFiles: Bash matches need a path boundary on both sides', () => {
  const root = '/repo';
  const t = (command, covered) => touchedFiles({ tool_name: 'Bash', tool_input: { command }, cwd: root }, root, covered);
  assert.deepEqual(t('cat NOT_README.md', ['README.md']), []);
  assert.deepEqual(t('cat olddocs/guide.md', ['docs/guide.md']), []);
  assert.deepEqual(t('cat docs/guide.md.bak', ['docs/guide.md']), []);
  assert.deepEqual(t('cat ./docs/guide.md', ['docs/guide.md']), ['docs/guide.md']);
  assert.deepEqual(t('x="docs/guide.md"; echo hi>docs/guide.md', ['docs/guide.md']), ['docs/guide.md']);
  assert.deepEqual(t('cat README.md|wc', ['README.md']), ['README.md']);
  assert.deepEqual(t('(cat /repo/README.md)', ['README.md']), ['README.md']);
});

test('workingTreeChanges: modified, staged, untracked and renamed files, relative to the root', () => {
  const { root, git } = committedRepo();
  write(root, 'docs/guide.md', 'changed\n');
  write(root, 'docs/new/deep.md', 'n\n');
  git('mv', 'src/app.js', 'src/moved.js');
  assert.deepEqual(workingTreeChanges(root).sort(), ['docs/guide.md', 'docs/new/deep.md', 'src/moved.js']);
});

test('stop: reviews a covered file changed by a Bash command that names it indirectly', async () => {
  const { root } = committedRepo();
  write(root, 'docs/guide.md', 'changed once\n');
  assert.deepEqual(await reviewedAtStop(root, 'cd docs && sed -i x guide.md'), ['docs/guide.md']);
  const g = committedRepo().root;
  write(g, 'docs/guide.md', 'changed twice\n');
  assert.deepEqual(await reviewedAtStop(g, 'sed -i s/a/b/ docs/*.md'), ['docs/guide.md']);
});

test('stop: a committed, unchanged file that was only read through Bash is not reviewed', async () => {
  const { root } = committedRepo();
  const p = { tool_name: 'Bash', tool_input: { command: 'cat docs/guide.md' } };
  assert.doesNotMatch(ctx(hook(root, 'post-tool', p)), /out of date/);
  assert.deepEqual(await reviewedAtStop(root, 'cat docs/guide.md'), []);
  assert.ok(!existsSync(join(root, '.seal/.state/review.log')));
});
