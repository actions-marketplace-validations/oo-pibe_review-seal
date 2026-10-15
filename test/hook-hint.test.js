import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealRepo, run } from './helpers.js';

const HINT = /this clone has no review-seal hook; run review-seal install-hook \(or add "prepare": "review-seal install-hook" to package\.json\)/;

test('check says once that this clone has no review-seal hook', () => {
  const { root } = sealRepo();
  const first = run(root, ['check']);
  assert.match(first.err, HINT);
  assert.doesNotMatch(run(root, ['check']).err, HINT);
});

test('check --staged run by hand also says it', () => {
  const { root, git } = sealRepo();
  git('add', '-A');
  assert.match(run(root, ['check', '--staged']).err, HINT);
});

test('no hint once the hook is installed, under a hook manager, in CI, or from a git hook', () => {
  {
    const { root } = sealRepo();
    assert.equal(run(root, ['install-hook']).code, 0);
    assert.doesNotMatch(run(root, ['check']).err, HINT);
  }
  {
    const { root } = sealRepo();
    mkdirSync(join(root, '.husky'));
    assert.doesNotMatch(run(root, ['check']).err, HINT);
  }
  {
    const { root, git } = sealRepo();
    git('config', 'core.hooksPath', '.githooks');
    assert.doesNotMatch(run(root, ['check']).err, HINT);
  }
  {
    const { root } = sealRepo();
    assert.doesNotMatch(run(root, ['check'], { env: { GITHUB_ACTIONS: 'true' } }).err, HINT);
    // CI does not use up the one-time hint.
    assert.match(run(root, ['check']).err, HINT);
  }
  {
    // git runs hooks with GIT_INDEX_FILE set; a hook of the person's own that calls check is not nagged.
    const { root, git } = sealRepo();
    git('add', '-A');
    assert.doesNotMatch(run(root, ['check', '--staged'], { env: { GIT_INDEX_FILE: join(root, '.git/index') } }).err, HINT);
  }
  {
    // A pre-commit hook of their own that already calls review-seal.
    const { root } = sealRepo();
    writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nnpx review-seal check --staged\n');
    assert.doesNotMatch(run(root, ['check']).err, HINT);
  }
});
