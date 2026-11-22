#!/bin/sh
# PreToolUse hook. Stops Claude from getting around the critic gate, and keeps
# the critic agent read-only. It is a guardrail against mistakes, not a
# security boundary: the git hooks are the actual gate.
input=$(cat)
if ! command -v jq >/dev/null; then
  echo "commit-guard: jq is not installed, so this tool call cannot be checked against the critic gate. Install jq." >&2
  exit 2
fi
field() { printf '%s' "$input" | jq -r "$1 // empty"; }
deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}
tool=$(field .tool_name)
agent=$(field .agent_type)

case "$tool" in
  Write|Edit|MultiEdit|NotebookEdit)
    [ "$agent" = critic ] && deny "The critic is read-only and cannot change files."
    case "$(field '.tool_input.file_path // .tool_input.notebook_path')" in
      .git/*|*/.git/*) deny "Files inside .git hold git settings and the critic approval. Don't edit them directly." ;;
    esac
    ;;
  Bash)
    cmd=$(field .tool_input.command)

    if [ "$agent" = critic ]; then
      # One line made only of characters the shell treats literally (no
      # quotes, braces, globs, variables or operators), so the text checked
      # here is exactly what git receives. Then only these read-only commands,
      # without the options that write files or run programs: --output,
      # --ext-diff, --textconv, and git grep's -O (also inside a group of short
      # options, such as -nO) or --open-files-in-pager, which run a program.
      # git grep is the critic's only way to search: Claude Code may not give
      # agents a Grep tool.
      if [ "$(printf '%s' "$cmd" | wc -l)" -ne 0 ] \
         || printf '%s' "$cmd" | LC_ALL=C grep -q '[^A-Za-z0-9 ._/:@=,%^~+-]' \
         || printf '%s' "$cmd" | grep -qE -- '--(ou|ext|tex|op)' \
         || printf '%s' "$cmd" | grep -qE -- '(^| )-[A-Za-z0-9]*O' \
         || ! printf '%s' "$cmd" | grep -qE '^ *(git +(diff|log|show|status|blame|ls-files|rev-parse|grep)( |$)|(\./)?\.githooks/staged-hash *$)'; then
        deny "The critic can only run one read-only command per call: git diff, log, show, status, blame, ls-files, rev-parse or grep, or .githooks/staged-hash. Commands may use only letters, digits, spaces and . _ / : @ = , % ^ ~ + - (no quotes, braces or globs). Search with git grep (add --cached to search the staged versions) and use the Read tool for files with other characters in their names."
      fi
      exit 0
    fi

    # The checks below read the whole command, commit message text included.
    # Skipping message text to avoid false alarms opened ways to hide commands,
    # so it is not done: a message that mentions a blocked term is denied, and
    # the fix is to write the message to a file and use git commit -F <file>.
    # The command is first joined into one line (dropping backslash-newline
    # continuations), so an option on a later line is still seen.
    cmd=$(printf '%s\n' "$cmd" | awk '{ s = s $0 "\n" } END { gsub(/\\\n/, "", s); gsub(/\n/, " ", s); printf "%s", s }')
    printf '%s' "$cmd" | grep -q 'critic-approved' \
      && deny "Only the critic agent can approve changes for commit."
    printf '%s' "$cmd" | grep -q '\.git/' \
      && deny "Files inside .git hold git settings and the critic approval. Use git commands instead of touching them directly."
    # Reading core.hooksPath is fine; setting, unsetting or overriding it is not.
    # git config takes both the option forms (--get, --remove-section) and,
    # since git 2.46, subcommands (get, remove-section), so allow for both.
    hp='[cC][oO][rR][eE]\.[hH][oO][oO][kK][sS][pP][aA][tT][hH]'
    printf '%s' "$cmd" | sed -E "s/git config ((--)?get |--local )*$hp[[:space:]]*(\$|[;&|)])/\3/g" | grep -qi 'core\.hookspath' \
      && deny "Changing core.hooksPath would switch off the critic gate."
    printf '%s' "$cmd" | grep -qE -- "(^|[[:space:]])(--)?(remove|rename)-section[[:space:]=]+[\"']?core" \
      && deny "Removing the [core] config section would switch off the critic gate."
    printf '%s' "$cmd" | grep -qE -- 'git([[:space:]][^;&|]*)?[[:space:]]config([[:space:]][^;&|]*)?[[:space:]](edit|--edit|-e)([[:space:]]|$)' \
      && deny "Editing git config through an editor could switch off the critic gate. Use git config get/set on a specific key instead."
    # Skipping hooks: --no-verify anywhere in the command (git accepts
    # abbreviations down to --no-veri; matching anywhere also catches it being
    # passed through a variable), or -n on git commit, allowing global options
    # such as -C <path> before it.
    printf '%s' "$cmd" | grep -q -- '--no-veri' \
      && deny "Skipping git hooks would bypass the critic. Run the critic agent and commit normally."
    # -n may be grouped with other no-argument flags (-an, -nm); letters after
    # -u or -S are their value, so -uno is not -n.
    printf '%s' "$cmd" | grep -qE -- 'git([[:space:]][^;&|]*)?[[:space:]]commit([[:space:]][^;&|]*)?[[:space:]]-[aeiopqsvz]*n' \
      && deny "Skipping git hooks would bypass the critic. Run the critic agent and commit normally."
    ;;
esac
exit 0
