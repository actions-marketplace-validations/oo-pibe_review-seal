import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// literal: false only for commands that reject pathspec magic (check-ignore takes plain paths anyway).
const git = (args, cwd, { env = process.env, input, literal = true, encoding = 'utf8' } = {}) => execFileSync('git', args, {
  cwd, env: literal ? { ...env, GIT_LITERAL_PATHSPECS: '1' } : env, encoding, maxBuffer: 64 * 1024 * 1024,
  input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
});
const list = (s) => s.split('\0').filter(Boolean);

export function repoRoot(cwd) {
  try { return git(['rev-parse', '--show-toplevel'], cwd).trim(); } catch { return null; }
}
// Paths from `diff --raw -z --no-renames` output (":old new oldsha newsha S\0path\0"), symlinks (mode 120000) left out.
function rawPaths(out) {
  const parts = out.split('\0');
  const paths = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i].split(' ')[1] !== '120000') paths.push(parts[i + 1]);
  }
  return paths;
}
export const stagedFiles = (root) => rawPaths(git(['diff', '--cached', '--raw', '--no-renames', '--diff-filter=ACMRT', '-z'], root));
export const stagedContent = (root, file) => git(['cat-file', 'blob', `:0:${file}`], root);
// The staged blob's bytes (a Buffer), for hashing.
export const stagedBytes = (root, file) => git(['cat-file', 'blob', `:0:${file}`], root, { encoding: 'buffer' });
export const stagedDiff = (root, file) => git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--', file], root);
export const trackedAndUntracked = (root) => list(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root));
export function changedSince(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('invalid ref');
  return rawPaths(git(['diff', '--raw', '--no-renames', '--diff-filter=ACMRT', '-z', '--end-of-options', `${ref}...HEAD`, '--'], root));
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
// Paths that differ from HEAD in the index or working tree, untracked files included (ignored ones are not).
// With -z a rename or copy is "XY new\0old\0"; only the new path is kept.
export function workingTreeChanges(root) {
  // GIT_OPTIONAL_LOCKS=0: status must not take index.lock, or it could collide with the user's own git commands.
  const parts = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return out;
}
// Does git ignore this repo path? check-ignore exits 0 when it does, 1 when it does not.
export function isIgnored(root, file) {
  const { GIT_LITERAL_PATHSPECS, ...env } = process.env;
  try { git(['check-ignore', '-q', '--', file], root, { env, literal: false }); return true; } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}
