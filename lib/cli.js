import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, chmodSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from './hash.js';
import { loadConfig, passesFor, ConfigError, CONFIG_PATH } from './config.js';
import { loadLedger, parseLedger, saveLedger, makeEntry, LedgerError } from './ledger.js';
import { classifyChange } from './classify.js';
import { evaluate, needsReview } from './evaluate.js';
import { repoRoot, stagedFiles, stagedContent, stagedDiff, changedSince, gitPath, gitCommonDir, stageFile, stagedFileOrNull } from './git.js';
import { coveredFiles, rubricHashes } from './files.js';
import { reviewFiles, today, STATE_DIR } from './review.js';
import { readVerdict, extractVerdict } from './reviewer.js';
import { runHook } from './hook.js';

export const VERSION = '0.1.0';
const BIN_PATH = fileURLToPath(new URL('../bin/review-seal.js', import.meta.url));
const HOOK_MARKER = '# review-seal pre-commit hook';

class UsageError extends Error {}
class RefusedError extends Error {}

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);

const USAGE = `review-seal ${VERSION}: prove each version of a file got an independent review

  review-seal init                        set up .seal/ in this repo
  review-seal review <files…> | --all | --changed-since <ref>
                                          run the independent reviewer on files that need it
  review-seal check [--staged | --changed-since <ref> | <files…>]
                                          exit 1 if a covered file lacks a fresh review
  review-seal list                        every covered file and its review status
  review-seal seal <file> --pass <p> --reviewer builder --verdict clean|findings [--finding "…"]
  review-seal seal <file> --pass <p> --reviewer independent --evidence <verdict.json>
                                          record a review by hand
  review-seal install-hook                add the git pre-commit hook
  review-seal hash <file>                 print a file's content hash
`;

const BOOL = new Set(['staged', 'all', 'auto', 'force']);
const FLAGS = {
  init: [], hash: [], list: [],
  check: ['staged', 'changed-since'],
  review: ['all', 'changed-since', 'auto'],
  seal: ['pass', 'reviewer', 'verdict', 'finding', 'evidence'],
  'install-hook': ['force'],
};
function parseArgs(argv, allowed) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!allowed.includes(k)) throw new UsageError(`unknown flag --${k} (try --help)`);
    if (BOOL.has(k)) {
      if (eq !== -1) throw new UsageError(`--${k} does not take a value`);
      flags[k] = [true];
      continue;
    }
    let v;
    if (eq !== -1) v = a.slice(eq + 1);
    else {
      v = argv[i + 1];
      if (v !== undefined && v.startsWith('--')) v = undefined;
      else i++;
    }
    if (v === undefined || v === '') throw new UsageError(`--${k} needs a value`);
    (flags[k] ??= []).push(v);
  }
  return { pos, has: (k) => k in flags, one: (k) => flags[k]?.at(-1), all: (k) => flags[k] || [] };
}

function rootOrDie() {
  const r = repoRoot(process.cwd());
  if (!r) throw new UsageError('not inside a git repository');
  return r;
}
function configOrDie(root) {
  const c = loadConfig(root);
  if (!c) throw new UsageError(`no ${CONFIG_PATH} here; run "review-seal init" first`);
  return c;
}
// git.js refuses refs that look like options, and git fails on unknown refs; both are bad usage.
function changedSinceOrDie(root, ref) {
  try { return changedSince(root, ref); } catch { throw new UsageError(`"${ref}" is not a valid git ref`); }
}
function readUserFile(p) {
  try { return readFileSync(resolve(process.cwd(), p), 'utf8'); } catch (e) { throw new UsageError(`cannot read ${p}: ${e.code || e.message}`); }
}
const toRepoPath = (root, p) => relative(root, resolve(process.cwd(), p)).split(sep).join('/');
function repoPathOrDie(root, p) {
  const f = toRepoPath(root, p);
  if (!f || isAbsolute(f) || f === '..' || f.startsWith('../')) throw new UsageError(`${p} is outside the repository`);
  return f;
}
const readRepo = (root, f) => readFileSync(join(root, f), 'utf8');

export async function main(argv) {
  const [cmd, ...rest] = argv;
  // review and check can run reviewers; reviewer.js kills them from an 'exit' handler,
  // which only runs if a signal ends the process through process.exit.
  if (cmd === 'review' || cmd === 'check') {
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(143));
  }
  try {
    if (cmd in FLAGS && (rest.includes('--help') || rest.includes('-h'))) { out(USAGE); return 0; }
    const args = () => parseArgs(rest, FLAGS[cmd]);
    switch (cmd) {
      case 'init': args(); return cmdInit();
      case 'hash': return cmdHash(args());
      case 'check': return await cmdCheck(args());
      case 'list': args(); return cmdList();
      case 'seal': return cmdSeal(args());
      case 'review': return await cmdReview(args());
      case 'install-hook': return cmdInstallHook(args());
      case 'hook': return await cmdHook(rest[0]);
      case '--version': case '-v': out(VERSION + '\n'); return 0;
      case 'help': case '--help': case '-h': out(USAGE); return 0;
      case undefined: err(USAGE); return 2;
      default: throw new UsageError(`unknown command "${cmd}" (try --help)`);
    }
  } catch (e) {
    if (e instanceof RefusedError) { err(`review-seal: refused: ${e.message}\n`); return 3; }
    if (e instanceof UsageError || e instanceof ConfigError || e instanceof LedgerError) { err(`review-seal: ${e.message}\n`); return 2; }
    throw e;
  }
}

const STARTER_CONFIG = { passes: { review: { rubric: '.seal/rubrics/review.md', files: ['docs/**/*.md'] } }, autoReview: 'stop' };
const STARTER_RUBRIC = `# Review checklist

You are reading this file cold. Report a finding for each of these:

- A sentence that contradicts another sentence in the same file.
- A claim that contradicts another file in this repository.
- A step a newcomer could not follow as written.

Do not report style preferences.
`;

function cmdInit() {
  const root = rootOrDie();
  const cfgPath = join(root, CONFIG_PATH);
  if (existsSync(cfgPath)) throw new UsageError(`${CONFIG_PATH} already exists; not overwriting`);
  mkdirSync(join(root, '.seal/rubrics'), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(STARTER_CONFIG, null, 2) + '\n');
  const rubric = join(root, '.seal/rubrics/review.md');
  if (!existsSync(rubric)) writeFileSync(rubric, STARTER_RUBRIC);
  const ledger = join(root, '.seal/ledger.json');
  if (!existsSync(ledger)) writeFileSync(ledger, '{}\n');
  const gi = join(root, '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes('.seal/.state/')) appendFileSync(gi, (cur && !cur.endsWith('\n') ? '\n' : '') + '.seal/.state/\n');
  out(`Created ${CONFIG_PATH}, .seal/rubrics/review.md and .seal/ledger.json.\nPoint "files" at what needs review, then run: review-seal install-hook\n`);
  return 0;
}

function cmdHash(a) {
  const [p] = a.pos;
  if (!p) throw new UsageError('usage: review-seal hash <file>');
  out(contentHash(readUserFile(p)) + '\n');
  return 0;
}

async function cmdCheck(a) {
  const root = rootOrDie();
  const staged = a.has('staged');
  // The pre-commit hook may outlive the setup (or run in a clone without it): no config, nothing to check.
  if (staged && !loadConfig(root)) return 0;
  const cfg = configOrDie(root);
  const since = a.one('changed-since');
  let files;
  if (staged) files = stagedFiles(root);
  else if (since) files = changedSinceOrDie(root, since);
  else if (a.pos.length) files = a.pos.map((p) => repoPathOrDie(root, p));
  else files = coveredFiles(root, cfg);
  files = files.filter((f) => passesFor(f, cfg).length && (staged || existsSync(join(root, f))));
  if (!files.length) return 0;

  const hashes = new Map(files.map((f) => [f, contentHash(staged ? stagedContent(root, f) : readRepo(root, f))]));
  // Reviews run on the working copy, so a file staged only in part cannot be reviewed for this commit.
  const partial = new Set(staged ? files.filter((f) => !existsSync(join(root, f)) || contentHash(readRepo(root, f)) !== hashes.get(f)) : []);

  if (staged && cfg.autoReview === 'commit') {
    const whole = files.filter((f) => !partial.has(f));
    const r = whole.length ? await reviewFiles(root, cfg, whole, { log: (m) => err(`review-seal: ${m}\n`) }) : { reviewed: [] };
    if (r.reviewed.length) stageFile(root, cfg.ledger);
  }

  const rh = rubricHashes(root, cfg);
  const items = files.map((f) => ({
    file: f,
    rubricHashes: rh,
    contentHash: hashes.get(f),
    change: staged ? classifyChange(stagedDiff(root, f), cfg.substantive) : { substantive: true, why: 'explicit check' },
  }));
  let r;
  if (staged) {
    // Judge the commit as it will land: the ledger in the index, not the one on disk.
    const indexLedger = () => { const t = stagedFileOrNull(root, cfg.ledger); return t === null ? {} : parseLedger(t, cfg); };
    r = evaluate(items, indexLedger(), cfg);
    if (r.blocks.length && !evaluate(items, loadLedger(root, cfg), cfg).blocks.length) {
      // The reviews exist on disk but were not staged: carry them in this commit.
      stageFile(root, cfg.ledger);
      err(`review-seal: staged ${cfg.ledger} so this commit carries its reviews\n`);
      r = evaluate(items, indexLedger(), cfg);
    }
  } else {
    r = evaluate(items, loadLedger(root, cfg), cfg);
  }
  for (const w of r.warnings) {
    err(`  ${w.reason === 'findings' ? 'FLAG' : 'WARN'}   ${w.file} [${w.pass}] ${w.message}\n`);
    // On GitHub Actions, open findings also show as warning annotations on the pull request.
    if (w.reason === 'findings' && process.env.GITHUB_ACTIONS === 'true') {
      for (const f of w.findings) out(`::warning file=${ghProp(w.file)},title=${ghProp(`review-seal ${w.pass}`)}::${ghData(f)}\n`);
    }
  }
  if (r.counts.builder) err(`  Reviews on record: ${r.counts.independent} independent, ${r.counts.builder} by the builder\n`);
  if (!r.blocks.length) return 0;
  err('\nreview-seal: these files need a fresh independent review before this commit:\n\n');
  for (const b of r.blocks) err(`  BLOCK  ${b.file} [${b.pass}] ${b.message}\n`);
  const needsReviewNow = (b) => b.reason === 'stale' || b.reason === 'never-reviewed';
  const partialNames = [...new Set(r.blocks.filter((b) => partial.has(b.file) && needsReviewNow(b)).map((b) => b.file))];
  const names = [...new Set(r.blocks.filter((b) => !partialNames.includes(b.file)).map((b) => b.file))];
  err('\n');
  for (const f of partialNames) {
    err(`  ${f}: the staged version differs from your working copy, and reviews run on the working copy. Stage the whole file (git add ${f}) or stash the rest, then commit again.\n`);
  }
  if (names.length) err(`${partialNames.length ? '\n' : ''}  Fix: let Claude finish its turn (reviews run automatically), or run:\n       review-seal review ${names.join(' ')}\n`);
  err('\n');
  return 1;
}

// GitHub workflow command escaping: data escapes % CR LF; property values also : and ,.
const ghData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const ghProp = (s) => ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function cmdList() {
  const root = rootOrDie();
  const cfg = configOrDie(root);
  const led = loadLedger(root, cfg);
  const rh = rubricHashes(root, cfg);
  const files = coveredFiles(root, cfg);
  const counts = { independent: 0, builder: 0 };
  for (const f of files) {
    out(`${f}\n`);
    const ch = contentHash(readRepo(root, f));
    for (const pass of passesFor(f, cfg)) {
      const e = (led[f] || {})[pass];
      if (!e) { out(`    ${pass.padEnd(14)} never reviewed\n`); continue; }
      const state = needsReview(f, pass, led, { contentHash: ch, rubricHash: rh[pass] }, cfg) ? 'STALE' : 'fresh';
      if (e.reviewer in counts) counts[e.reviewer]++;
      out(`    ${pass.padEnd(14)} ${state.padEnd(6)} ${e.at}  ${e.verdict}${e.findings?.length ? ` (${e.findings.length})` : ''}  ${e.reviewer}\n`);
    }
  }
  for (const f of Object.keys(led).filter((f) => !files.includes(f))) out(`${f}\n    orphaned: no longer exists or no longer covered\n`);
  out(`\n${counts.independent} independent, ${counts.builder} builder\n`);
  return 0;
}

function cmdSeal(a) {
  const root = rootOrDie();
  const cfg = configOrDie(root);
  const [p] = a.pos;
  if (!p) throw new UsageError('usage: review-seal seal <file> --pass <name> --reviewer builder|independent …');
  const file = repoPathOrDie(root, p);
  if (!existsSync(join(root, file))) throw new UsageError(`${file} does not exist`);
  const pass = a.one('pass');
  if (!pass) throw new UsageError('--pass <name> is required');
  const passes = passesFor(file, cfg);
  if (!passes.includes(pass)) throw new UsageError(`${file} has no pass named "${pass}" (its passes: ${passes.join(', ') || 'none'})`);
  const reviewer = a.one('reviewer');
  if (!['builder', 'independent'].includes(reviewer)) throw new UsageError('--reviewer must be "builder" or "independent"');
  const ch = contentHash(readRepo(root, file));
  const rh = rubricHashes(root, cfg)[pass];
  let verdict, findings, via;
  if (reviewer === 'independent') {
    const ev = a.one('evidence');
    if (!ev) throw new UsageError('--reviewer independent needs --evidence <file> with the reviewer\'s JSON verdict');
    const text = readUserFile(ev);
    const r = readVerdict(text, { file, pass, contentHash: ch, rubricHash: rh });
    if (r.error === 'mismatch') {
      // Say which field differs, from the last well-formed verdict in the evidence.
      const o = extractVerdict(text);
      if (o && (o.file !== file || o.pass !== pass)) throw new RefusedError(`the evidence is for ${o.file} [${o.pass}], not ${file} [${pass}]`);
      if (o && o.contentHash !== ch) throw new RefusedError(`the evidence was produced for a different version of ${file}`);
      if (o && o.rubricHash !== rh) throw new RefusedError(`the evidence was produced against a different version of the ${pass} checklist`);
      throw new RefusedError(`the evidence does not match ${file} [${pass}] at this version`);
    }
    if (!r.verdict) throw new RefusedError('could not read a verdict from the evidence file');
    ({ verdict, findings } = r.verdict);
    via = 'agent';
  } else {
    verdict = a.one('verdict');
    findings = a.all('finding');
    via = 'manual';
    if (!['clean', 'findings'].includes(verdict)) throw new UsageError('--verdict must be "clean" or "findings"');
    if (verdict === 'findings' && !findings.length) throw new UsageError('--verdict findings needs at least one --finding');
    if (verdict === 'clean' && findings.length) throw new UsageError('--verdict clean takes no --finding; use --verdict findings');
  }
  const led = loadLedger(root, cfg);
  led[file] = { ...(led[file] || {}), [pass]: makeEntry(file, pass, { at: today(), contentHash: ch, rubricHash: rh, verdict, findings, reviewer, via }) };
  saveLedger(root, cfg, led);
  out(`sealed ${file} [${pass}] ${verdict}${findings.length ? ` (${findings.length} findings)` : ''} by ${reviewer}\n`);
  return 0;
}

async function cmdReview(a) {
  const root = rootOrDie();
  const cfg = configOrDie(root);
  let files;
  if (a.has('all')) files = coveredFiles(root, cfg);
  else if (a.one('changed-since')) files = changedSinceOrDie(root, a.one('changed-since'));
  else if (a.pos.length) {
    files = a.pos.map((p) => {
      const f = repoPathOrDie(root, p);
      if (!existsSync(join(root, f))) throw new UsageError(`${p} does not exist`);
      return f;
    });
  } else throw new UsageError('name the files to review, or pass --all or --changed-since <ref>');
  files = files.filter((f) => passesFor(f, cfg).length);
  const auto = a.has('auto');
  if (auto) mkdirSync(join(root, STATE_DIR), { recursive: true });
  const log = auto
    ? (m) => appendFileSync(join(root, STATE_DIR, 'review.log'), `${new Date().toISOString()} ${m}\n`)
    : (m) => err(m + '\n');
  const r = await reviewFiles(root, cfg, files, { log, max: auto ? cfg.maxFilesPerRun : Infinity });
  if (!auto) {
    for (const x of r.reviewed) {
      out(`${x.file} [${x.pass}] ${x.verdict}\n`);
      for (const f of x.findings) out(`    ${f}\n`);
    }
    if (!r.reviewed.length && !r.failed.length && !r.skipped) out('nothing needs review\n');
  }
  return r.failed.length || r.skipped ? 1 : 0;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function hookScript() {
  return `#!/bin/sh
${HOOK_MARKER}. Re-run \`review-seal install-hook\` to refresh.
if [ -x ./node_modules/.bin/review-seal ]; then exec ./node_modules/.bin/review-seal check --staged; fi
if command -v review-seal >/dev/null 2>&1; then exec review-seal check --staged; fi
if [ -f ${shq(BIN_PATH)} ] && command -v node >/dev/null 2>&1; then exec node ${shq(BIN_PATH)} check --staged; fi
if [ -x ${shq(process.execPath)} ]; then exec ${shq(process.execPath)} ${shq(BIN_PATH)} check --staged; fi
echo "review-seal: could not find node or review-seal. Install review-seal (npm i -D review-seal) or re-run install-hook." >&2
exit 1
`;
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (dir, p) => p === dir || p.startsWith(dir + sep);

function cmdInstallHook(a) {
  const root = rootOrDie();
  const managers = [
    ['.husky', 'husky: add "review-seal check --staged" to .husky/pre-commit'],
    ['lefthook.yml', 'lefthook: add a pre-commit command running "review-seal check --staged"'],
    ['.pre-commit-config.yaml', 'pre-commit: add the review-seal hook (README, "pre-commit")'],
  ].filter(([f]) => existsSync(join(root, f)));
  if (managers.length) {
    out('Found a hook manager, so not writing .git/hooks directly:\n');
    for (const [, m] of managers) out(`  ${m}\n`);
    return 0;
  }
  const hooksDir = gitPath(root, 'hooks');
  const h = real(hooksDir);
  if (!a.has('force') && !within(real(gitCommonDir(root)), h) && !within(real(root), h)) {
    throw new UsageError(`git runs hooks for this repository from ${hooksDir}, which is outside this repository; a pre-commit hook there would affect other repositories too. Re-run with --force to install it anyway.`);
  }
  const target = join(hooksDir, 'pre-commit');
  if (existsSync(target) && !readFileSync(target, 'utf8').includes(HOOK_MARKER)) {
    out(`${target} already exists. Add this line to it:\n  review-seal check --staged\n`);
    return 0;
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(target, hookScript());
  chmodSync(target, 0o755);
  out(`Installed ${target}\n`);
  return 0;
}

async function cmdHook(event) {
  let input = '';
  try { input = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  const r = await runHook(event, BIN_PATH, input);
  if (r.out) out(r.out);
  return 0;
}
