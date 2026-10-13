#!/bin/bash
# Gives a new developer its key without touching anyone else's. Run by the Lead
# in their own terminal once the Owner has named the developer; agents never run
# this script on their own, because it creates a credential.
#   1. add { name, label } to AGENT_LIST in src/agents.ts (or add the role to
#      skeleton.config.json and re-run tools/setup/apply.mjs), then
#      npm run check && npm test && npm run deploy;
#   2. bash scripts/add-agent.sh <name>
# It makes a key for <name> on this machine when there is none (macOS Keychain
# service = board.keychainService in skeleton.config.json, account <name>, when
# the `security` tool exists; otherwise the key file ~/.boardkit/<project
# slug>/keys/<name>, mode 600), then sets the Worker's AGENT_KEYS secret from the
# stored keys of every agent in src/agents.ts: the other keys are read, not
# changed, so nobody has to enter anything again. The developer signs in with
#   BOARD_AS=<name> node cli/board.mjs ...   (the key is found on this machine), or
# BOARD_KEY=<the key> for a session that has no Keychain or key file (a cloud
# environment's API credential).
# Nothing secret is printed.
# Needs: node (>= 22.14), npx, and a Wrangler that is signed in (`npx wrangler login`).
set -euo pipefail
cd "$(dirname "$0")/.."
name=${1:?usage: scripts/add-agent.sh <name>}

cfg() { node -e 'try{const c=JSON.parse(require("fs").readFileSync("../skeleton.config.json","utf8"));const v={worker:c.board&&c.board.workerName,service:c.board&&c.board.keychainService,slug:c.project&&c.project.slug}[process.argv[1]];process.stdout.write(v||"")}catch{}' "$1"; }
worker=$(cfg worker)
slug=$(cfg slug); slug=${slug:-default}
service=$(cfg service); service=${service:-board}
keydir="$HOME/.boardkit/$slug/keys"
name_flag=()
[ -n "$worker" ] && name_flag=(--name "$worker")

get_key() { # name -> prints the stored key, fails when there is none
  local k
  if command -v security >/dev/null 2>&1; then
    k=$(security find-generic-password -s "$service" -a "$1" -w 2>/dev/null) && [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  fi
  [ -f "$keydir/$1" ] && { cat "$keydir/$1"; return 0; }
  return 1
}
store_key() { # name key
  if command -v security >/dev/null 2>&1; then
    security add-generic-password -U -s "$service" -a "$1" -w "$2"
  else
    (umask 077; mkdir -p "$keydir"; printf '%s' "$2" > "$keydir/$1"; chmod 600 "$keydir/$1")
  fi
}

names=$(node --experimental-strip-types --no-warnings -e 'import("./src/agents.ts").then((m) => console.log(m.AGENT_NAMES.join(" ")))')
case " $names " in
  *" $name "*) ;;
  *) echo "$name is not in AGENT_LIST (src/agents.ts) yet: add it and deploy first" >&2; exit 1 ;;
esac
if ! get_key "$name" >/dev/null; then
  store_key "$name" "$(node -p 'require("crypto").randomBytes(32).toString("hex")')"
  echo "  made a key for $name"
fi
json="{"
sep=""
included=""
for n in $names; do
  if key=$(get_key "$n"); then
    json="$json$sep\"$n\":\"$key\""
    sep=","
    included="$included $n"
  else
    echo "  no stored key for $n: left out (it can't sign in)" >&2
  fi
done
json="$json}"
printf '%s' "$json" | npx wrangler secret put AGENT_KEYS ${name_flag[@]+"${name_flag[@]}"} >/dev/null
echo "  AGENT_KEYS set for:$included"
unset json key
echo "Done. Test: BOARD_AS=$name node cli/board.mjs agents"
