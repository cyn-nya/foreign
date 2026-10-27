#!/usr/bin/env bash
#
# Run the whole suite and derive the counts from *this* run.
#
# `npm run verify` is a chain of `&&`, and two of its steps -- `counts` and
# `copy:check` -- need the log of the run they are part of. They cannot have it:
# the chain's stdout belongs to whoever invoked it, and `count-assertions.mjs`
# falls back to `.cache/verify-latest.log`, which is written by shell redirection
# that the chain never sees.
#
# That produced a failure this round that looked like a documentation bug: verify
# was redirected to a scratch file, so `counts` re-read the *previous* run's log
# and recorded 138 unit tests where the run in front of it had 134, and
# `copy:check` then reported the README as wrong for saying 134.
#
# So the log is written here, where the run is, and the two derived steps run
# after it with the log in hand.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
LOG=".cache/verify-latest.log"
mkdir -p .cache

echo "== verify =="
npm run verify 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  echo
  echo "the suite failed (exit $status); not deriving counts from a partial run"
  exit "$status"
fi

echo
echo "== counts (from this run's log) =="
node tools/count-assertions.mjs "$LOG" || exit 1

echo
echo "== copy:check (against the record just written) =="
node tools/check-copy.mjs || exit 1
