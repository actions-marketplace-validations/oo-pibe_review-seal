# Security

Report a vulnerability through GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Please do not open a public issue.

What counts: anything that lets a hook or the reviewer write outside `.seal/`, run commands it should not, or leak file contents off the machine beyond the Claude session the user already runs.

What does not: forging a seal. The ledger token detects hand edits; it is not a signature, and the README says so.

## What the reviewer can reach

The reviewer is a headless Claude Code session run with `--safe-mode --restricted --strict-mcp-config`.

- Its file tools are read-only and confined to the repository.
- Deny rules cover `.git` and common secret files (best effort).
- Web tools are off unless a pass opts in. When one does, WebFetch is limited to the exact hostnames listed in that pass's `fetchDomains`.
- Findings are scrubbed for common secret formats before they are stored.

These are layered defences, not guarantees. Do not list hosts where anyone can publish content in `fetchDomains`: a page the reviewer fetches is text an outsider wrote.

Self-hosted runners whose workspace contains the runner temp directory are out of scope.
