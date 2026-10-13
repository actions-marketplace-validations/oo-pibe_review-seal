import { readFileSync, readdirSync, lstatSync, appendFileSync, renameSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, utimesSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { contentHash } from './hash.js';
import { passesFor, assertInsideReal } from './config.js';
import { loadLedger, saveLedger, makeEntry } from './ledger.js';
import { needsReview } from './evaluate.js';
import { rubricHashes, reviewByOf } from './files.js';
import { runReviewer } from './reviewer.js';
import { writeBlob } from './git.js';

export const STATE_DIR = '.seal/.state';

// A path in the state directory (or the directory itself), refused if it goes through a symlink.
export const statePath = (root, name) => assertInsideReal(root, name ? `${STATE_DIR}/${name}` : STATE_DIR);

export const today = () => new Date().toISOString().slice(0, 10);

// Failed reviews back off so a broken reviewer is not rerun at the end of every turn. A record is keyed by
// file, pass and content hash, so changing the file starts over.
const FAILURES = 'failures.json';
const BACKOFF_MS = 10 * 60 * 1000;
const MAX_FAILURES = 3;
const FAILURE_TTL_MS = 7 * 24 * 3600 * 1000;
export const failureKey = (job) => `${job.file}|${job.pass}|${job.contentHash}`;

export function readFailures(root) {
  try {
    const o = JSON.parse(readFileSync(statePath(root, FAILURES), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

function writeFailures(root, f) {
  ensureStateDir(root);
  const p = statePath(root, FAILURES);
  const tmp = `${p}.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(f));
  renameSync(tmp, p);
}

export function backedOff(failures, job, now = Date.now()) {
  const f = failures[failureKey(job)];
  if (!f) return false;
  if (f.failures >= MAX_FAILURES) return true;
  const t = Date.parse(f.lastAt);
  return Number.isFinite(t) && now - t < BACKOFF_MS;
}

export function pendingJobs(root, cfg, files, { backoff = false, expiry = true } = {}) {
  const led = loadLedger(root, cfg);
  const rh = rubricHashes(root, cfg);
  const failures = backoff ? readFailures(root) : {};
  const jobs = [];
  for (const file of files) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const bytes = readFileSync(abs);
    const ch = contentHash(bytes);
    const text = bytes.toString('utf8');
    // Reviews past their shelf life are due too, unless the caller ignores shelf life (review --all).
    const opts = expiry ? { today: today(), reviewBy: reviewByOf(text) } : {};
    for (const pass of passesFor(file, cfg)) {
      if (needsReview(file, pass, led, { contentHash: ch, rubricHash: rh[pass] }, cfg, opts)) {
        const job = { file, pass, rubricPath: cfg.passes[pass].rubric, contentHash: ch, rubricHash: rh[pass], tools: [...(cfg.passes[pass].tools || [])], fetchDomains: [...(cfg.passes[pass].fetchDomains || [])] };
        if (!backedOff(failures, job)) jobs.push(job);
      }
    }
  }
  return jobs;
}

function holderAlive(p) {
  let pid;
  try {
    const raw = readFileSync(p, 'utf8').trim();
    try { const j = JSON.parse(raw); pid = typeof j === 'number' ? j : j?.pid; } catch { /* not JSON */ }
  } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const LOCK_STALE_MS = (1800 + 60) * 1000;

function acquireLock(root) {
  ensureStateDir(root);
  const p = statePath(root, 'review.lock');
  const me = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(p, me, { flag: 'wx' });
      return {
        touch: () => {
          try {
            if (readFileSync(p, 'utf8') !== me) return false;
            const n = new Date();
            utimesSync(p, n, n);
            return true;
          } catch { return false; }
        },
        release: () => { try { if (readFileSync(p, 'utf8') === me) unlinkSync(p); } catch { /* already gone */ } },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let judged = null;
      try { judged = readFileSync(p, 'utf8'); } catch { /* vanished */ }
      let fresh = false;
      try { fresh = Date.now() - statSync(p).mtimeMs < LOCK_STALE_MS; } catch { /* vanished */ }
      if (fresh && holderAlive(p)) return null;
      try {
        if (readFileSync(p, 'utf8') === judged) unlinkSync(p);
      } catch { /* raced */ }
    }
  }
  return null;
}

// The reviewed bytes as a git object, so the commit check can measure later edits against them. Without one
// (the object store is read-only, say) the entry is still recorded, and any later edit counts as substantive.
export function storeReviewed(root, file, bytes) {
  try { return writeBlob(root, file, bytes); } catch { return undefined; }
}

export function ensureStateDir(root) {
  const dir = statePath(root);
  mkdirSync(dir, { recursive: true });
  statePath(root); // mkdir could have raced a symlink into place
  const g = statePath(root, '.gitignore');
  if (!existsSync(g)) writeFileSync(g, '*\n');
}

export function appendInbox(root, items) {
  if (!items.length) return;
  ensureStateDir(root);
  appendFileSync(statePath(root, 'inbox.jsonl'), items.map((i) => JSON.stringify(i) + '\n').join(''));
}

// With a session id, a drain takes that session's items, untagged items and items over a day old (their
// session has likely ended); the rest go back into the inbox for their own session.
const INBOX_ORPHAN_MS = 24 * 3600 * 1000;
export function drainInbox(root, sessionId) {
  const dir = statePath(root);
  const p = statePath(root, 'inbox.jsonl');
  const mine = `${p}.${process.pid}.${randomUUID()}`;
  const files = [];
  try { renameSync(p, mine); files.push(mine); } catch { /* nothing queued */ }
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('inbox.jsonl.')) continue;
      const fp = join(dir, f);
      if (fp === mine) continue;
      if (lstatSync(fp).isSymbolicLink()) continue;
      try { if (Date.now() - statSync(fp).mtimeMs > 60_000) files.push(fp); } catch { /* gone */ }
    }
  } catch { /* no state dir */ }
  const out = [];
  for (const fp of files) {
    try {
      if (lstatSync(fp).isSymbolicLink()) throw new Error('symlink');
      for (const line of readFileSync(fp, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* torn line */ }
      }
    } catch { /* claimed by another drain */ }
    try { unlinkSync(fp); } catch { /* gone */ }
  }
  if (sessionId === undefined || sessionId === null) return out;
  const now = Date.now();
  const forMe = (i) => !i || !i.session || i.session === String(sessionId) || !(now - Date.parse(i.at) < INBOX_ORPHAN_MS);
  appendInbox(root, out.filter((i) => !forMe(i)));
  return out.filter(forMe);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// lockWait { ms, pollMs }: wait that long for another run to finish (review --auto, so a second Stop queues
// behind the first instead of dropping its files). Still locked at the deadline, the session is told in its inbox
// what to run. Without lockWait a held lock skips the run at once.
export async function reviewFiles(root, cfg, files, { log = () => {}, run = runReviewer, max = cfg.maxFilesPerRun, backoff = false, session, expiry = true, lockWait = null } = {}) {
  let lock = acquireLock(root);
  if (!lock && lockWait) {
    log('another review is running; waiting for it to finish');
    const deadline = Date.now() + lockWait.ms;
    while (!lock && Date.now() < deadline) {
      await sleep(Math.max(1, Math.min(lockWait.pollMs, deadline - Date.now())));
      lock = acquireLock(root);
    }
  }
  if (!lock) {
    let pending = [];
    try { pending = pendingJobs(root, cfg, files, { backoff, expiry }); } catch { /* nothing to report */ }
    const names = [...new Set(pending.map((j) => j.file))];
    if (lockWait) {
      log('another review was still running; skipped');
      const error = `review skipped because another review was still running; run review-seal review ${names.join(' ')}`;
      const tag = { ...(session ? { session: String(session) } : {}), at: new Date().toISOString() };
      appendInbox(root, pending.map(({ file, pass }) => ({ file, pass, error, ...tag })));
    } else {
      log(`another review is already running; run review-seal review ${(names.length ? names : files).join(' ')} when it finishes`);
    }
    return { reviewed: [], failed: [], remaining: null, skipped: 'locked' };
  }
  try {
    const all = pendingJobs(root, cfg, files, { backoff, expiry });
    const keep = new Set([...new Set(all.map((j) => j.file))].slice(0, max));
    const jobs = all.filter((j) => keep.has(j.file));
    const reviewed = [];
    const failed = [];
    try {
      for (const job of jobs) {
        try {
          if (!lock.touch()) { log('lost the review lock; stopping'); break; }
          log(`reviewing ${job.file} [${job.pass}]`);
          const r = await run(job, { root, model: cfg.model, timeoutSeconds: cfg.timeoutSeconds });
          if (!r.ok) { failed.push({ ...job, error: r.error }); log(`  not reviewed: ${r.error}`); continue; }
          const v = r.verdict;
          if (v.file !== job.file || v.pass !== job.pass || v.contentHash !== job.contentHash || v.rubricHash !== job.rubricHash) {
            failed.push({ ...job, error: 'the reviewer reported on a different version or file' });
            continue;
          }
          const abs = join(root, job.file);
          if (!existsSync(abs)) {
            failed.push({ ...job, error: 'the file was removed during review' });
            continue;
          }
          const bytes = readFileSync(abs);
          if (contentHash(bytes) !== job.contentHash) {
            failed.push({ ...job, error: 'the file changed during review; it will be reviewed again next time' });
            continue;
          }
          const reviewedBlob = storeReviewed(root, job.file, bytes);
          const led = loadLedger(root, cfg);
          led[job.file] = {
            ...(led[job.file] || {}),
            [job.pass]: makeEntry(job.file, job.pass, { at: today(), contentHash: job.contentHash, rubricHash: job.rubricHash, verdict: v.verdict, findings: v.findings, reviewer: 'independent', via: 'agent', reviewedBlob }),
          };
          saveLedger(root, cfg, led);
          reviewed.push({ ...job, verdict: v.verdict, findings: v.findings });
          log(`  ${v.verdict}${v.findings.length ? ` (${v.findings.length} finding${v.findings.length === 1 ? '' : 's'})` : ''}`);
        } catch (e) {
          failed.push({ ...job, error: e.message });
          log(`  not reviewed: ${e.message}`);
        }
      }
    } finally {
      const fl = readFailures(root);
      const now = Date.now();
      for (const k of Object.keys(fl)) if (!(now - Date.parse(fl[k]?.lastAt) < FAILURE_TTL_MS)) delete fl[k];
      for (const j of reviewed) delete fl[failureKey(j)];
      for (const j of failed) {
        const k = failureKey(j);
        fl[k] = { failures: (Number(fl[k]?.failures) || 0) + 1, lastAt: new Date(now).toISOString() };
      }
      try { writeFailures(root, fl); } catch (e) { log(`could not record review failures: ${e.message}`); }
      const tag = { ...(session ? { session: String(session) } : {}), at: new Date().toISOString() };
      appendInbox(root, [
        ...reviewed.filter((x) => x.verdict === 'findings').map(({ file, pass, findings }) => ({ file, pass, findings, ...tag })),
        ...failed.map(({ file, pass, error }) => ({ file, pass, error, ...tag })),
      ]);
    }
    return { reviewed, failed, remaining: new Set(all.map((j) => j.file)).size - keep.size };
  } finally {
    lock.release();
  }
}
