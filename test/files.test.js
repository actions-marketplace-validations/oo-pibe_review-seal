import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, write } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { coveredFiles, rubricHashes } from '../lib/files.js';
import { repoRoot, stagedFiles, stagedContent, stagedDiff, changedSince } from '../lib/git.js';
import { contentHash } from '../lib/hash.js';

test('coveredFiles: tracked and untracked, matching a pass, existing', () => {
  const { root, git } = sealRepo();
  write(root, 'docs/new.md', 'new\n');
  write(root, 'docs/gone.md', 'x\n');
  git('add', '-A');
  rmSync(join(root, 'docs/gone.md'));
  assert.deepEqual(coveredFiles(root, loadConfig(root)), ['docs/guide.md', 'docs/new.md']);
});

test('rubricHashes hashes each rubric', () => {
  const { root } = sealRepo();
  assert.deepEqual(rubricHashes(root, loadConfig(root)), { consistency: contentHash('Does the text contradict itself?\n') });
});

test('git helpers read the index, not the working tree', () => {
  const { root, git } = sealRepo();
  git('add', '-A'); git('commit', '-qm', 'init');
  write(root, 'docs/guide.md', 'staged version\n');
  git('add', 'docs/guide.md');
  write(root, 'docs/guide.md', 'working version\n');
  assert.equal(repoRoot(join(root, 'docs')), repoRoot(root));
  assert.deepEqual(stagedFiles(root), ['docs/guide.md']);
  assert.equal(stagedContent(root, 'docs/guide.md'), 'staged version\n');
  assert.match(stagedDiff(root, 'docs/guide.md'), /\+staged version/);
  git('commit', '-qm', 'change');
  assert.deepEqual(changedSince(root, 'HEAD~1'), ['docs/guide.md']);
});

test('repoRoot is null outside a repo', () => {
  assert.equal(repoRoot('/'), null);
});
