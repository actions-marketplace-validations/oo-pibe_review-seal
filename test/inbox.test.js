import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, statSync, openSync, writeSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sealRepo, run } from './helpers.js';
import { appendInbox, drainInbox, ensureStateDir, STATE_DIR, INBOX_FULL_BYTES } from '../lib/review.js';

const MOD = new URL('../lib/review.js', import.meta.url).href;
const node = (code, args) => new Promise((resolve, reject) => {
  let out = '';
  const c = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  c.stdout.on('data', (d) => (out += d));
  c.on('exit', (status) => (status === 0 ? resolve(out) : reject(new Error(`child exited ${status}`))));
});
const inboxPath = (root) => join(root, STATE_DIR, 'inbox.jsonl');
const age = (p, ms) => { const t = new Date(Date.now() - ms); utimesSync(p, t, t); };

test('concurrent drains of an inbox last written over a minute ago deliver each item exactly once', async () => {
  for (let round = 0; round < 5; round++) {
    const { root } = sealRepo();
    appendInbox(root, Array.from({ length: 200 }, (_, i) => ({ file: `i${i}` })));
    age(inboxPath(root), 120_000);
    const go = String(Date.now() + 400);
    const code = `const { drainInbox } = await import(${JSON.stringify(MOD)}); const t = Number(process.argv[2]); while (Date.now() < t); process.stdout.write(JSON.stringify(drainInbox(process.argv[1]).map((i) => i.file)));`;
    const outs = await Promise.all(Array.from({ length: 6 }, () => node(code, [root, go])));
    const all = outs.flatMap((o) => JSON.parse(o)).concat(drainInbox(root).map((i) => i.file));
    assert.equal(all.length, new Set(all).size, 'duplicates');
    assert.equal(new Set(all).size, 200, 'lost items');
  }
});

test('a second drain does not take a claimed inbox while its drain waits for a writer', async () => {
  const { root } = sealRepo();
  const dir = join(root, STATE_DIR);
  appendInbox(root, [{ file: 'old-item' }]);
  age(inboxPath(root), 120_000);
  // A writer W has left its marker and opened the live inbox, but not written yet.
  const marker = join(dir, 'inbox-writing.999.w');
  writeFileSync(marker, '', { flag: 'wx' });
  const fd = openSync(inboxPath(root), 'a');
  const a = node(`const { drainInbox } = await import(${JSON.stringify(MOD)}); process.stdout.write(JSON.stringify(drainInbox(process.argv[1]).map((i) => i.file)));`, [root]);
  while (existsSync(inboxPath(root))) await new Promise((r) => setTimeout(r, 5)); // A has claimed it and is waiting
  const b = drainInbox(root).map((i) => i.file);
  writeSync(fd, JSON.stringify({ file: 'W-item' }) + '\n');
  closeSync(fd);
  unlinkSync(marker);
  const all = [...b, ...JSON.parse(await a), ...drainInbox(root).map((i) => i.file)];
  assert.deepEqual(all.sort(), ['W-item', 'old-item']);
});

test('a writer marker with a future mtime counts as stale: the drain does not wait and removes it', () => {
  const { root } = sealRepo();
  const marker = join(root, STATE_DIR, 'inbox-writing.1.dead');
  appendInbox(root, [{ file: 'x' }]);
  writeFileSync(marker, '');
  const future = new Date(Date.now() + 3600_000);
  utimesSync(marker, future, future);
  const t = Date.now();
  assert.deepEqual(drainInbox(root).map((i) => i.file), ['x']);
  assert.ok(Date.now() - t < 1000, `drain waited ${Date.now() - t} ms`);
  assert.equal(existsSync(marker), false);
});

test('an inbox past its size cap takes no clean results and one "inbox full" note for the rest', () => {
  const { root } = sealRepo();
  appendInbox(root, [{ file: 'first' }]);
  const line = JSON.stringify({ file: 'pad', type: 'clean' }) + '\n';
  writeFileSync(inboxPath(root), readFileSync(inboxPath(root), 'utf8') + line.repeat(Math.ceil(INBOX_FULL_BYTES / line.length) + 1));
  const size = statSync(inboxPath(root)).size;
  appendInbox(root, [{ file: 'c', type: 'clean' }]);
  assert.equal(statSync(inboxPath(root)).size, size, 'clean results are dropped');
  appendInbox(root, [{ file: 'f1', findings: ['x'] }, { file: 'c2', type: 'clean' }]);
  appendInbox(root, [{ file: 'f2', error: 'boom' }]);
  const tail = readFileSync(inboxPath(root), 'utf8').slice(size).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(tail.map((i) => i.type), ['full']);
  const drained = drainInbox(root);
  assert.equal(drained.filter((i) => i.type === 'full').length, 1);
  // Once drained, the inbox takes everything again, and a later overflow gets its own note.
  appendInbox(root, [{ file: 'after', type: 'clean' }]);
  assert.deepEqual(drainInbox(root).map((i) => i.file), ['after']);
  assert.deepEqual(readdirSync(join(root, STATE_DIR)).filter((f) => f.startsWith('inbox')), []);
});

test('the "inbox full" note reaches Claude as one line', () => {
  const { root } = sealRepo();
  appendInbox(root, [{ type: 'full' }]);
  const r = run(root, ['hook', 'user-prompt'], { input: JSON.stringify({ session_id: 's1', cwd: root }) });
  const c = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(c, /^review-seal: inbox full; some review results were not passed on\. Ask the user to run review-seal list\.$/m);
  assert.doesNotMatch(c, /undefined/);
});

test('a full marker left from an old inbox does not silence the note for a new one', () => {
  const { root } = sealRepo();
  ensureStateDir(root);
  const line = JSON.stringify({ file: 'pad', type: 'clean' }) + '\n';
  const overflow = () => writeFileSync(inboxPath(root), line.repeat(Math.ceil(INBOX_FULL_BYTES / line.length) + 1), { flag: 'a' });
  const notes = (p) => readFileSync(p, 'utf8').trim().split('\n').filter((l) => JSON.parse(l).type === 'full').length;
  overflow();
  appendInbox(root, [{ file: 'f1', findings: ['x'] }]);
  assert.equal(notes(inboxPath(root)), 1);
  // The old inbox goes away without a drain removing its marker (a drain that died after claiming it).
  const gone = join(root, STATE_DIR, 'old-inbox');
  renameSync(inboxPath(root), gone);
  overflow();
  appendInbox(root, [{ file: 'f2', findings: ['x'] }]);
  appendInbox(root, [{ file: 'f3', findings: ['x'] }]);
  assert.equal(notes(inboxPath(root)), 1);
  unlinkSync(gone);
  drainInbox(root);
  assert.deepEqual(readdirSync(join(root, STATE_DIR)).filter((f) => f.startsWith('inbox')), []);
});

test('a claim whose time part is not a number counts as abandoned', () => {
  const { root } = sealRepo();
  ensureStateDir(root);
  writeFileSync(join(root, STATE_DIR, 'inbox.jsonl.abc.1.x'), '{"file":"odd"}\n');
  writeFileSync(join(root, STATE_DIR, 'inbox.jsonl.'), '{"file":"bare"}\n');
  assert.deepEqual(drainInbox(root).map((i) => i.file).sort(), ['bare', 'odd']);
  assert.deepEqual(readdirSync(join(root, STATE_DIR)).filter((f) => f.startsWith('inbox')), []);
});
