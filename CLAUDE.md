# Project instructions

## Agents
- `ui-designer` (`.claude/agents/ui-designer.md`): use for any change to the user interface.
- `critic` (`.claude/agents/critic.md`): read-only reviewer. It must approve every commit.

## Committing
Every commit must be approved by the critic first, and pushes are blocked otherwise.

1. Stage exactly what the commit will contain with `git add`.
2. Run the `critic` agent on the staged changes.
3. If it returns `VERDICT: FAIL`, fix the rows marked FAIL, stage the fixes, and run the critic again.
4. When it returns `VERDICT: PASS`, run `git commit` without `-a` or file paths. Approval covers exactly what was staged.

Never skip git hooks or change `core.hooksPath`. Don't amend or rebase a commit after the critic approved it: the approval no longer matches and the push is blocked until the critic reviews it again.

The guard hook reads the whole command, including commit message text. If a message has to mention a blocked term (such as `--no-verify` or `core.hooksPath`), write the message to a file in the scratchpad and run `git commit -F <file>`.

How it is enforced: when the critic returns PASS, `.claude/hooks/critic-record.sh` records a fingerprint of the staged changes. `.githooks/pre-commit` blocks any commit whose staged changes don't match it, and `.githooks/commit-msg` adds a `Critic-Review: pass <fingerprint>` trailer. `.githooks/pre-push` recomputes each outgoing commit's fingerprint and blocks the push if the trailer is missing or doesn't match. Claude Code switches the git hooks on at session start. Without Claude Code, run `git config core.hooksPath .githooks` once per clone.

## Branches
For now, work directly on `main` and push to `origin main`. Don't create feature branches or pull requests.
