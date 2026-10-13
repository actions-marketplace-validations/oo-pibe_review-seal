import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const list = (s) => s.split('\0').filter(Boolean);

export function repoRoot(cwd) {
  try { return git(['rev-parse', '--show-toplevel'], cwd).trim(); } catch { return null; }
}
export const stagedFiles = (root) => list(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root));
export const stagedContent = (root, file) => git(['show', `:${file}`], root);
export const stagedDiff = (root, file) => git(['diff', '--cached', '-U0', '--no-color', '--', file], root);
export const trackedAndUntracked = (root) => list(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root));
export const changedSince = (root, ref) => list(git(['diff', '--name-only', '--diff-filter=ACMR', '-z', `${ref}...HEAD`], root));
export const gitPath = (root, name) => resolve(root, git(['rev-parse', '--git-path', name], root).trim());
export const stageFile = (root, file) => git(['add', '--', file], root);
