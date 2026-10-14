# Claims match the code

Every claim in the file about review-seal's commands, flags, config keys, defaults, behaviour, exit codes, hooks, the GitHub Action and security must match the code. The code is in `lib/`, `bin/`, `action.yml`, `hooks/`, `.pre-commit-hooks.yaml`, `.claude-plugin/` and `commands/`, and the tests in `test/` show the intended behaviour.

- Read the code that implements each claim before you judge it. Do not judge from the docs alone.
- Report each claim that does not match, with its line number, what the file says and what the code does (name the file and function).
- A claim that the code supports, even loosely worded, is fine. Do not report style, tone, wording you would prefer, or missing documentation.
- Example config and workflow snippets must be accepted by the code as written (for example `parseConfig` in `lib/config.js`, the inputs in `action.yml`).
- Claims about third-party tools (Claude Code, git, GitHub, pre-commit) are out of scope for this pass, except where the code itself shows how review-seal uses them.
