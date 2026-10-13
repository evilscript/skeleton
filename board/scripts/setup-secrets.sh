#!/bin/bash
# One-time setup, run by the Owner in their own terminal. Agents never run this
# script: it creates credentials, and no agent asks for, stores or types one.
#
# It makes the board's secrets and stores them where they are needed, without
# printing them:
#   - SESSION_SECRET: signs the Owner's sign-in cookie (a Worker secret).
#   - AGENT_KEYS: one key for each agent in src/agents.ts (a Worker secret, a
#     JSON object of name -> key). Each key is also saved on this machine, where
#     cli/board.mjs reads it: in the macOS Keychain (service = board.keychainService
#     in skeleton.config.json, one account per agent name) when the `security`
#     tool exists, otherwise in a key file ~/.boardkit/<project slug>/keys/<name>
#     (mode 600). A cloud session's key goes into that environment's API
#     credentials (allowed website = the board's host, header Authorization,
#     prefix Bearer) or into BOARD_KEY: read it from the Keychain or the key file.
#   - TURNSTILE_SECRET: the feedback form's anti-spam secret; paste it from the
#     Cloudflare dashboard (Turnstile -> your widget -> Settings). The input is
#     hidden. Skip it to leave the public feedback form switched off.
#
# Run it again to rotate the keys: the old ones stop working at once.
# Needs: node (>= 22.14), npx, and a Wrangler that is signed in (`npx wrangler login`).
# Usage: bash scripts/setup-secrets.sh [--keys-only]
set -euo pipefail
cd "$(dirname "$0")/.."

# The project settings, read from the repository root's skeleton.config.json.
cfg() { node -e 'try{const c=JSON.parse(require("fs").readFileSync("../skeleton.config.json","utf8"));const v={worker:c.board&&c.board.workerName,service:c.board&&c.board.keychainService,slug:c.project&&c.project.slug}[process.argv[1]];process.stdout.write(v||"")}catch{}' "$1"; }
worker=$(cfg worker)
slug=$(cfg slug); slug=${slug:-default}
service=$(cfg service); service=${service:-board}
keydir="$HOME/.boardkit/$slug/keys"
name_flag=()
[ -n "$worker" ] && name_flag=(--name "$worker")

put() { printf '%s' "$2" | npx wrangler secret put "$1" ${name_flag[@]+"${name_flag[@]}"} >/dev/null && echo "  $1 set"; }
random() { node -p 'require("crypto").randomBytes(32).toString("hex")'; }
store_key() { # name key
  if command -v security >/dev/null 2>&1; then
    security add-generic-password -U -s "$service" -a "$1" -w "$2" && echo "  Keychain: $service / $1 saved"
  else
    (umask 077; mkdir -p "$keydir"; printf '%s' "$2" > "$keydir/$1"; chmod 600 "$keydir/$1") && echo "  key file: $keydir/$1 saved"
  fi
}

session=$(random)
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

echo "Cloudflare${worker:+ (Worker $worker)}:"
put SESSION_SECRET "$session"
put AGENT_KEYS "$json"

if [ "${1:-}" != "--keys-only" ]; then
  read -r -s -p "Paste the Turnstile secret key (hidden; Enter to skip): " turnstile
  echo
  if [ -n "$turnstile" ]; then put TURNSTILE_SECRET "$turnstile"; else echo "  TURNSTILE_SECRET skipped"; fi
fi
unset session json key turnstile
echo "Done. Test: BOARD_AS=<an agent name> node cli/board.mjs agents"
