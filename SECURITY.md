# Security

Report a vulnerability through GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Please do not open a public issue.

What counts: anything that lets a hook or the reviewer write anything other than review-seal's own state, run commands it should not, or leak file contents off the machine beyond the Claude session the user already runs. That includes reading or writing outside the repository through a symlink committed into it: review-seal refuses to follow a symlink in any of its own paths.

review-seal's own state is `.seal/`, the configured ledger and the ledger's entry in the git index. Two more writes are expected:

- Each recorded review stores the bytes the reviewer read as a git object (`git hash-object -w`), so later edits can be measured against them. Git applies your clean filters and line-ending settings to those bytes, as it would for `git add`.
- `install-hook` writes the git hooks, the merge driver's settings (`merge.review-seal.name` and `merge.review-seal.driver` in the repository's own git config) and one `.gitattributes` line naming the ledger.

What does not count: forging a seal. The ledger token detects hand edits; it is not a signature, and the README's ledger section says so.

## Text from the repository and the reviewer

A cloned repository is not trusted, and neither is what the reviewer writes.

- Checklist text is never sent into your Claude session. When Claude edits a covered file, the plugin names the checklist file the reviewer will use (its path only). The reviewer reads the checklist itself, in its own read-only session.
- Reviewer output and ledger text are sanitised. Findings are stored on one line with control characters (including ANSI and OSC escape sequences) and bidirectional-override characters removed. Everything review-seal prints from the ledger, file names or reviewer errors is sanitised again, because a repository can ship a ledger written by anyone.
- On GitHub Actions, nothing review-seal prints from that text can become a workflow command: no such line starts with `::`, and the legacy `##[` form is broken up. The only commands it builds from that text on purpose are the `::warning` annotation for an open finding and the `::error` annotation for a review that failed, with their data escaped.

## A change cannot rewrite its own review rules

`check --staged` compares the change with `HEAD`, and `check --changed-since <ref>` compares the branch with the merge base. If the change edits `.seal/config.json` or any checklist and also changes content (any path outside `.seal/` that is not a checklist or the ledger), the check blocks. Settings changes go in on their own, in a commit or pull request where people can review them as such. Taking the config out of the index counts as editing it.

Which paths are checklists or the ledger comes from the config at the base. A path that only the new config names, such as a covered page made the ledger, counts as both a settings change and content, so the change blocks.

A merge is judged per side, against the merge base. A side whose commits each changed settings or content, but not both, passes. A side with one commit that changed both blocks the merge. So does a resolution that changes both itself: the paths whose staged version differs from every side are judged like a commit, with checklists and the ledger taken from the sides' configs.

## Ledger merges

The merge driver merges each file and pass three ways. Where one side left a review as it was at the common ancestor, the other side's review is kept. Where both sides changed it, the later review wins. Every entry it keeps must pass its token check. If a side is not a ledger (for example, JSON whose entries lack a review's fields), the driver exits 1 and git leaves its own conflict. The commit check can also take a review from the commit being merged, cherry-picked or rebased, but only one that passes its token check and was recorded for exactly the staged text and checklist.

## What the reviewer can reach

The reviewer is a headless Claude Code session run with `--safe-mode --restricted --strict-mcp-config`.

- Its tools are read-only (Read, Grep, Glob, plus web lookups a pass opts into) and it runs from the repository root with Claude Code's `--restricted` mode, which confines file tools to the working directory. Reads outside the repository were not separately tested.
- Deny rules cover `.git` and common secret files (best effort).
- Web tools are off unless a pass opts in. When one does, WebFetch is limited to the exact hostnames listed in that pass's `fetchDomains`.
- Findings are scrubbed for common secret formats before they are stored.

These are layered defences, not guarantees. Smoke tests of these flags passed on Claude Code 2.1.251 and 2.1.296. Do not list hosts where anyone can publish content in `fetchDomains`: a page the reviewer fetches is text an outsider wrote.

Self-hosted runners whose workspace contains the runner temp directory are out of scope.

WebSearch has no host limit; turn it on only for passes over files you would be comfortable having quoted in a search query.
