#!/bin/sh
# scan-preflight.sh — Deterministic, Node-independent preflight for scan.mjs.
#
# Why this exists (2026-07-08 incident): the scheduled Wednesday scan ran in
# an environment with no Node.js installed. scan.mjs can't diagnose that
# problem itself, because you need Node to run a .mjs file in the first
# place. A markdown instruction telling an agent "check for Node and install
# it if missing" is not reliable — the agent that day wrote a question to the
# user instead of following the rule, then logged "complete" with zero work
# done. This script removes the LLM from that specific decision: it is
# plain POSIX shell (works with or without Node), so it runs unconditionally
# and prints one unambiguous machine-readable status line no agent can
# misinterpret or paper over.
#
# Usage: sh scan-preflight.sh
# Exit code 0 + "PREFLIGHT_STATUS=OK"          -> scan.mjs ran, output follows
# Exit code 1 + "PREFLIGHT_STATUS=FAILED_NODE" -> Node unavailable even after
#                                                  attempted auto-install;
#                                                  caller MUST log a FAILED
#                                                  status, never "complete"

set -eu
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  echo "PREFLIGHT_NODE=already-present ($(node -v))"
else
  echo "PREFLIGHT_NODE=missing, attempting auto-install"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1 && apt-get install -y nodejs npm >/dev/null 2>&1 || true
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs npm >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs npm >/dev/null 2>&1 || true
  fi
fi

if command -v node >/dev/null 2>&1; then
  echo "PREFLIGHT_STATUS=OK node=$(node -v)"
  exec node scan.mjs
else
  echo "PREFLIGHT_STATUS=FAILED_NODE node still unavailable after auto-install attempt"
  echo "PREFLIGHT_ACTION_REQUIRED=log FAILED status in data/scan-log.txt, do not write 'complete', then run the Skyvern/WebSearch agent fallback for all tracked_companies"
  exit 1
fi
