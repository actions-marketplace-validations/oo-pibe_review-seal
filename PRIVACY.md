# Privacy

review-seal has no server, accounts, analytics or telemetry. Nothing is sent to its author.

## What leaves your machine

- **To Anthropic, when a review runs.** The reviewer is a Claude Code session started with the `claude` command you already use, signed in as you. It reads the file under review, your checklist and any other files in the repository it needs, and that content goes to Anthropic like any other Claude Code session. Anthropic's handling is set by your own account and their [privacy policy](https://www.anthropic.com/legal/privacy).
- **To websites you list, only if you turn web lookups on.** Web lookups are off by default. When a pass enables them, the reviewer can fetch pages from the domains you put in `fetchDomains` to check facts.
- **In the GitHub Action,** the same applies, using the Anthropic API key you pass to it and running in your own CI.

review-seal never reads your Claude Code sign-in or any key itself. It starts `claude`, and Claude Code handles the sign-in.

## What it stores

Everything stays in your repository:

- `.seal/ledger.json` (the default path): one record per reviewed file and pass, with the verdict, the reviewer's findings, hashes of the file and checklist, and a timestamp. Findings can quote the file they're about. It's meant to be committed, since that's how the git hook and CI know a review happened.
- `.seal/.state/`: working files such as findings waiting to be shown to Claude, ignored by git.

## Contact

Questions go to [GitHub issues](https://github.com/oo-pibe/review-seal/issues). Security problems go through [private reporting](https://github.com/oo-pibe/review-seal/security/advisories/new), as described in [SECURITY.md](https://github.com/oo-pibe/review-seal/blob/main/SECURITY.md).
