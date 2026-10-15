#!/bin/bash
# Makes the Owner's sign-in link and opens it in the Owner's browser. There is no board password:
# the link is how the Owner gets in, on the first day and on every new device or browser after.
#
# What it does: makes a random 256-bit token, stores only its SHA-256 hash in the board's database
# (table owner_links, good for 15 minutes, one use), and opens
#   <board address>/board/#link=<token>
# The board page reads the token from the address fragment, signs the browser in (a cookie that
# lasts 30 days) and removes the fragment. The link works once; a used or expired one is just
# refused, so it is safe even if it was seen in a terminal or a chat.
#
# Run it as the Lead agent at the end of the setup, and again whenever the Owner says they are
# signed out or want another device ("give me a sign-in link"). It needs the database migration
# 0016 (`npm run db:remote`) and a Wrangler that is signed in; it does not need a terminal.
# Usage: bash scripts/owner-link.sh [--print]
#   --print   write the link to the standard output instead of opening a browser (for a Lead
#             that runs on another machine than the Owner's browser: hand the link to the Owner,
#             who opens it within 15 minutes)
#   --local   make the link for `npm run dev` (the local database and http://localhost:8787)
set -euo pipefail
cd "$(dirname "$0")/.."

print=0 local_db=0
for a in "$@"; do
  case "$a" in
    --print) print=1 ;;
    --local) local_db=1 ;;
    *) echo "usage: bash scripts/owner-link.sh [--print] [--local]" >&2; exit 2 ;;
  esac
done

url=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync("../skeleton.config.json","utf8"));process.stdout.write((c.board&&c.board.url)||"")}catch{}')
if [ "$local_db" = 1 ]; then url="http://localhost:8787"; fi
case "$url" in
  ""|*setup-pending*) echo "The board has no address yet. Deploy it first (npm run deploy), then store the address with node tools/setup/apply.mjs --set-board-url <address>." >&2; exit 1 ;;
esac
url=${url%/}

token=$(node -p 'require("crypto").randomBytes(32).toString("base64url")')
hash=$(printf '%s' "$token" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(require("crypto").createHash("sha256").update(s).digest("hex")))')
expires=$(node -p 'Math.floor(Date.now()/1000)+15*60')
where=--remote
[ "$local_db" = 1 ] && where=--local
# (only hex digits and digits go into the statement, so there is nothing to escape)
npx wrangler d1 execute DB "$where" --command "INSERT INTO owner_links(hash, expires_at) VALUES ('$hash', $expires)" >/dev/null || {
  echo "Could not store the link. Is the database up to date (npm run db:remote) and is Wrangler signed in (npx wrangler whoami)?" >&2
  exit 1
}

link="$url/board/#link=$token"
if [ "$print" = 1 ]; then
  printf '%s\n' "$link"
  echo "(One use, valid for 15 minutes.)" >&2
  exit 0
fi
if command -v open >/dev/null 2>&1; then open "$link"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$link" >/dev/null 2>&1
elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$link" >/dev/null 2>&1
else
  printf '%s\n' "$link"
  echo "(No browser could be opened here: open this link yourself within 15 minutes; it works once.)" >&2
  exit 0
fi
echo "Opened the board's sign-in link in your browser (it works once and expires in 15 minutes)."
echo "If it did not open, or you want another device: npm run owner-link -- --print"
