#!/bin/sh
# SubagentStop hook. When the critic ends with VERDICT: PASS for the changes
# that are still staged, record the approval that .githooks/pre-commit checks.
input=$(cat)
if ! command -v jq >/dev/null; then
  echo '{"systemMessage":"jq is not installed, so the critic approval cannot be recorded and commits stay blocked."}'
  exit 0
fi
[ "$(printf '%s' "$input" | jq -r '.agent_type // empty')" = critic ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(printf '%s' "$input" | jq -r '.cwd')}" || exit 0

msg=$(printf '%s' "$input" | jq -r '.last_assistant_message // empty')
if ! printf '%s\n' "$msg" | grep -q 'VERDICT:'; then
  # A background agent returns its report through a SubagentHandback tool call,
  # and the last message the hook receives is then empty or something other
  # than the report, so read the report from its transcript. Claude Code
  # leaves agent_transcript_path empty in some modes; the transcript is then
  # found next to the session's transcript, or under the session id, by the
  # agent id.
  get() { printf '%s' "$input" | jq -r "$1 // empty"; }
  transcript=$(get .agent_transcript_path)
  agent=$(get .agent_id)
  session=$(get .session_id)
  session_transcript=$(get .transcript_path)
  case "$agent" in '' | *[!A-Za-z0-9_-]*) agent="" ;; esac
  case "$session" in '' | *[!A-Za-z0-9_-]*) session="" ;; esac
  if [ ! -f "$transcript" ] && [ -n "$agent" ] && [ -n "$session_transcript" ]; then
    transcript="${session_transcript%.jsonl}/subagents/agent-$agent.jsonl"
  fi
  if [ ! -f "$transcript" ] && [ -n "$agent" ] && [ -n "$session" ]; then
    for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$session"/subagents/"agent-$agent.jsonl"; do
      [ -f "$f" ] && transcript=$f && break
    done
  fi
  # Only a report written after the latest prompt counts: a critic resumed
  # with a follow-up keeps its transcript, earlier reports included. Prompts
  # are user entries with text that are not marked isMeta (system reminders
  # are). Claude Code writes the transcript in batches, so the report can
  # reach the file just after this hook starts: read it again for up to 10
  # seconds. One JSON object per line; a line still being written is skipped.
  tries=0
  while [ -f "$transcript" ]; do
    msg=$(jq -Rrn '[inputs | fromjson?] as $entries
        | ([$entries | to_entries[] | select(.value.type == "user" and (.value.isMeta | not)
              and ((.value.message.content | type) == "string"
                   or any(.value.message.content[]?; .type == "text")))]
           | last | .key // -1) as $prompt
        | [$entries[$prompt + 1:][] | select(.type == "assistant") | .message.content[]?
           | select((.type == "tool_use" and .name == "SubagentHandback") or .type == "text")
           | (.input.message // .text)] | last // empty' "$transcript")
    printf '%s\n' "$msg" | grep -q 'VERDICT:' && break
    tries=$((tries + 1))
    [ "$tries" -ge 10 ] && break
    sleep 1
  done
fi
marker=$(git rev-parse --git-path critic-approved)
rm -f "$marker"

verdict=$(printf '%s\n' "$msg" | grep -oE 'VERDICT:[[:space:]]*(PASS|FAIL)' | tail -n1 | grep -oE 'PASS|FAIL')
reviewed=$(printf '%s\n' "$msg" | grep -oE 'Reviewed:[[:space:]`]*[0-9a-f]{40,64}' | tail -n1 | grep -oE '[0-9a-f]{40,64}')
# A FAIL row overrides a PASS verdict.
printf '%s\n' "$msg" | grep -qE '\|[[:space:]*]*FAIL[[:space:]*]*\|' && verdict=FAIL
staged=$(.githooks/staged-hash)

if [ "$verdict" = PASS ] && [ -n "$staged" ] && [ "$reviewed" = "$staged" ]; then
  printf '%s\n' "$staged" > "$marker"
  echo '{"systemMessage":"Critic approved the staged changes. They can be committed."}'
elif [ "$verdict" = PASS ]; then
  echo '{"systemMessage":"Critic said PASS, but the staged changes are not the ones it reviewed. Run the critic again before committing."}'
elif [ -z "$verdict" ]; then
  echo '{"systemMessage":"The critic finished without a VERDICT line, so no approval was recorded."}'
fi
exit 0
