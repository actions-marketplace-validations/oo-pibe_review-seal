# review-seal reference

The [README](../README.md) covers what review-seal does, how to install it and a normal day. This page has the details: configuration, what Claude sees, keeping pages current, CI, pre-commit, branches, limits and the ledger format.

- [Config](#config)
- [Letting small edits through](#letting-small-edits-through)
- [What Claude and the person committing see](#what-claude-and-the-person-committing-see)
- [Keeping pages current](#keeping-pages-current)
- [GitHub pull requests](#github-pull-requests)
- [Hooks and formatters](#hooks-and-formatters)
- [pre-commit](#pre-commit)
- [Commands in detail](#commands-in-detail)
- [Branches, merges and rebases](#branches-merges-and-rebases)
- [Limits](#limits)
- [The ledger](#the-ledger)
- [Security](#security)

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
      "independentFrom": "2026-11-01"
    }

Each `rubric` file must exist. Otherwise the commands that read the config stop with an error, except `install-hook`, which carries on with the default ledger path. `init` creates only `.seal/rubrics/review.md`, so for this example copy it to `.seal/rubrics/consistency.md` and `.seal/rubrics/fact-check.md`, then edit each one. A checklist only needs to say what to look for. review-seal tells the reviewer how to format its answer.

| Key | Default | Meaning |
|---|---|---|
| `passes` | required | One entry per pass. Names use lowercase letters, digits and dashes. |
| `passes.<p>.rubric` | required | Path to the checklist, inside the repository. Editing it makes that pass's old reviews stale. |
| `passes.<p>.files` | required | Globs of the files the pass covers, relative to the repository root. `*` matches within a directory, `**` any depth, `?` one character. Nothing else is special. |
| `passes.<p>.maxAgeDays` | `null` | Shelf life of a review for this pass, in whole days. `null` means no limit. |
| `passes.<p>.tools` | `[]` | Extra reviewer tools. Only `WebSearch` and `WebFetch` are allowed. |
| `passes.<p>.fetchDomains` | `[]` | Exact hostnames WebFetch may open. Required with WebFetch, and allowed only with it. No wildcards. |
| `passes.<p>.blockOnFindings` | the top-level value | Overrides `blockOnFindings` for this pass only. |
| `autoReview` | `"stop"` | `"stop"`: review when Claude finishes a turn. `"commit"`: also review inside the pre-commit hook, for commits made outside Claude. `"off"`: only when you run `review-seal review`. |
| `independentFrom` | `null` | A `YYYY-MM-DD` date. Reviews recorded by the builder on or after it block. |
| `substantive.lines` | `8` | With patterns set, a file whose staged version differs from its reviewed version in this many lines always needs a fresh review. |
| `substantive.patterns` | `[]` | Case-insensitive regular expressions for claims. With none, every change needs a fresh review. With some, a smaller change needs one only if it adds a match or edits a sentence that contains one; otherwise the commit goes through with a warning. |
| `blockOnFindings` | `false` | Findings don't block by default. They are shown to Claude, printed as `FLAG` lines by `check` and the commit hook, and added as warnings on GitHub pull requests. Set `true` to block instead. |
| `maxFilesPerRun` | `5` | How many files one automatic review run takes on. Runs you start by hand have no cap. |
| `model` | `"sonnet"` | Model for the reviewer. |
| `timeoutSeconds` | `600` | Time limit for one review, from 1 to 1800. |
| `ledger` | `".seal/ledger.json"` | Where the ledger lives, inside the repository. |

An unknown key is an error in the same way, and the message suggests the closest valid key, so a typo such as `"maxAgedays"` is caught instead of ignored. A pass setting written at the top level, or a top-level setting written inside a pass, gets a message saying where it belongs.

Some mistakes are allowed but print a warning:

- `list`, and `check` with no arguments, warn about a pass whose globs match no files, and about each glob that matches nothing.
- `list`, and `check` outside the commit hook, warn about a Markdown file under `.seal/rubrics/` that no pass uses.
- `list`, `check`, `review` and `seal` warn when `fetchDomains` lists a placeholder host such as `www.example.com`.

## Letting small edits through

`substantive` is opt-in. With no patterns, which is the default, every change to a reviewed file needs a fresh review before it can be committed. With patterns, a change smaller than `lines` needs one only if it adds a match or edits a sentence that contains one. Anything else goes through with a warning:

    "substantive": { "lines": 8, "patterns": ["\\d", "\\bonly\\b", "\\bfirst\\b"] }

The pattern `\d` (written `\\d` in JSON) makes any edit to a sentence with a number in it count, so a changed price or date still needs a review.

The `substantive` rules apply only to the commit hook (`check --staged`), and only to a file that has a review on record: a file that was never reviewed always blocks, whatever the size of the change. The change is measured from the version the review read, not from the last commit, so a run of small commits cannot drift a file away from what was reviewed: once the total passes the threshold, the next commit blocks. When the reviewed version is not in the repository (see the ledger's `reviewedBlob` below), any change counts as substantive. Every other check treats any change as needing a review. Whitespace at the ends of lines, line endings and blank lines at the start or end of a file don't change its hash. A file that is not valid UTF-8 is hashed byte for byte.

## What Claude and the person committing see

In a Claude Code session, through the plugin:

- After an edit to a covered file, Claude is told the file needs a review. The first time a session touches a file in a pass, it is also told which checklist that pass uses, by path only.
- On your next message after an automatic review, Claude sees its findings, or that it could not run. A review the session was waiting for that came back clean gets one line, `review-seal: reviewed <files> (clean)`. Clean results from reviews run by hand or by a scheduled job are not passed on.
- On the first message of a session, Claude hears which covered files have open findings on record for their current version, for example from a scheduled CI run. It gets counts and file names only, with a pointer to `review-seal list`. The finding text stays out of the session, because anyone who can commit can edit the ledger.
- If `.seal/config.json` does not load, automatic reviews stop. Claude is told once per session at the prompt and once after a tool, with the note that automatic reviews are off until it's fixed. It hears only the kind of problem (an unknown key, invalid JSON, a checklist path problem) and is pointed at `review-seal list` for the details. No text from the config reaches it, and a key is named only when it is one of review-seal's own, as in `unknown key near "maxAgeDays"`.

At the command line:

- `check` prints `BLOCK` lines for files that need a review, `FLAG` lines for open findings and `WARN` lines for changes it lets through because they are not substantive. A block caused only by open findings (under `blockOnFindings`) gets its own heading, and the fix it names is to edit the file, which is then reviewed again. A block caused only by an expired review names the `review` command to run, since an automatic review renews what changed, not what only aged. If a review is running when you commit, the message says to commit again when it finishes.
- The first time `check` runs in a clone that has no review-seal hook, it says so once and suggests `install-hook` or a `"prepare": "review-seal install-hook"` script. It stays quiet under CI (`GITHUB_ACTIONS`, `CI`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`), inside a git hook, and where husky, lefthook, a `.pre-commit-config.yaml` or `core.hooksPath` runs the hooks.

## Keeping pages current

A page can go out of date without anyone touching it, when a price or a rule changes after the review. So a review can also expire with time.

- Give a pass a shelf life with `"maxAgeDays": 90`. Reviews older than that are due again.
- Give one file a date with `review-by: 2026-12-01` in its front matter, for copy tied to a season or a deal. Once that day arrives, any review recorded before it is due again.
- Let a fact-check pass look things up with `"tools": ["WebSearch", "WebFetch"]`. The reviewer then checks claims against current sources and ends each finding with its source. WebFetch also needs `"fetchDomains"`, the exact hostnames the reviewer may fetch from. It still can't edit anything.

`review-seal review --due` re-reviews every covered file that is stale, never reviewed or past its shelf life. `review-seal check` with no arguments exits 1 when any covered file's review is missing, out of date or expired, so it works as a freshness report.

At commit time, an expired review blocks only when the file has changed substantively since the version that was reviewed (see [Letting small edits through](#letting-small-edits-through)). A smaller edit gets a warning. Files you don't commit are never blocked by their own expiry.

### On a schedule with GitHub Actions

    name: review-seal freshness
    on:
      schedule:
        - cron: "0 9 * * 1"
      workflow_dispatch:
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

Every Monday it re-reviews what is due, commits the ledger to the branch `review-seal/scheduled` and opens or updates a pull request. The pull request lists every review the branch renews, with its findings, followed by the latest run's log. Nothing lands on your main branch until you merge it. `workflow_dispatch` also lets you start it by hand from the Actions tab.

- With the default token, turn on "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General), or the pull request can't be opened.
- A pull request opened with the default token gets its workflow runs only in an approval-required state: someone with write access has to choose "Approve workflows to run" on it. Pass a personal access token as `github-token` if your checks should run without that step.
- If someone commits to `review-seal/scheduled`, or closes its pull request without merging, the job reviews nothing until the branch is deleted, and says so in the job summary. A review that fails shows as an error on its file. After a merge, the next run starts a new pull request.
- A later run reuses reviews already on the branch when they still match the file and checklist, so they aren't paid for twice.

### On a schedule without GitHub

A cron line does the same on any machine with Node and Claude Code on its `PATH`:

    0 9 * * 1 cd /path/to/repo && npx review-seal review --due

It updates the ledger in place. Commit it yourself.

## GitHub pull requests

    name: review-seal
    on: pull_request
    permissions:
      contents: write
    concurrency:
      group: review-seal-${{ github.head_ref }}
      cancel-in-progress: false
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

The Action reviews the covered files the pull request changed, commits the updated ledger back to the branch, then fails if any of them still lack a fresh review. Open findings show up as warnings on the pull request, on their line when the finding names one. Under `blockOnFindings` they block instead, and show up as errors. A review that could not run shows as an error on its file, and the final check step decides whether the job fails. Pin `oo-pibe/review-seal` to a commit SHA in production.

- `fetch-depth: 0` lets it find the merge base with `origin/<base>`. `ref: ${{ github.head_ref }}` checks out the branch itself: the default pull request checkout is a detached merge commit, which can't be pushed. With `commit: "true"` the Action stops on one before any review runs. Keep `persist-credentials` at its default so the push works. The Action removes checkout's token from `.git/config` while the reviewer runs and puts it back afterwards.
- `contents: write` lets it push the ledger commit. The `concurrency` group stops two runs on one branch from racing. `cancel-in-progress: false` lets a run that is already paying for reviews finish, and the next run waits for it. Pull after the bot's ledger commit before you push again.
- It runs on `pull_request` events, where `base` defaults to the pull request's base branch. Anywhere else, pass `base`.
- A ledger commit pushed with the default `GITHUB_TOKEN` doesn't start new workflow runs on its own. GitHub creates the pull request's runs in an approval-required state, which avoids a loop, so the bot's commit gets no checks until someone with write access chooses "Approve workflows to run", and a required check waits until then. To skip that step, either pass a personal access token or GitHub App token to `actions/checkout` as `token` (the push then starts one more run, which finds nothing to review and passes), or set `commit: "false"`.
- With `commit: "false"`, the Action prints that run's reviews, then puts the ledger back as committed and checks that. The check fails until the reviews are committed some other way, for example by the plugin or `review-seal review` on your machine. Its message says so.
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

### CI only

You can skip the plugin and the local hook and let the Action do every review.

1. Run `npx review-seal init` once on your machine, point `files` at what needs review, and commit `.seal/`. The Action reads the config and checklists from the repository.
2. Add the pull request workflow above and keep `commit: "true"`, the default, so each run's reviews are committed back to the branch.
3. If the check is required before merging, pass a personal access token or GitHub App token to `actions/checkout` as `token`. With the default token, the runs for the bot's ledger commit wait until someone with write access approves them.
4. Add the scheduled workflow from [On a schedule with GitHub Actions](#on-a-schedule-with-github-actions) if reviews should expire.

With `commit: "false"` in this setup, no review is ever kept. Each run pays for the same reviews again and the check keeps failing, because nothing else records them.

## Hooks and formatters

`install-hook` writes two git hooks with the same check: `pre-commit`, and `pre-merge-commit`, which is the hook git runs for a merge that needs no conflict resolution. It also sets up the ledger's merge driver (see [Branches, merges and rebases](#branches-merges-and-rebases)). If it finds husky, lefthook or a `.pre-commit-config.yaml`, it prints what to add instead of writing `.git/hooks`. With husky or lefthook, run `review-seal check --staged` from both your pre-commit and pre-merge-commit hooks. `install-hook` refuses to write into a hooks directory outside the repository (a shared `core.hooksPath`) unless you pass `--force`.

The hooks and the merge driver's settings live in each clone, so every teammate runs `install-hook` once. Adding `"prepare": "review-seal install-hook"` to `package.json` scripts does it on `npm install`.

Run formatters before reviews, and put review-seal last in your hooks, after lint-staged or any other formatter. A formatter that rewrites a file after its review leaves a version nobody reviewed. The commit is then blocked. When the staged file differs from the reviewed one only in whitespace, the message says a formatter may have changed it.

The plugin runs its own copy of review-seal, and the git hook runs the one in `node_modules`. Keep the two on the same version: when you update the npm package, update the plugin from `/plugin` as well, and the other way round. `npx review-seal --version` prints the package's version, and `/plugin` shows the plugin's.

## pre-commit

For [pre-commit](https://pre-commit.com), add to `.pre-commit-config.yaml`:

    repos:
      - repo: https://github.com/oo-pibe/review-seal
        rev: v0.1.0
        hooks:
          - id: review-seal

To guard merges too, also run `pre-commit install --hook-type pre-merge-commit`.

The hook needs Node 20 or later on your `PATH`. pre-commit installs nothing for it: it is a `language: script` hook that runs `bin/review-seal.js check --staged` from its own checkout of this repository. pre-commit 4.4.0 renamed that language `unsupported_script` and keeps `script` as an alias, so the hook still works on older versions. It doesn't use `language: node` because npm 11 refuses the git install pre-commit runs for node hooks (`EALLOWGIT`).

Stage the ledger with your change (`git add .seal/ledger.json`). pre-commit stashes unstaged changes before hooks run, so a review recorded but not staged is hidden from the check. When that blocks a commit, the message says so. The plain git hook from `install-hook` doesn't have this problem: it stages the reviews for that commit's files itself.

## Commands in detail

`--changed-since <ref>` takes the files changed between the merge base with `<ref>` and `HEAD`. `review --dry-run` lists what a run would review, and any review it would reuse from a renamed file, without reviewing anything. `review … --json <file>` also writes what the run did (verdicts, findings and failures) as JSON; the GitHub Action uses it to annotate failed reviews.

`check --staged` reads the config and checklists from the git index, so an edit to them that is not staged does not change what the commit is checked against. `check --staged` and `check --changed-since` also block a change that edits the review settings (`.seal/config.json` or any checklist) together with content, meaning any path outside `.seal/` that is not a checklist or the ledger. Commit settings changes on their own, where people can review them as such; the message names the `git restore --staged` command that splits the change. Which paths count as checklists or the ledger comes from the config at the base, so a change that points the new config's ledger or a checklist at a content file still counts that file as content. Merges are judged per side. A settings commit on one branch and a content commit on the other don't block a merge, but a single commit on either branch that changed both does, and so does a merge resolution that itself changes both (paths whose staged version differs from every side). A repository whose base has no config yet is exempt, so setting review-seal up in the same commit as other work is fine.

`seal --reviewer independent` accepts only a verdict produced for the current version of the file and checklist. `review`, `check` and `seal` say so when a file you name is not covered by any pass. From a subdirectory, `review` also accepts a path written from the repository root.

A file that was renamed or moved keeps its review: when `review` finds that the exact same text was reviewed against the same checklist under a name that no longer exists, it moves that review to the new name instead of paying for a new one. A file outside a sparse checkout still exists, so its review stays where it is. `review-seal prune` removes reviews of files that no longer exist or that no pass covers any more, and prints each one it removed.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | `check`: a covered file needs a review. `review`: a review failed, or another review was already running (the message names the command to run again). |
| 2 | Bad usage, config or ledger, or `review` of a file no pass covers |
| 3 | `seal` refused the evidence |

## Branches, merges and rebases

Two branches that each record reviews change the ledger in the same place, which git would report as a conflict on every merge and rebase. `install-hook` sets up a merge driver so git resolves the ledger by itself:

- It adds `.seal/ledger.json merge=review-seal` to `.gitattributes` (with your configured ledger path), if the line is not already there. Commit `.gitattributes`.
- It sets `merge.review-seal.name` and `merge.review-seal.driver` in the repository's own git config. That config is not shared through git, so everyone who clones the repository runs `review-seal install-hook` once.
- The driver is `review-seal merge-driver %O %A %B` (taken from `node_modules/.bin`, then from `PATH`; failing both, `node` runs the copy `install-hook` ran from). It merges each file and pass three ways. If one side still has the review it had at the common ancestor, the other side's review is kept, whatever the dates. That is also how a review one side pruned stays pruned. When both sides changed the review, the later one wins, and on the same day your side's does. Entries that fail their token check are dropped. If either side is not a ledger, the driver leaves git's normal conflict for you to resolve. `install-hook` does not set the driver up for a ledger path with whitespace or a pattern character (`*`, `?`, `[`, `]`, `\`), since `.gitattributes` would read it as a pattern.

When the merged ledger keeps a review of an older version of a file, the commit check looks for a review of the merged version in the commit being merged, cherry-picked or rebased, and stages it. A clean merge writes its tree before the `pre-merge-commit` hook runs, so a review the hook stages would miss that merge commit. In that case the hook stages the review and stops the merge; run `git commit` to finish it.

A merge that needs no conflict resolution runs the `pre-merge-commit` hook, which `install-hook` writes, so it is checked like any commit. A merge with conflicts is checked by `pre-commit` when you commit the resolution. Rebases, cherry-picks and `git am` run neither hook (see [Limits](#limits)).

## Limits

- Covered paths that are symlinks are skipped. They are never reviewed, and they never block a commit or a pull request check. `review-seal review <symlink>` exits 2 and says so.
- review-seal never follows a symlink in its own paths: the config, the checklists, the ledger and `.seal/.state/`. If one of them goes through a symlink, commands exit 2 and say so, and the plugin hooks do nothing.
- The edit hook skips gitignored files, and `list` and `review --all` only see files git tracks or would track.
- The plugin spots a Bash command that names a covered path, and when Claude finishes it also looks at what changed in the working tree. A command that never names a covered path (a formatter script, say) is caught only if the same session touched a covered file or ran a command mentioning part of a coverage glob.
- Once a session edits anything covered, the end-of-turn review also takes every other covered file with uncommitted changes whose review is out of date, including ones changed before the session started, up to `maxFilesPerRun` files a run.
- An automatic review that fails waits 10 minutes before it is retried. After three failures on the same version it waits until the file changes. Failure records older than a week are cleared the next time any review runs in the repository. `review-seal review` run by hand always tries.
- Each plugin hook has a 10-second timeout, fails silently and never blocks a session. In a very large repository the check after a Bash command may time out; the working-tree scan when Claude finishes still runs.
- Findings sent to Claude are capped at 300 characters each, 20 per file and 8,000 characters per message, and framed as claims for Claude to check. Findings from a review you run by hand reach the next Claude Code session in that repository too.
- The reviewer runs with `--safe-mode --restricted --strict-mcp-config`, read-only tools and deny rules for `.git` and common secret files. In one round of tests on Claude Code 2.1.251, reads of `.git` and a WebFetch to a host outside `fetchDomains` were denied when tried directly with these flags, and a repository `CLAUDE.md` telling the reviewer to answer "clean" did not change its verdict. Treat these as layered defences verified on that version. They are not guarantees. An older Claude Code that lacks these flags fails with a message asking you to update. See [SECURITY.md](../SECURITY.md).
- Reviews run on the working copy, so a file staged only in part can't be reviewed for that commit. Stage the whole file.
- Submodules are not files, so they are never reviewed and never block, even under a covered glob.
- Git does not run the pre-commit or pre-merge-commit hook during rebase, cherry-pick or am, so those can record versions nobody reviewed. Run review-seal check in CI as the backstop.
- A version that was reviewed but never committed exists only as a loose git object, which `git gc` deletes after about two weeks (`gc.pruneExpire`). After that, any edit to that file counts as substantive at commit time until it is reviewed again. A reviewed version that was committed, or that came from another clone in a commit, stays available.
- When Claude finishes turns in two sessions close together, the second automatic review waits for the first, checking every 2 seconds for up to `timeoutSeconds` plus 60 seconds. If the first is still running by then, the second session is told on its next message which `review-seal review` command to run.
- `.seal/.state/review.log`, the log of automatic reviews, keeps its last 128 KB once it passes 256 KB.
- When a review fails with "could not read a verdict", the reviewer's raw output (its last 1 MB) is saved to `.seal/.state/last-reviewer-output.txt`. The plugin hooks fail silently; set `REVIEW_SEAL_DEBUG=1` in the environment Claude Code runs in to have them print their errors to stderr.
- For `git commit <path>`, the hook stages the ledger into both indexes git uses during that commit. This is tested on git 2.50 and relies on long-stable git behaviour.
- git 2.24 or later is needed (`--end-of-options`).
- `review-by` dates, `independentFrom` and review dates are UTC days.

CI runs the tests on Linux and macOS with Node 20, 22 and 24.

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
        "reviewedBlob": "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
        "token": "rv_6b4e8214c1d6"
      }
    }

- `at` is the review date (UTC). `contentHash` and `rubricHash` identify the file and checklist versions it read.
- `reviewer` is `independent` or `builder`. `via` is `agent` for the automatic reviewer and evidence-backed seals, `manual` for builder seals.
- `reviewedBlob` is the git object id of the exact bytes the reviewer read, stored in the repository's object database when the review is recorded (`git hash-object -w`). The commit hook measures later edits against it. Entries written before this field existed have none and stay valid; for them the hook compares with `HEAD` when `HEAD` holds the reviewed text, and otherwise treats any change as substantive.
- `token` is a hash over the file path, the pass name and every other field, `at` included. Edit any of them by hand and the entry stops counting until the file is reviewed again. The token is a plain hash anyone can recompute, so it detects edits, not forgery.

Commit the ledger. It is the review history of every covered file, kept next to the files. Keys are sorted so diffs stay small.

## Security

See [SECURITY.md](../SECURITY.md) for how to report a vulnerability and what the reviewer can reach.
