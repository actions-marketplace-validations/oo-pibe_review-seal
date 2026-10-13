import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const git = (args, cwd, { env = process.env, input } = {}) => execFileSync('git', args, {
  cwd, env: { ...env, GIT_LITERAL_PATHSPECS: '1' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
});
const list = (s) => s.split('\0').filter(Boolean);

export function repoRoot(cwd) {
  try { return git(['rev-parse', '--show-toplevel'], cwd).trim(); } catch { return null; }
}
export const stagedFiles = (root) => list(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root));
export const stagedContent = (root, file) => git(['cat-file', 'blob', `:0:${file}`], root);
export const stagedDiff = (root, file) => git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--', file], root);
export const trackedAndUntracked = (root) => list(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root));
export function changedSince(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('invalid ref');
  return list(git(['diff', '--name-only', '--diff-filter=ACMR', '-z', '--end-of-options', `${ref}...HEAD`, '--'], root));
}
export const gitPath = (root, name) => resolve(root, git(['rev-parse', '--git-path', name], root).trim());
// env selects the index (GIT_INDEX_FILE); it defaults to this process's environment.
export function stagedFileOrNull(root, file, env) {
  try { return git(['cat-file', 'blob', `:0:${file}`], root, { env }); } catch { return null; }
}
export function stageBlob(root, path, content, env) {
  const sha = git(['hash-object', '-w', '--stdin'], root, { env, input: content }).trim();
  git(['update-index', '--add', '--cacheinfo', `100644,${sha},${path}`], root, { env });
}
export const indexPath = (root, env) => resolve(root, git(['rev-parse', '--git-path', 'index'], root, { env }).trim());
export const gitCommonDir = (root) => resolve(root, git(['rev-parse', '--git-common-dir'], root).trim());
export const stageFile = (root, file) => git(['add', '--', file], root);
