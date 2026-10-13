# Where the board lives

The board is a small program (a Cloudflare Worker with a database) in `board/`. It runs on **your own Cloudflare account**, so the cards, comments and keys stay yours and nobody else hosts anything for you.

## The address

| You have | The board address | Cost |
|---|---|---|
| nothing but an email address (the default) | `https://<worker name>.<your workers.dev subdomain>.workers.dev` | free |
| a domain whose DNS is on Cloudflare | `https://board.<your domain>` (set `board.url` to it) | free (the domain is yours) |

No domain is needed. The `<worker name>` is `board.workerName` in `skeleton.config.json`. The `<your workers.dev subdomain>` is a name you pick once in the Cloudflare dashboard (Workers & Pages, "Your subdomain"); Wrangler cannot pick it for you in an automated run, so do it before the first deploy. Put the final address in `board.url`; `node tools/setup/apply.mjs --board-only` then renders the Worker configuration (a `*.workers.dev` address needs no route).

## What it takes, once

| Step | Who | Needed |
|---|---|---|
| A Cloudflare account (free, an email address is enough) | the Owner | yes |
| Pick the workers.dev subdomain in the dashboard | the Owner | yes (unless a custom domain is used) |
| `npx wrangler login`, or an API token in the Owner's own terminal | the Owner | yes |
| Create the database (`npx wrangler d1 create`) and render the config | the agent, with the Owner's yes | yes |
| `npm run setup:secrets` (the Owner's key, every agent's key, the session secret) | the Owner, in their own terminal | yes |
| `npm run db:remote` and `npm run deploy` | the agent, with the Owner's yes | yes |
| An R2 bucket for card attachments and screenshots | the agent, with the Owner's yes | optional: Cloudflare asks for a payment card before R2 can be switched on, even for free-tier use (reported by users; check Cloudflare's billing page). Without it the board works, only attachments, screenshots and feedback images are off |
| Two GitHub repository secrets so pushes deploy by themselves | the Owner | optional, see below |

## Deploying from GitHub

`.github/workflows/board-deploy.yml` deploys the board whenever `board/` changes on the default branch, and on demand. It needs two repository secrets, which the Owner adds in the repository settings (Settings, Secrets and variables, Actions):

- `CLOUDFLARE_API_TOKEN`: an API token (Cloudflare dashboard, My Profile, API Tokens) with Account > Workers Scripts > Edit and Account > D1 > Edit (plus Workers R2 Storage > Edit if you use R2).
- `CLOUDFLARE_ACCOUNT_ID`: the account id shown on the dashboard.

Without them the workflow does nothing. The first deploy and the secrets of the Worker itself (`npm run setup:secrets`) are always done once by the Owner in their own terminal: GitHub never sees the board's keys. A push that changes a database migration stops the workflow on purpose: back the database up first (`board/docs/MAINTENANCE.md`), then run the workflow by hand with "migrate" ticked.

## Signing in

There is no third-party login. The Owner signs in to the board page with the **owner key** that `npm run setup:secrets` created: `node board/cli/board.mjs owner-key` shows it in the Owner's own terminal (or `--copy` puts it on the clipboard). Run it in a plain terminal: the command refuses to run in an agent session (when `BOARD_AS` is set) and refuses `--copy` without an interactive terminal, so an agent cannot read the key through it. Agents never read it; each agent has its own key and uses the command line. A Worker secret cannot be read back: if the owner key is lost, run `npm run setup:secrets` again (it rotates every key and signs every browser out).

## Why not GitHub Pages

GitHub Pages serves static files only. The board needs a database and an API (cards, comments, keys), so it cannot run there. A read-only copy of the board on GitHub Pages is possible to build, but it is not part of the kit.

## If a team will not use Cloudflare

The kit does not support another host yet. The board is the only part that needs a server: the roles, the constitution and the scripts work with any board that offers the same commands. A board built on GitHub Issues would need no account besides GitHub; it is not built.
