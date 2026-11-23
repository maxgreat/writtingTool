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

## Android check before every push
Before any `git push` that changes app code (skip for docs-only changes):
1. Start the emulator if it isn't running: `emulator -avd writer -no-window -no-audio -no-boot-anim &`, then wait until `adb shell getprop sys.boot_completed` returns 1.
2. Build a debug APK for the emulator's CPU only: `npm run tauri android build -- --debug --apk --target <aarch64 or x86_64>`, then install it with `adb install -r` (the APK is under src-tauri/gen/android/app/build/outputs/apk/).
3. Launch it: `adb shell monkey -p <identifier from tauri.conf.json> -c android.intent.category.LAUNCHER 1`.
4. With mobile-mcp: screenshot the main window; open a chapter, type a sentence containing a known character name, and check the text appears and the name is highlighted; hide and show both side panels.
5. Read `adb logcat -d` for errors or Rust panics from the app.
6. If anything fails, do not push: fix it, or stop and show me the screenshot and log lines. If it passes, push and write "Android check passed" in your summary.
Leave the emulator running afterwards so the next check starts fast.

## Screenshots
The README shows screenshots from `docs/screenshots/`, so the user can see the state of the app after each push. Keep them current: before any push that changes app code, include fresh screenshots in the commits being pushed.
1. Run `npm run screenshots` (desktop and phone sizes, from the interface in a headless browser).
2. During the Android check, after step 4, save the emulator's screen with the chapter open and nothing else on top: `adb exec-out screencap -p > docs/screenshots/android.png`.
3. When a change adds something worth seeing (a dialog, a menu, a new panel), add a scene for it in `scripts/screenshots.mjs` and show it in the README.

## Releases
`.github/workflows/release.yml` builds the app for Linux, Windows, macOS and Android on each push to `main` that changes the app, and publishes a GitHub release named `build-<run number>`. Only the newest 10 builds are kept. The README's Download links point to `releases/latest/download/<file>`, so the release file names (`Writing-Tool-…`) must stay the same. If you rename one, change every link to it in the same commit.

After pushing a change to the app, check that the run passed: `curl -s "https://api.github.com/repos/maxgreat/writtingTool/actions/runs?per_page=1"` (no login needed). If it failed, fix the cause in a new commit, as for any other failure. The Android APK is signed with the key in `~/.android/writing-tool-release.p12` (password in `writing-tool-release.password` next to it), stored in the repository secrets `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`. Without those secrets the release has no APK. The same run also builds the signed App Bundle for Google Play: the run's `play-bundle` artifact (kept 30 days, `gh run download <id> -n play-bundle`), not a file of the release. Its versionCode is the run number, so a bundle Play has already seen can't be uploaded again.

## Branches
For now, work directly on `main` and push to `origin main`. Don't create feature branches or pull requests.
