# Privacy

review-seal has no server, accounts, analytics or telemetry. Nothing is sent to its author.

## What leaves your machine

- **To Anthropic, when a review runs.** The reviewer is a Claude Code session started with the `claude` command you already use, signed in as you. It reads the file under review, your checklist and any other files in the repository it needs, and that content goes to Anthropic like any other Claude Code session. Anthropic's handling is set by your own account and their [privacy policy](https://www.anthropic.com/legal/privacy).
- **To the web, only if you turn web lookups on.** They are off by default. A pass can enable web search, which runs through Claude Code's own search tool, and page fetches, which are limited to the hosts you list in `fetchDomains`. The search queries and fetched addresses are chosen by the reviewer from the file it is checking.
- **In the GitHub Action,** the same applies, using the Anthropic API key you pass to it and running in your own CI.

review-seal doesn't look at, store or send your sign-in or any key. It starts `claude` with your environment, and Claude Code signs in as it normally would, with your account or with an API key if that's how you use it.

## What it stores

Its records stay in your repository:

- `.seal/ledger.json` (the default path): one record per reviewed file and pass, with the verdict, the reviewer's findings, hashes of the file and checklist, and a timestamp. Findings can quote the file they're about. It's meant to be committed, since that's how the git hook and CI know a review happened.
- `.seal/.state/`: working files such as findings waiting to be shown to Claude, ignored by git.

Setup also adds a git hook and a merge setting for the ledger to your repository's git configuration. None of it holds personal data.

## Contact

Questions go to [GitHub issues](https://github.com/oo-pibe/review-seal/issues). Security problems go through [private reporting](https://github.com/oo-pibe/review-seal/security/advisories/new), as described in [SECURITY.md](https://github.com/oo-pibe/review-seal/blob/main/SECURITY.md).

Changes to this page are tracked in the repository's history.
