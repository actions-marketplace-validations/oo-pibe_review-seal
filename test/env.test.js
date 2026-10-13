import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpRepo } from './helpers.js';

test('files tests pass even with inherited git env pointing at another repo', () => {
  const other = tmpRepo({ 'a.txt': 'a\n' });
  other.git('add', '-A');
  const base = { ...process.env };
  delete base.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', new URL('./files.test.js', import.meta.url).pathname], {
    encoding: 'utf8',
    env: { ...base, GIT_INDEX_FILE: join(other.root, '.git', 'index'), GIT_DIR: join(other.root, '.git'), CLAUDECODE: '1' },
  });
  assert.match(r.stdout, /^ℹ pass [1-9]/m);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
