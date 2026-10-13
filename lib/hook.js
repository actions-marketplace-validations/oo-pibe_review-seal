import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './git.js';
import { loadConfig, passesFor, CONFIG_PATH } from './config.js';
import { loadLedger } from './ledger.js';
import { contentHash } from './hash.js';
import { needsReview } from './evaluate.js';
import { coveredFiles, rubricHashes } from './files.js';
import { drainInbox, ensureStateDir, STATE_DIR } from './review.js';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const posix = (p) => p.split(sep).join('/');

// The real path of p, or of its nearest existing ancestor with the rest appended (a new file has no real path yet).
function real(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* missing */ }
  const parent = dirname(abs);
  return parent === abs ? abs : join(real(parent), basename(abs));
}
// The repo-relative path of abs, or null when it is outside root.
function inRepo(root, abs) {
  const rel = relative(root, abs);
  return !rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) ? null : posix(rel);
}

// Bash is watched as well as the edit tools: agents often change files through a shell heredoc,
// and a hook that only matched Write|Edit never saw those edits.
// Claude Code may name the repo through an alias (a symlink, or /var for /private/var on macOS), while git
// reports its real path, so paths are matched in every form the repo can be named by.
export function touchedFiles(payload, root, covered) {
  const ti = payload.tool_input || {};
  const cwd = resolve(root, payload.cwd || root);
  const realRoot = real(root);
  const realCwd = real(cwd);
  // The repo root as named from cwd's side, when cwd is inside the repo under an alias.
  const cwdInRepo = inRepo(realRoot, realCwd) !== null || realCwd === realRoot;
  const roots = [...new Set([root, realRoot, ...(cwdInRepo ? [resolve(cwd, relative(realCwd, realRoot))] : [])])];
  if (EDIT_TOOLS.has(payload.tool_name)) {
    const p = ti.file_path || ti.notebook_path;
    if (!p) return [];
    const abs = resolve(cwd, String(p));
    for (const r of roots) {
      const rel = inRepo(r, abs);
      if (rel && covered.includes(rel)) return [rel];
    }
    const rel = inRepo(realRoot, real(abs));
    return rel && covered.includes(rel) ? [rel] : [];
  }
  if (payload.tool_name === 'Bash') {
    const cmd = String(ti.command || '');
    return covered.filter((f) => {
      if (cmd.includes(f) || roots.some((r) => cmd.includes(join(r, f)))) return true;
      const fromCwd = posix(relative(realCwd, join(realRoot, f)));
      return !fromCwd.startsWith('..') && !isAbsolute(fromCwd) && cmd.includes(fromCwd);
    });
  }
  return [];
}

const sessionFile = (root, id) => join(root, STATE_DIR, `session-${String(id || 'none').replace(/[^\w-]/g, '_')}.json`);
function readSession(root, id) {
  try {
    const s = JSON.parse(readFileSync(sessionFile(root, id), 'utf8'));
    return { touched: Array.isArray(s.touched) ? s.touched : [], briefed: Array.isArray(s.briefed) ? s.briefed : [] };
  } catch { return { touched: [], briefed: [] }; }
}
function writeSession(root, id, s) {
  ensureStateDir(root);
  writeFileSync(sessionFile(root, id), JSON.stringify(s));
}
const context = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
const hashOf = (root, f) => contentHash(readFileSync(join(root, f), 'utf8'));

export function onPostTool(payload, root, cfg) {
  const touched = touchedFiles(payload, root, coveredFiles(root, cfg));
  if (!touched.length) return '';
  const s = readSession(root, payload.session_id);
  const led = loadLedger(root, cfg);
  const rh = rubricHashes(root, cfg);
  const next = cfg.autoReview === 'off' ? 'Run "review-seal review <file>" before committing.' : 'An independent review will run when you finish this turn.';
  const lines = [];
  for (const f of touched) {
    if (!s.touched.includes(f)) s.touched.push(f);
    const ch = hashOf(root, f);
    for (const pass of passesFor(f, cfg)) {
      if (needsReview(f, pass, led, { contentHash: ch, rubricHash: rh[pass] }, cfg)) lines.push(`${f} [${pass}]: review is now out of date. ${next}`);
      if (!s.briefed.includes(pass)) {
        s.briefed.push(pass);
        lines.push(`The "${pass}" reviewer checks files like ${f} against this checklist:\n${readFileSync(join(root, cfg.passes[pass].rubric), 'utf8').trim()}`);
      }
    }
  }
  writeSession(root, payload.session_id, s);
  return lines.length ? context('PostToolUse', `review-seal:\n${lines.join('\n')}`) : '';
}

export function onStop(payload, root, cfg, binPath) {
  if (cfg.autoReview === 'off') return '';
  const s = readSession(root, payload.session_id);
  const led = loadLedger(root, cfg);
  const rh = rubricHashes(root, cfg);
  const stale = s.touched.filter((f) => existsSync(join(root, f)) && passesFor(f, cfg).some((p) => needsReview(f, p, led, { contentHash: hashOf(root, f), rubricHash: rh[p] }, cfg)));
  if (!stale.length) return '';
  // Detached so the session never waits for the reviewer.
  const child = spawn(process.execPath, [binPath, 'review', '--auto', '--', ...stale], { cwd: root, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return '';
}

export function onUserPrompt(payload, root) {
  const items = drainInbox(root);
  if (!items.length) return '';
  const lines = items.map((i) => (i.error
    ? `${i.file} [${i.pass}]: the review could not run (${i.error}).`
    : `${i.file} [${i.pass}]: the independent reviewer found:\n${(i.findings || []).map((f) => `  - ${f}`).join('\n')}`));
  return context('UserPromptSubmit', `review-seal results since your last turn:\n${lines.join('\n')}\nFixing a finding changes the file, so it will be reviewed again automatically.`);
}

// A hook must never stall or break a session: every failure is silent and exits 0.
export async function runHook(event, binPath, stdinText) {
  const none = { out: '', code: 0 };
  if (process.env.REVIEW_SEAL_CHILD) return none;
  try {
    const payload = JSON.parse(stdinText || '{}');
    if (!payload || typeof payload !== 'object') return none;
    const root = repoRoot(payload.cwd || process.cwd());
    if (!root || !existsSync(join(root, CONFIG_PATH))) return none;
    const cfg = loadConfig(root);
    if (event === 'post-tool') return { out: onPostTool(payload, root, cfg), code: 0 };
    if (event === 'stop') return { out: onStop(payload, root, cfg, binPath), code: 0 };
    if (event === 'user-prompt') return { out: onUserPrompt(payload, root), code: 0 };
    return none;
  } catch (e) {
    if (process.env.REVIEW_SEAL_DEBUG) process.stderr.write(`review-seal hook: ${e.stack}\n`);
    return none;
  }
}
