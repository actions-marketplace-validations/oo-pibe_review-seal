import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './hash.js';
import { passesFor } from './config.js';
import { loadLedger, saveLedger, makeEntry } from './ledger.js';
import { needsReview } from './evaluate.js';
import { rubricHashes } from './files.js';
import { runReviewer } from './reviewer.js';

export const STATE_DIR = '.seal/.state';
const LOCK_STALE_MS = 15 * 60 * 1000;

export const today = () => new Date().toISOString().slice(0, 10);

export function pendingJobs(root, cfg, files) {
  const led = loadLedger(root, cfg);
  const rh = rubricHashes(root, cfg);
  const jobs = [];
  for (const file of files) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const ch = contentHash(readFileSync(abs, 'utf8'));
    for (const pass of passesFor(file, cfg)) {
      if (needsReview(file, pass, led, { contentHash: ch, rubricHash: rh[pass] }, cfg)) {
        jobs.push({ file, pass, rubricPath: cfg.passes[pass].rubric, contentHash: ch, rubricHash: rh[pass] });
      }
    }
  }
  return jobs;
}

function acquireLock(root) {
  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'review.lock');
  if (existsSync(p) && Date.now() - statSync(p).mtimeMs < LOCK_STALE_MS) return null;
  writeFileSync(p, String(process.pid));
  return () => { try { unlinkSync(p); } catch { /* already gone */ } };
}

export function appendInbox(root, items) {
  if (!items.length) return;
  const p = join(root, STATE_DIR, 'inbox.json');
  let cur = [];
  try { cur = JSON.parse(readFileSync(p, 'utf8')); } catch { /* empty */ }
  cur.push(...items);
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  writeFileSync(p, JSON.stringify(cur, null, 2));
}

export function drainInbox(root) {
  const p = join(root, STATE_DIR, 'inbox.json');
  try {
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    unlinkSync(p);
    return cur;
  } catch { return []; }
}

export async function reviewFiles(root, cfg, files, { log = () => {}, run = runReviewer, max = cfg.maxFilesPerRun } = {}) {
  const release = acquireLock(root);
  if (!release) { log('another review is already running; skipping'); return { reviewed: [], failed: [], remaining: 0, skipped: 'locked' }; }
  try {
    const all = pendingJobs(root, cfg, files);
    const keep = new Set([...new Set(all.map((j) => j.file))].slice(0, max));
    const jobs = all.filter((j) => keep.has(j.file));
    const reviewed = [];
    const failed = [];
    for (const job of jobs) {
      log(`reviewing ${job.file} [${job.pass}]`);
      const r = await run(job, { root, model: cfg.model, timeoutSeconds: cfg.timeoutSeconds });
      if (!r.ok) { failed.push({ ...job, error: r.error }); log(`  not reviewed: ${r.error}`); continue; }
      const v = r.verdict;
      if (v.file !== job.file || v.pass !== job.pass || v.contentHash !== job.contentHash || v.rubricHash !== job.rubricHash) {
        failed.push({ ...job, error: 'the reviewer reported on a different version or file' });
        continue;
      }
      if (contentHash(readFileSync(join(root, job.file), 'utf8')) !== job.contentHash) {
        failed.push({ ...job, error: 'the file changed during review; it will be reviewed again next time' });
        continue;
      }
      const led = loadLedger(root, cfg);
      led[job.file] = {
        ...(led[job.file] || {}),
        [job.pass]: makeEntry(job.file, job.pass, { at: today(), contentHash: job.contentHash, rubricHash: job.rubricHash, verdict: v.verdict, findings: v.findings, reviewer: 'independent', via: 'agent' }),
      };
      saveLedger(root, cfg, led);
      reviewed.push({ ...job, verdict: v.verdict, findings: v.findings });
      log(`  ${v.verdict}${v.findings.length ? ` (${v.findings.length} finding${v.findings.length === 1 ? '' : 's'})` : ''}`);
    }
    appendInbox(root, [
      ...reviewed.filter((x) => x.verdict === 'findings').map(({ file, pass, findings }) => ({ file, pass, findings })),
      ...failed.map(({ file, pass, error }) => ({ file, pass, error })),
    ]);
    return { reviewed, failed, remaining: all.length - jobs.length };
  } finally {
    release();
  }
}
