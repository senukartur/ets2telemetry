#!/usr/bin/env bash
# One GitHub REST GET for the release workflow (ET-055 PR-9; docs/release.md, "Release workflow"):
#   bash scripts/release/gh-get.sh <api path> <output file>
# Exit 0: the JSON body is in the output file. Exit 44: HTTP 404, and the output file is empty (gh writes the error body
# to standard output, which must never be read as an answer). Exit 1: any other failure, with gh's message on standard
# error. A missing resource is therefore never confused with a failed request, and a failed request never passes as
# "missing".
set -u
if [[ $# -ne 2 ]]; then echo 'Usage: gh-get.sh <api path> <output file>' >&2; exit 1; fi
api_path="$1"
output="$2"
errors="$(mktemp)"
if gh api "$api_path" > "$output" 2> "$errors"; then
  rm -f "$errors"
  exit 0
fi
if grep -q 'HTTP 404' "$errors"; then
  : > "$output"
  rm -f "$errors"
  exit 44
fi
cat "$errors" >&2
rm -f "$errors"
exit 1
