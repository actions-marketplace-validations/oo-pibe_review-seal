# Facts about other tools match their current docs

Check what the file says about how Claude Code, git, GitHub Actions and pre-commit behave against their current documentation:

- Claude Code: https://code.claude.com/docs (CLI flags, hooks, plugins, settings, permissions).
- git: https://git-scm.com/docs (hooks, merge drivers, gitattributes, config).
- GitHub Actions: https://docs.github.com/en/actions (workflow syntax, GITHUB_TOKEN, permissions, events, secrets).
- pre-commit: https://pre-commit.com (hook types, languages, stashing).

- Report each claim the current documentation contradicts, with its line number, what the file says, what the docs say and the source URL.
- A claim the docs do not mention either way is not a finding; skip it.
- Claims about review-seal's own code are out of scope for this pass. So are test results the file reports (such as which Claude Code versions a test passed on) and prices.
- Do not report style, tone or wording.
