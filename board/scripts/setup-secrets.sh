#!/bin/bash
# Run by the Owner in their own terminal. Agents never run this script: it asks for the
# Owner's password and creates credentials, and no agent asks for, stores or types one.
#
# What it sets (Worker secrets, through Wrangler; nothing is printed):
#   - OWNER_PASSWORD: the password the Owner signs in with on the board page. The Owner
#     chooses it here, at a hidden prompt typed twice (at least 12 characters). It is
#     never echoed, never put on a command line and never written to a file or a key
#     store: the Owner knows it, and nothing on this machine remembers it.
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
#   (none)            everything: a new password, a new SESSION_SECRET and new agent keys
#   --password-only   a new password and a new SESSION_SECRET (every signed-in browser is
#                     signed out); the agent keys are not touched. This is also how a lost
#                     password is reset: npm run setup:secrets -- --password-only
#   --keys-only       new agent keys only; the password and the sessions stay as they are.
#                     The old agent keys stop working at once (a cloud session's credential
#                     has to be updated too). scripts/add-agent.sh adds one agent without
#                     touching the others.
# Needs: node (>= 22.14), npx, a terminal, and a Wrangler that is signed in (`npx wrangler login`).
# Usage: bash scripts/setup-secrets.sh [--password-only | --keys-only]
set -euo pipefail
cd "$(dirname "$0")/.."

mode=all
case "${1:-}" in
  "") ;;
  --password-only) mode=password ;;
  --keys-only) mode=keys ;;
  *) echo "usage: bash scripts/setup-secrets.sh [--password-only | --keys-only]" >&2; exit 2 ;;
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

password=""
if [ "$mode" != "keys" ]; then
  # Ask first, before anything is changed anywhere. A terminal is required: the password is typed, never piped in.
  if [ ! -t 0 ]; then echo "This script asks for the password at a hidden prompt: run it yourself in a terminal." >&2; exit 1; fi
  IFS= read -r -s -p "Choose the password for the board (at least 12 characters, hidden): " password; echo
  IFS= read -r -s -p "Type it again: " again; echo
  if [ "$password" != "$again" ]; then echo "The two entries differ. Nothing was changed." >&2; exit 1; fi
  unset again
  # Counted the way the Worker counts it (characters, not bytes); the value reaches node on its standard input, not on a command line.
  if ! printf '%s' "$password" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.exit(Array.from(s).length>=12&&s===s.trim()?0:1))'; then
    echo "The password must be at least 12 characters and must not start or end with a space. Nothing was changed." >&2
    exit 1
  fi
fi

if [ "$mode" != "password" ]; then
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
  put OWNER_PASSWORD "$password"
  put SESSION_SECRET "$(random)"
fi
if [ "$mode" != "password" ]; then
  put AGENT_KEYS "$json"
fi
unset password json key
if [ "$mode" = "keys" ]; then
  echo "Done. Test: BOARD_AS=<an agent name> node cli/board.mjs agents"
else
  echo "Done. Open the board page and sign in with the password you chose."
fi
