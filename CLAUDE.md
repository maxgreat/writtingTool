# Project instructions

## Agents
- `ui-designer` (`.claude/agents/ui-designer.md`): use for any change to the user interface.
- `critic` (`.claude/agents/critic.md`): read-only reviewer. It must approve every commit.

## Committing
Commit and push regularly, without waiting to be asked. As soon as a piece of work is finished and tested (a feature, a fix, a rule change), commit it and push it. Don't leave finished work uncommitted or unpushed, and don't save several finished pieces for one big commit. If something blocks a commit or a push, tell the user right away.

Every commit must be approved by the critic first, and pushes are blocked otherwise.

1. Stage exactly what the commit will contain with `git add`.
2. Run the `critic` agent on the staged changes.
3. If it returns `VERDICT: FAIL`, fix the rows marked FAIL, stage the fixes, and run the critic again.
4. When it returns `VERDICT: PASS`, run `git commit` without `-a` or file paths. Approval covers exactly what was staged.

Never skip git hooks or change `core.hooksPath`. Don't amend or rebase a commit after the critic approved it: the approval no longer matches and the push is blocked until the critic reviews it again.

The guard hook reads the whole command, including commit message text. If a message has to mention a blocked term (such as `--no-verify` or `core.hooksPath`), write the message to a file in the scratchpad and run `git commit -F <file>`.

How it is enforced: when the critic returns PASS, `.claude/hooks/critic-record.sh` records a fingerprint of the staged changes. `.githooks/pre-commit` blocks any commit whose staged changes don't match it, and `.githooks/commit-msg` adds a `Critic-Review: pass <fingerprint>` trailer. `.githooks/pre-push` recomputes each outgoing commit's fingerprint and blocks the push if the trailer is missing or doesn't match. Claude Code switches the git hooks on at session start. Without Claude Code, run `git config core.hooksPath .githooks` once per clone.

## Pushing
Push to `origin main` after each commit. `.githooks/pre-push` checks two things, in this order:

1. Every outgoing commit has a matching critic approval (see above).
2. The app built from each pushed branch starts. `.githooks/verify-launch` builds the release app from a clean copy of the commit (uncommitted and untracked files don't count) and starts it with empty data folders. It passes once a chapter opens in the editor. It fails if the build fails, if the app quits early, or if no chapter shows within 60 seconds. The window appears for a moment.

The check needs `npm` and `cargo` on PATH and a desktop session. A push takes a minute or two, so give the push command a long timeout. If the check fails, fix the cause in a new commit, approved by the critic as usual, then push again. To run the check without pushing, use `.githooks/verify-launch` (checks HEAD) or `.githooks/verify-launch <commit>`.

## Branches
For now, work directly on `main` and push to `origin main`. Don't create feature branches or pull requests.
