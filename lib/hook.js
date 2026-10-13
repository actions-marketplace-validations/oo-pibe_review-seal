import { readFileSync, writeFileSync, existsSync, realpathSync, lstatSync } from 'node:fs';
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

// Claude Code may name the repo through an alias (a symlink, or /var for /private/var on macOS), while git
// reports its real path, so paths are matched in every form the repo can be named by.
function pathForms(payload, root) {
  const cwd = resolve(root, String(payload.cwd || root));
  const realRoot = real(root);
  const realCwd = real(cwd);
  // The repo root as named from cwd's side, when cwd is inside the repo under an alias.
  const cwdInRepo = inRepo(realRoot, realCwd) !== null || realCwd === realRoot;
  const roots = [...new Set([root, realRoot, ...(cwdInRepo ? [resolve(cwd, relative(realCwd, realRoot))] : [])])];
  return { cwd, realRoot, realCwd, roots };
}

// The repo path an edit tool wrote, if accept() takes it.
function editTarget(payload, root, accept) {
  const ti = payload.tool_input || {};
  const p = ti.file_path || ti.notebook_path;
  if (!p) return null;
  const { cwd, realRoot, roots } = pathForms(payload, root);
  const abs = resolve(cwd, String(p));
  for (const r of roots) {
    const rel = inRepo(r, abs);
    if (rel && accept(rel)) return rel;
  }
  const rel = inRepo(realRoot, real(abs));
  return rel && accept(rel) ? rel : null;
}

// Bash is watched as well as the edit tools: agents often change files through a shell heredoc,
// and a hook that only matched Write|Edit never saw those edits.
export function touchedFiles(payload, root, covered) {
  if (EDIT_TOOLS.has(payload.tool_name)) {
    const rel = editTarget(payload, root, (f) => covered.includes(f));
    return rel ? [rel] : [];
  }
  if (payload.tool_name === 'Bash') {
    const cmd = String((payload.tool_input || {}).command || '');
    const { realRoot, realCwd, roots } = pathForms(payload, root);
    return covered.filter((f) => {
      if (cmd.includes(f) || roots.some((r) => cmd.includes(join(r, f)))) return true;
      const fromCwd = posix(relative(realCwd, join(realRoot, f)));
      return !fromCwd.startsWith('..') && !isAbsolute(fromCwd) && cmd.includes(fromCwd);
    });
  }
  return [];
}

const isRegular = (root, f) => Boolean(lstatSync(join(root, f), { throwIfNoEntry: false })?.isFile());

// Literal pieces of the coverage globs ("docs", ".md"). A command containing none of them cannot name a
// covered file. Null when some glob has no such piece, so nothing can be ruled out.
function globFragments(cfg) {
  const out = [];
  for (const p of Object.values(cfg.passes)) {
    for (const g of p.files) {
      const parts = g.split(/[*?/]/).filter((x) => x.length >= 2);
      if (!parts.length) return null;
      out.push(...parts);
    }
  }
  return out;
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
  const tool = payload.tool_name;
  let touched;
  if (EDIT_TOOLS.has(tool)) {
    // Only the edited path is checked; listing the repo on every edit is slow in a large one.
    const rel = editTarget(payload, root, (f) => passesFor(f, cfg).length > 0 && isRegular(root, f));
    touched = rel ? [rel] : [];
  } else if (tool === 'Bash') {
    const cmd = String((payload.tool_input || {}).command || '');
    const frags = globFragments(cfg);
    if (frags && !frags.some((x) => cmd.includes(x))) return '';
    touched = touchedFiles(payload, root, coveredFiles(root, cfg));
  } else return '';
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
