#!/bin/bash
# Run by the Lead agent (or by the Owner in any terminal): it asks for nothing. There is no
# board password; the Owner signs in with a one-time link (`npm run owner-link`, scripts/owner-link.sh).
#
# What it sets (Worker secrets, through Wrangler; nothing is printed):
#   - SESSION_SECRET: signs the Owner's session cookie. A new one signs every browser out.
#   - AGENT_KEYS: one key for each agent in src/agents.ts (a JSON object of name -> key).
#     Each key is also saved on this machine, where cli/board.mjs reads it: in the macOS
#     Keychain (service = board.keychainService in skeleton.config.json, one account per
#     name) when the `security` tool exists, otherwise in a key file
#     ~/.boardkit/<project slug>/keys/<name> (mode 600). A cloud session's key goes into
#     that environment's API credentials (allowed website = the board's host, header
#     Authorization, prefix Bearer) or into BOARD_KEY: read it from the Keychain or the key file.
#
# Modes:
#   (none)            everything: a new SESSION_SECRET and new agent keys
#   --sessions-only   a new SESSION_SECRET only: every signed-in browser is signed out (the
#                     Owner gets back in with `npm run owner-link`); the agent keys are not touched
#   --keys-only       new agent keys only; the sessions stay as they are. The old agent keys
#                     stop working at once (a cloud session's credential has to be updated
#                     too). scripts/add-agent.sh adds one agent without touching the others.
# Needs: node (>= 22.14), npx, and a Wrangler that is signed in (`npx wrangler login`).
# Usage: bash scripts/setup-secrets.sh [--sessions-only | --keys-only]
set -euo pipefail
cd "$(dirname "$0")/.."

mode=all
case "${1:-}" in
  "") ;;
  --sessions-only) mode=sessions ;;
  --keys-only) mode=keys ;;
  *) echo "usage: bash scripts/setup-secrets.sh [--sessions-only | --keys-only]" >&2; exit 2 ;;
esac

# The project settings, read from the repository root's skeleton.config.json.
cfg() { node -e 'try{const c=JSON.parse(require("fs").readFileSync("../skeleton.config.json","utf8"));const v={worker:c.board&&c.board.workerName,service:c.board&&c.board.keychainService,slug:c.project&&c.project.slug}[process.argv[1]];process.stdout.write(v||"")}catch{}' "$1"; }
worker=$(cfg worker)
slug=$(cfg slug); slug=${slug:-default}
service=$(cfg service); service=${service:-board}
keydir="$HOME/.boardkit/$slug/keys"
name_flag=()
[ -n "$worker" ] && name_flag=(--name "$worker")

# The value goes to Wrangler on its standard input (printf is a shell builtin: it never shows up in a process list).
put() { printf '%s' "$2" | npx wrangler secret put "$1" ${name_flag[@]+"${name_flag[@]}"} >/dev/null && echo "  $1 set"; }
random() { node -p 'require("crypto").randomBytes(32).toString("hex")'; }
store_key() { # name key
  if command -v security >/dev/null 2>&1; then
    security add-generic-password -U -s "$service" -a "$1" -w "$2" && echo "  Keychain: $service / $1 saved"
  else
    (umask 077; mkdir -p "$keydir"; printf '%s' "$2" > "$keydir/$1"; chmod 600 "$keydir/$1") && echo "  key file: $keydir/$1 saved"
  fi
}

if [ "$mode" != "sessions" ]; then
  names=$(node --experimental-strip-types --no-warnings -e 'import("./src/agents.ts").then((m) => console.log(m.AGENT_NAMES.join(" ")))')
  echo "Local keys (every agent in src/agents.ts gets a new key; a cloud session's credential must be updated too):"
  json="{"
  sep=""
  for n in $names; do
    key=$(random)
    store_key "$n" "$key"
    json="$json$sep\"$n\":\"$key\""
    sep=","
  done
  json="$json}"
fi

echo "Cloudflare${worker:+ (Worker $worker)}:"
if [ "$mode" != "keys" ]; then
  put SESSION_SECRET "$(random)"
fi
if [ "$mode" != "sessions" ]; then
  put AGENT_KEYS "$json"
fi
unset json key
if [ "$mode" = "keys" ]; then
  echo "Done. Test: BOARD_AS=<an agent name> node cli/board.mjs agents"
else
  echo "Done. To sign in, the Owner needs a link: npm run owner-link"
fi
