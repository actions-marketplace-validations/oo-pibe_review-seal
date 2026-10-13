# review-seal

Prove each version of a file got an independent review.

A Claude Code plugin, git pre-commit hook and GitHub Action that run a fresh Claude reviewer on the files you name and block commits whose review is missing or out of date.

You give each review a checklist. When Claude Code finishes a turn, a reviewer that has never seen the conversation reads every covered file that changed and reports what it found. The result goes into `.seal/ledger.json`, tied to the exact text it read and the exact checklist it used. Change a word in either and that review stops counting.

**What it can't do.** It can't stop someone who sets out to forge a review: the ledger catches hand edits, but anyone can record a review with made-up evidence, and that shows up in git history. It also can't judge whether a review was any good. It records that one happened, on which version, against which checklist and by whom.

## Why I built it

I run [Road to Kickoff](https://roadtokickoff.com), football travel guides. Agents draft and research, and nothing ships without review passes. review-seal is how I make sure those passes happen. Each rule in it closes a gap I found in that process.

Two of the passes printed a reminder and exited successfully whether or not anyone ran them, so nothing showed whether they had run. That gap let a Flamengo guide contradict itself on tickets: it said visitors needed a Brazilian tax number (CPF), then described uploading a passport. The passes now block, and each one is recorded against the version it read.

My old edit hook matched `Write|Edit`. Agents also change files through shell commands, and in auto mode they often prefer to: one turn edited files through a Python heredoc and the hook never fired. review-seal watches Bash commands too, and checks the working tree when Claude finishes.

Reviews by the person who built a piece missed problems that an outside reader then caught before publishing. Here the reviewer starts with no view of the conversation, and the ledger records whether each review was independent. Set `independentFrom` and the builder's own reviews stop counting from that date.

## Install

Needs Node 20 or later, git 2.24 or later, and [Claude Code](https://code.claude.com/docs) installed and signed in.

    npm install -D review-seal
    npx review-seal init          # .seal/config.json, a starter checklist, an empty ledger
    npx review-seal install-hook  # git pre-commit hook

`init` covers `docs/**/*.md` with one pass called `review` and adds `.seal/.state/` to `.gitignore`. Point `files` at what needs review.

Then add the Claude Code plugin so reviews run on their own:

    /plugin marketplace add oo-pibe/review-seal
    /plugin install review-seal@review-seal

Reviews use the `claude` command you already have, signed in as you. Each one is a short headless session that can only read (Read, Grep, Glob, plus web lookups if a pass turns them on). A file is reviewed again only when it or its checklist changes, or when its review expires. On the default Sonnet model each file review cost about 4 to 7 cents in our tests.

If `install-hook` finds husky, lefthook or a `.pre-commit-config.yaml`, it prints what to add instead of writing `.git/hooks`. With husky or lefthook, run `review-seal check --staged` from your pre-commit hook. For pre-commit, see [pre-commit](#pre-commit) below.

To try it without installing anything, see [example/README.md](example/README.md) (two minutes).

## A normal day

1. Claude edits `docs/tickets.md`. The plugin tells it the review is now out of date. The first time a session touches a file in a pass, it also tells Claude which checklist that pass uses (the path only; the checklist's text never goes into the session).
2. Claude finishes its turn. The reviewer starts in the background, and the session doesn't wait.
3. The verdict lands in `.seal/ledger.json`. If there were findings, or a review could not run, Claude sees that when you send your next message.
4. You commit. The hook checks every staged covered file against the ledger, using the ledger as staged. If the review ran but the ledger isn't staged, the plain git hook stages the reviews for the files in that commit.

`review-seal list` shows every covered file, the state of each pass (`fresh`, `STALE`, `EXPIRED` or `never reviewed`), and how many reviews on record were independent and how many were by the builder.

To review a file right away from Claude Code, use the plugin's command: `/review-seal:seal docs/tickets.md`.

## Keeping pages current

A page can go out of date without anyone touching it, when a price or a rule changes after the review. So a review can also expire with time.

- Give a pass a shelf life with `"maxAgeDays": 90`. Reviews older than that are due again.
- Give one file a date with `review-by: 2026-12-01` in its front matter, for copy tied to a season or a deal. Once that day arrives, any review recorded before it is due again.
- Let a fact-check pass look things up with `"tools": ["WebSearch", "WebFetch"]`. The reviewer then checks claims against current sources and ends each finding with its source. WebFetch also needs `"fetchDomains"`, the exact hostnames the reviewer may fetch from. It still can't edit anything.

`review-seal review --due` re-reviews every covered file that is stale, never reviewed or past its shelf life. `review-seal check` with no arguments exits 1 when any covered file's review is missing, out of date or expired, so it works as a freshness report.

At commit time, an expired review blocks only when the staged change to that file is substantive (see `substantive` below). A smaller edit gets a warning. Files you don't commit are never blocked by their own expiry.

### On a schedule with GitHub Actions

    name: review-seal freshness
    on:
      schedule:
        - cron: "0 9 * * 1"
    permissions:
      contents: write
      pull-requests: write
    jobs:
      freshness:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
          - uses: oo-pibe/review-seal@v0.1.0
            with:
              mode: due
              anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

Every Monday it re-reviews what is due, commits the ledger to the branch `review-seal/scheduled` and opens or updates a pull request whose body is the review log, findings included. Nothing lands on your main branch until you merge it.

- With the default token, turn on "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General), or the pull request can't be opened.
- A pull request opened with the default token starts no other workflows. Pass a personal access token as `github-token` if your checks should run on it.
- If someone commits to `review-seal/scheduled`, or closes its pull request without merging, the job stops updating it until the branch is deleted. After a merge, the next run starts a new pull request.
- A later run reuses reviews already on the branch when they still match the file and checklist, so they aren't paid for twice.

### On a schedule without GitHub

A cron line does the same on any machine with Node and Claude Code on its `PATH`:

    0 9 * * 1 cd /path/to/repo && npx review-seal review --due

It updates the ledger in place. Commit it yourself.

## Config

`.seal/config.json`:

    {
      "passes": {
        "consistency": { "rubric": ".seal/rubrics/consistency.md", "files": ["docs/**/*.md"] },
        "fact-check": {
          "rubric": ".seal/rubrics/fact-check.md",
          "files": ["docs/guides/**/*.md"],
          "maxAgeDays": 90,
          "tools": ["WebSearch", "WebFetch"],
          "fetchDomains": ["www.example-club.com"]
        }
      },
      "autoReview": "stop",
      "independentFrom": "2026-11-01",
      "substantive": { "lines": 8, "patterns": ["\\bonly\\b", "\\bfirst\\b", "\\brecord\\b"] }
    }

| Key | Default | Meaning |
|---|---|---|
| `passes` | required | One entry per pass. Names use lowercase letters, digits and dashes. |
| `passes.<p>.rubric` | required | Path to the checklist, inside the repository. Editing it makes that pass's old reviews stale. |
| `passes.<p>.files` | required | Globs of the files the pass covers. `*` matches within a directory, `**` any depth, `?` one character. Nothing else is special. |
| `passes.<p>.maxAgeDays` | `null` | Shelf life of a review for this pass, in whole days. `null` means no limit. |
| `passes.<p>.tools` | `[]` | Extra reviewer tools. Only `WebSearch` and `WebFetch` are allowed. |
| `passes.<p>.fetchDomains` | `[]` | Exact hostnames WebFetch may open. Required with WebFetch, and allowed only with it. No wildcards. |
| `autoReview` | `"stop"` | `"stop"`: review when Claude finishes a turn. `"commit"`: also review inside the pre-commit hook, for commits made outside Claude. `"off"`: only when you run `review-seal review`. |
| `independentFrom` | `null` | A `YYYY-MM-DD` date. Reviews recorded by the builder on or after it block. |
| `substantive.lines` | `8` | With patterns set, a staged change touching this many lines always needs a fresh review. |
| `substantive.patterns` | `[]` | Case-insensitive regular expressions for claims. With none, every change needs a fresh review. With some, a smaller change needs one only if it adds a match or edits a sentence that contains one; otherwise the commit goes through with a warning. |
| `blockOnFindings` | `false` | Findings don't block by default. They are shown to Claude, printed as `FLAG` lines by `check` and the commit hook, and added as warnings on GitHub pull requests. Set `true` to block instead. |
| `maxFilesPerRun` | `5` | How many files one automatic review run takes on. Runs you start by hand have no cap. |
| `model` | `"sonnet"` | Model for the reviewer. |
| `timeoutSeconds` | `300` | Time limit for one review, from 1 to 1800. |
| `ledger` | `".seal/ledger.json"` | Where the ledger lives, inside the repository. |

The `substantive` rules apply only to the commit hook (`check --staged`). Every other check treats any change as needing a review. Whitespace at the ends of lines, line endings and blank lines at the start or end of a file don't change its hash. A file that is not valid UTF-8 is hashed byte for byte.

## Commands

    review-seal init                        set up .seal/ in this repo
    review-seal review <files…> | --changed-since <ref>
                                            run the independent reviewer on those files if they need it
                                            (never reviewed, changed since, or past their shelf life)
    review-seal review --all                every covered file that changed or was never reviewed; ignores shelf life
    review-seal review --due                like --all, and also renews reviews past their shelf life
    review-seal check [--staged | --changed-since <ref> | <files…>]
                                            exit 1 if a covered file lacks a fresh review
    review-seal list                        every covered file and its review status
    review-seal seal <file> --pass <p> --reviewer builder --verdict clean|findings [--finding "…"]
    review-seal seal <file> --pass <p> --reviewer independent --evidence <verdict.json>
                                            record a review by hand
    review-seal install-hook [--force]      add the git pre-commit hook
    review-seal hash <file>                 print a file's content hash
    review-seal ledger-path                 print the ledger's path from the config

`--changed-since <ref>` takes the files changed between the merge base with `<ref>` and `HEAD`. `check --staged` reads the config and checklists from the git index, so an edit to them that is not staged does not change what the commit is checked against. `check --staged` and `check --changed-since` also block a change that narrows coverage against the config it started from (a dropped pass, a file no longer covered, a moved ledger, a renamed checklist), unless the change touches nothing outside `.seal/`: make config changes in a commit of their own. `install-hook` refuses to write into a hooks directory outside the repository (a shared `core.hooksPath`) unless you pass `--force`. `seal --reviewer independent` accepts only a verdict produced for the current version of the file and checklist.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | `check`: a covered file needs a review. `review`: a review failed, or another review was already running. |
| 2 | Bad usage, config or ledger |
| 3 | `seal` refused the evidence |

## pre-commit

For [pre-commit](https://pre-commit.com), add to `.pre-commit-config.yaml`:

    repos:
      - repo: https://github.com/oo-pibe/review-seal
        rev: v0.1.0
        hooks:
          - id: review-seal

The hook needs Node 20 or later on your `PATH`. pre-commit installs nothing for it: it is a `language: script` hook that runs `bin/review-seal.js check --staged` from its own checkout of this repository. It doesn't use `language: node` because npm 11 refuses the git install pre-commit runs for node hooks (`EALLOWGIT`).

Stage the ledger with your change (`git add .seal/ledger.json`). pre-commit stashes unstaged changes before hooks run, so a review recorded but not staged is hidden from the check. When that blocks a commit, the message says so. The plain git hook from `install-hook` doesn't have this problem: it stages the reviews for that commit's files itself.

## GitHub pull requests

    name: review-seal
    on: pull_request
    permissions:
      contents: write
    concurrency:
      group: review-seal-${{ github.head_ref }}
      cancel-in-progress: true
    jobs:
      review-seal:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
            with:
              ref: ${{ github.head_ref }}
              fetch-depth: 0
          - uses: oo-pibe/review-seal@v0.1.0
            with:
              anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

The Action reviews the covered files the pull request changed, commits the updated ledger back to the branch, then fails if any of them still lack a fresh review. Open findings show up as warnings on the pull request. Pin `oo-pibe/review-seal` to a commit SHA in production.

- `fetch-depth: 0` lets it find the merge base with `origin/<base>`. `ref: ${{ github.head_ref }}` checks out the branch itself: the default pull request checkout is a detached merge commit, and the Action refuses to push from one. Keep `persist-credentials` at its default so the push works. The Action removes checkout's token from `.git/config` while the reviewer runs and puts it back afterwards.
- `contents: write` lets it push the ledger commit. The `concurrency` group stops two runs on one branch from racing. Pull after the bot's ledger commit before you push again.
- It runs on `pull_request` events, where `base` defaults to the pull request's base branch. Anywhere else, pass `base`.
- A ledger commit pushed with the default `GITHUB_TOKEN` starts no new workflow run. That avoids a loop, but the bot's commit gets no checks, so a required check waits forever. Either pass a personal access token or GitHub App token to `actions/checkout` as `token` (the push then starts one more run, which finds nothing to review and passes), or set `commit: "false"`.
- With `commit: "false"`, the Action prints that run's reviews, then puts the ledger back as committed and checks that. The check fails until the reviews are committed some other way, for example by the plugin or `review-seal review` on your machine.
- Pull requests from forks are not supported. GitHub withholds secrets from them, so the Action stops with "anthropic-api-key is empty", and it couldn't push to a fork anyway. Review those branches locally. Don't work around this with `pull_request_target` plus a checkout of the pull request's head: that runs untrusted changes with your secrets.
- Each run calls Claude, billed to the API key. Keep the key in a repository secret. The Action installs Claude Code version `2.1.251` unless you set `claude-code-version`.

Inputs:

| Input | Default | Meaning |
|---|---|---|
| `anthropic-api-key` | required | API key for the reviewer |
| `mode` | `"pr"` | `"pr"` reviews a pull request. `"due"` re-reviews what is due and opens a pull request. |
| `base` | the pull request's base branch | Branch to compare against |
| `commit` | `"true"` | `"false"` keeps the ledger as committed |
| `github-token` | `github.token` | Token used to open the pull request in `due` mode |
| `claude-code-version` | `"2.1.251"` | Version of `@anthropic-ai/claude-code` to install |

## The ledger

    "docs/tickets.md": {
      "consistency": {
        "at": "2026-10-13",
        "contentHash": "sha256:79d000af0d726ca0",
        "rubricHash": "sha256:46b833f9bc9bbada",
        "verdict": "findings",
        "findings": [
          "L5: says to upload a passport instead of the tax number that L3 says is required"
        ],
        "reviewer": "independent",
        "via": "agent",
        "token": "rv_6b4e8214c1d6"
      }
    }

- `at` is the review date (UTC). `contentHash` and `rubricHash` identify the file and checklist versions it read.
- `reviewer` is `independent` or `builder`. `via` is `agent` for the automatic reviewer and evidence-backed seals, `manual` for builder seals.
- `token` is a hash over the file path, the pass name and every other field, `at` included. Edit any of them by hand and the entry stops counting until the file is reviewed again. The token is a plain hash anyone can recompute, so it detects edits, not forgery.

Commit the ledger. It is the review history of every covered file, kept next to the files. Keys are sorted so diffs stay small.

## Limits

- Covered paths that are symlinks are skipped. They are never reviewed, and they never block a commit or a pull request check. `review-seal review <symlink>` exits 2 and says so.
- review-seal never follows a symlink in its own paths: the config, the checklists, the ledger and `.seal/.state/`. If one of them goes through a symlink, commands exit 2 and say so, and the plugin hooks do nothing.
- The edit hook skips gitignored files, and `list` and `review --all` only see files git tracks or would track.
- The plugin spots a Bash command that names a covered path, and when Claude finishes it also looks at what changed in the working tree. A command that never names a covered path (a formatter script, say) is caught only if the same session touched a covered file or ran a command mentioning part of a coverage glob.
- Once a session edits anything covered, the end-of-turn review also takes every other covered file with uncommitted changes whose review is out of date, including ones changed before the session started, up to `maxFilesPerRun` files a run.
- An automatic review that fails waits 10 minutes before it is retried. After three failures on the same version it waits until the file changes. Failure records older than a week are cleared the next time any review runs in the repository. `review-seal review` run by hand always tries.
- Each plugin hook has a 10-second timeout, fails silently and never blocks a session. In a very large repository the check after a Bash command may time out; the working-tree scan when Claude finishes still runs.
- Findings sent to Claude are capped at 300 characters each, 20 per file and 8,000 characters per message, and framed as claims for Claude to check. Findings from a review you run by hand reach the next Claude Code session in that repository too.
- The reviewer runs with `--safe-mode --restricted --strict-mcp-config`, read-only tools and deny rules for `.git` and common secret files. In one round of tests on Claude Code 2.1.251, reads of `.git` and a WebFetch to a host outside `fetchDomains` were denied when tried directly with these flags, and a repository `CLAUDE.md` telling the reviewer to answer "clean" did not change its verdict. Treat these as layered defences verified on that version. They are not guarantees. An older Claude Code that lacks these flags fails with a message asking you to update. See [SECURITY.md](SECURITY.md).
- Reviews run on the working copy, so a file staged only in part can't be reviewed for that commit. Stage the whole file.
- Git does not run the pre-commit hook during rebase, cherry-pick or am, so those can record versions nobody reviewed. Run review-seal check in CI as the backstop.
- For `git commit <path>`, the hook stages the ledger into both indexes git uses during that commit. This is tested on git 2.50 and relies on long-stable git behaviour.
- git 2.24 or later is needed (`--end-of-options`).
- `review-by` dates, `independentFrom` and review dates are UTC days.

CI runs the tests on Linux and macOS with Node 20, 22 and 24.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability and what the reviewer can reach.

## License

MIT
