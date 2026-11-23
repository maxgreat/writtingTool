#!/bin/bash
# Usage: annotate-log-tail.sh <log file> <title>
# Turns the last 60 lines of a build log into one error annotation, which
# shows on the run's summary page and, unlike the job logs, can be read
# through the GitHub API without signing in.
set -euo pipefail
log=$1
title=$2
[ -s "$log" ] || exit 0
# Workflow commands need %, CR and LF escaped; ANSI colour codes are dropped.
message=$(tail -n 60 "$log" | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' |
  awk '{ gsub(/%/, "%25"); gsub(/\r/, "%0D"); printf "%s%%0A", $0 }')
title=${title//%/%25}
title=${title//,/%2C}
title=${title//:/%3A}
echo "::error title=$title::$message"
