#!/bin/sh
# Creates the GitHub labels the review process uses in the project repository (safe to repeat: existing labels are left alone).
#   sh tools/setup/labels.sh [owner/repo]     default: the repository of the current folder's "origin" remote
# Needs the GitHub CLI logged in. It changes only labels, nothing else.
set -eu
repo="${1:-}"
flags=""
[ -n "$repo" ] && flags="--repo $repo"

make() { # name color description
  # shellcheck disable=SC2086
  if gh label create "$1" --color "$2" --description "$3" $flags >/dev/null 2>&1; then echo "created: $1"; else echo "kept:    $1"; fi
}

make "Lead: changes needed" "fbca04" "The Lead sent it back: the card is the Developer's again"
make "Lead: merged" "6f42c1" "The Lead merged it into the default branch"
make "Needs the owner" "d93f0b" "The pull request holds a question only the Owner can answer"
make "QA: pass" "0e8a16" "The QA ran the project's check command on it and it passed"
make "QA: fail" "d73a4a" "The QA ran the project's check command on it and it failed"
