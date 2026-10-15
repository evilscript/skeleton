# Board

A small task board for a team of one human (the **Owner**) and any number of AI agents: one Cloudflare Worker with a D1 database
(cards, comments, chips, activity), optional file storage (screenshots and attachments), a web page and a command-line tool. It runs on
Cloudflare's free tier, needs no domain and no build step, and the Owner signs in with a one-time link, not with a password or a
third-party account. Nothing is public except the sign-in page.

Cards have a number (global), a status, chips, a priority, an assignee and comments. **Typed, addressed card comments are the channel
agents use to talk to each other and to the Owner.** The Owner reads and writes on the web page; agents use `cli/board.mjs`.

| Path | Who | What |
|---|---|---|
| `/board/` | the Owner (a sign-in link) | the board, one project at a time |
| `/` | | redirects to `/board/` |
| `/api/...` | the Owner's session or an agent's key | the JSON API the page and the CLI use (`GET /api/info`, `GET /api/config` and the sign-in `POST /api/session` need no credentials) |

The name the page shows comes from the Worker's public variable `PROJECT_NAME` (`GET /api/info`); it falls back to "Board". The same
answer carries the file storage and the language of the page:
`{ "projectName": "...", "files": true, "fileStorage": "d1", "maxFileBytes": 1572864, "language": "en" }`.

## Signing in

- **The Owner has no password.** The Lead agent runs `npm run owner-link` (in `board/`, after the database migrations and the deploy): the
  script makes a random 256-bit token, stores only its SHA-256 hash in the table `owner_links` (good for 15 minutes, one use) and opens
  `https://<board>/board/#link=<token>` in the Owner's browser. Nothing is typed, chosen or remembered. `npm run owner-link -- --print`
  prints the link instead of opening it (for a Lead that runs on another machine than the Owner's browser: the Owner opens it within 15
  minutes); `-- --local` makes one for `wrangler dev`.
- The page reads the token from the address fragment (a fragment never reaches a server log, and a chat app that previews the link cannot
  use it up), removes it from the address bar and sends it once (`POST /api/session` with `{ "link": "..." }`). A right one is deleted in
  the same statement that finds it (so two requests with the same link cannot both win) and sets a signed cookie (HMAC with
  `SESSION_SECRET`, `HttpOnly`, `Secure`, `SameSite=Lax`, 30 days); a used, expired or made-up one is answered `403 link_invalid`. A token
  cannot be guessed (256 bits, looked up by its hash), so there is nothing to throttle. Writes with the cookie also need the page's own
  origin and the `x-board` header, so another site cannot make the Owner's browser change cards. **Sign out** (`DELETE /api/session`)
  clears the cookie. Everywhere on the board the Owner is `OWNER_ASSIGNEE` from `src/agents.ts` (default `owner`, label "Owner").
- **A new device, a new browser, or a cookie that ran out:** the Owner tells the Lead "give me a sign-in link"; the Lead runs
  `npm run owner-link` again. There is nothing to forget and nothing to reset. `npm run setup:secrets -- --sessions-only` signs every
  browser out at once.
- **A missing `SESSION_SECRET` locks the sign-in out:** it answers `503 sign_in_locked` and keeps the link. (`npm run setup:secrets` sets it.)
- **Agents** never use the cookie: each has its own key (`Authorization: Bearer ...`, at least 32 characters) and uses the command line.
  A sign-in link is not accepted as an agent key, nor a key as a link.
- Local development only (`wrangler dev`, `ENVIRONMENT=development` on `localhost`): the page also offers a development sign-in that
  needs no link.

## File storage: none, d1 or r2

Screenshots and attachments need somewhere to live. The Worker variable `FILE_STORAGE` says where, and the first-run questionnaire sets
it (`board.fileStorage` in `skeleton.config.json`; `node tools/setup/apply.mjs` renders it into `wrangler.jsonc`):

| `FILE_STORAGE` | Where the bytes live | Cost and setup | Limits | Choose it when |
|---|---|---|---|---|
| `none` (the default) | nowhere | nothing | no screenshots, no attachments | you only want cards and comments |
| `d1` | a table of the board's own database (`file_blobs`, migration `0014`) | free; no extra service and no payment card; nothing to set up | one file at most 1.5 MB (D1 keeps a row under 2 MB); the database has its own size limit (500 MB on the free plan), and the files count against it | you want pictures without a card on file; ordinary screenshots fit once the page has shrunk them |
| `r2` | an object in a Cloudflare R2 bucket | R2 asks for a payment card even for free-tier use; create the bucket (`npx wrangler r2 bucket create <name>`) and put its name in `board.r2Bucket` | one file at most 25 MB | you attach big files, or expect many |

A missing or unknown `FILE_STORAGE` is `none`, with one exception: a Worker that has the `FILES` R2 binding and no `FILE_STORAGE` variable
(a board deployed before the variable existed) behaves as `r2`. `r2` with no bucket is `none`.

- **What the Worker does.** `POST /api/cards/<n>/files` and `GET /api/files/<id>` work in `d1` and `r2` the same way: the Worker asks one
  small store (`src/storage.ts`) and never branches on the mode. A file over the limit is answered `413 file_too_large`; with `none` both
  endpoints answer `501 { "error": "files_disabled" }`. Deleting a file or purging a card deletes the bytes too (the `file_blobs` rows in
  `d1`, the objects in `r2`); with `none` it only cleans the database. `GET /api/info` answers `files`, `fileStorage` and `maxFileBytes`.
- **The board page** hides the screenshot and file rows of a card and the image counts when `files` is false. With `d1` the page shrinks a
  picture that is over the limit before it uploads it (the longest side at most 1600 px, saved as JPEG at lower and lower quality until it
  fits); a file that is not a picture, or a picture that still does not fit, is refused with a clear message, and the Worker's limit stays
  the real guard.
- **`node cli/board.mjs attach`** asks `GET /api/info` first and says plainly when the board has no storage or the file is over its limit.
- **Switching later.** Change `board.fileStorage` (and, for `r2`, `board.r2Bucket`), run `node tools/setup/apply.mjs --board-only`, deploy
  again. **Switching does not move files:** a file stays where it was written, and the new mode cannot read it, so a card's old
  screenshots show as broken until you add them again (or switch back). Going from `d1` to another mode leaves the old bytes in
  `file_blobs`; `npx wrangler d1 execute DB --remote --command "DELETE FROM file_blobs"` frees the space once you are sure.
  A backup of a `d1` board holds the files; one of an `r2` board does not (see [docs/MAINTENANCE.md](docs/MAINTENANCE.md)).

## Language of the page

The page's language is the Worker variable `BOARD_LANGUAGE` (`board.language` in `skeleton.config.json`, rendered by
`node tools/setup/apply.mjs`; `GET /api/info` answers it as `language`; a missing or invalid value is `en`). Every text the page shows is
in a pack, `public/i18n/<code>.json`: a flat dictionary of stable ids to texts, with `{name}` placeholders. English (`en.json`) and
Simplified Chinese (`zh-CN.json`) are shipped. The page loads the pack for the language, uses English for any key the pack lacks, sets
`<html lang>` from it, formats dates and sizes with `Intl` in that language and stays hidden until the pack is applied (it shows after
2.5 seconds whatever happens).

**Adding a language:** copy `public/i18n/en.json` to `public/i18n/<code>.json` (a language code such as `fr` or `pt-BR`), translate the
values and keep the ids and every `{placeholder}` exactly as they are, set `board.language` to the code, run
`node tools/setup/apply.mjs --board-only` and deploy. An AI agent can do the translation: give it `en.json` and the code. `npm test`
checks that a pack has exactly the keys of English, the same placeholders for each, and that every id the page uses exists.

Server answers stay codes (`link_invalid`, `file_too_large`, ...): the page maps the ones a person can meet to the pack's messages.
The command-line tool stays in English on purpose, because it is the agents' protocol.

## Statuses and columns

Every card has a **status**; a column shows the cards of one or more statuses ([docs/STATUSES.md](docs/STATUSES.md) says who moves a card
where).

| Column | Statuses (slug, label) |
|---|---|
| Backlog | `backlog` Backlog, `todo` To do |
| In progress | `progress` In progress, `pr_review` PR reviewing, `spike_ready` Spike report ready, `on_main` On Main (the page draws the last three as their own column, PR submitted) |
| Ready for QA | `probe_needed` Owner check needed, `on_prod_qa` On Prod for QA, `qa_later` QA later |
| Done | `done` Done |

A new card starts in backlog; the Owner moves one to todo when work should start on it. The stored `col` (the column key: `backlog
progress testing done`) follows the status in one place, `columnOf` in `public/board/statuses.js`, which the Worker, the page,
the CLI and the tests share. The old column words `todo`, `later` and `testing` are still accepted as input (`col: "todo"` is the status
todo, `later` is `qa_later`, `testing` is `on_prod_qa`; any other column name means its first status).

On the page each column is drawn as one bordered **layer** per status (always there, even empty). Drag a card onto a layer to set its
status, inside a layer to put it higher or lower; the arrow buttons on a layer's header move the layer inside its column (the order is
kept in the browser, per project). Done is not on the board: the top bar's
Done button (it shows the count and takes dropped cards) opens a floating panel that loads when opened and unloads when closed. The top
bar filters by assignee, priority and chip, and switches between the system's colours, light and dark.

## Projects

Every card, chip and comment belongs to one project. A project has a **key** (`main`, `home-lab`: lowercase letters, digits and hyphens,
up to 30, never changes, `all` is reserved) and a name (can be renamed). The first migrations create the default project with the key
`main`; rename it once the board is deployed (`board projects rename main "Project Name"`). The top bar's switcher opens a project; its
**Projects...** button adds or renames one. The page remembers the last project and `/board/?p=<key>` links straight to one. A new project
starts with the chips Bug and Feature.

- **Card numbers are global**, not per project: `#12` names one card everywhere, so a number never needs its project. A new project's
  first card gets the next free number.
- **Chips are per project**, and so are the comment feed, the unread mark and the change check.
- API: `?project=<key>` on the cards, chips, version, activity and comments calls (the default project when left out); `?project=all` on
  `/api/comments`. `GET/POST /api/projects`, `PATCH /api/projects/<key>` (name). Create a card in a project with `"project": "<key>"` in
  the body. Projects are not deleted, and cards cannot move from one project to another.
- A project can hide statuses, rename some and reorder a column's layers: see `PROJECT_LAYOUTS` in `public/board/statuses.js`.

## Agents and the CLI: `cli/board.mjs`

The agents are listed once, in `AGENT_LIST` in `src/agents.ts` (name = the identity, label = what the page shows). The Worker, the page
(`GET /api/agents`) and the CLI (`board agents`) all read it. In a project made from this template the two data lines between the
`// <agents:begin>` and `// <agents:end>` markers are generated from `skeleton.config.json` by `node tools/setup/apply.mjs`; a **limited**
agent (the QA role) reads everything and may only add comments of type `note`, `question` or `blocked`.

Environment variables (a name here is the agent's board name):

| Variable | Meaning |
|---|---|
| `BOARD_AS` | your identity on the board; the CLI refuses to run without it (or `BOARD_KEY`) |
| `BOARD_KEY` | your key. `BOARD_KEY_<NAME>` (the name in capitals, `-` as `_`) is read first, for a machine that several agents share; the plain `BOARD_KEY` is then checked against `BOARD_AS` once (`GET /api/me`) so a wrong key cannot write under another agent's name |
| `BOARD_AUTH=proxy` | a cloud session whose proxy adds the credential on the way out: the CLI sends no key itself |
| `BOARD_URL` | the board's address; default `board.url` from `skeleton.config.json` |
| `BOARD_PROJECT` | the project key; default `board.defaultProject` (`main`) |
| `BOARD_BRIEF_DIR`, `BOARD_BACKUP_DIR` | where `brief` and `npm run backup` write; default under `~/.boardkit/<project slug>/` |

Without `BOARD_KEY`, the key for `BOARD_AS` is read from the macOS Keychain (service `board.keychainService` in `skeleton.config.json`,
account = the board name), then from the key file `~/.boardkit/<project slug>/keys/<board name>` (mode 600). The config file is found by
walking up from `cli/` and then from the current directory; `<project slug>` is `project.slug`, or `default` without a config. The key is
never printed.

```bash
export BOARD_AS=<your board name>
node cli/board.mjs agents                           # who can be assigned and written to
node cli/board.mjs list --status todo               # or --col backlog for the whole column
node cli/board.mjs show 12
node cli/board.mjs new "Title" --desc "What and why" --chip Bug      # prints the new number
node cli/board.mjs move 12 pr_review                # a status; a column name means its first status
node cli/board.mjs set 12 --desc-file steps.md --assignee <name> --priority major
node cli/board.mjs chip 12 +Bug -Feature
node cli/board.mjs attach 12 shot.png --screenshot
node cli/board.mjs comment 12 "Ready for review" --to <name> --type review --ref https://example.com/pull/7
node cli/board.mjs thread 12                        # one card's conversation
node cli/board.mjs inbox                            # comments addressed to you that you have not seen, in every project
node cli/board.mjs chips                            # chips and how many cards use each
node cli/board.mjs usage                            # today's UTC D1 rows against the free allowance
node cli/board.mjs projects                         # key and name of each project
node cli/board.mjs projects add "Home Lab"          # key home-lab (--key for a name with no latin letters)
node cli/board.mjs new "Rack the servers" --project home-lab
export BOARD_PROJECT=home-lab                       # or set the project once
```

`node cli/board.mjs` with no command (or `--help`) prints the full command list. The Owner's sign-in has no command in this tool: the link
comes from `npm run owner-link` (see "Signing in"). `list`, `new`, `chips`, `feed` and `version` work in one project
(`--project`, else `BOARD_PROJECT`, else `board.defaultProject`, else `main`). `list` leaves the done cards out (it says how many) unless
you ask with `--col done` or `--all`. Cards are found by number in every project; `inbox` is yours across all projects. In a project made
from this template, `node tools/board.mjs <command>` runs the same tool from any checkout.

Rules: take a card number from `new`, never pick one yourself; a card's status says where it is; do not take a card assigned to someone
else. Only the Owner can delete a card for good.

## Layout

- `src/index.ts` - routing, cards, chips, files, comments, the sign-in.
- `src/auth.ts` - the sign-in link's hash, the Owner's session cookie, agent keys.
- `src/storage.ts` - where file bytes live: `none`, `d1` or `r2` (one small store, the same calls in each).
- `src/agents.ts` - the agents (see above). `src/validation.ts` - input rules.
- `public/board/` - the board page (no build step). `public/board/statuses.js` is the status table (ten statuses).
- `public/shared/i18n.js` - the loader of the language packs; `public/shared/shrink.js` - shrinks a picture before an upload;
  `public/i18n/<code>.json` - the packs (`en`, `zh-CN`).
- `cli/board.mjs`, `cli/usage.mjs`, `cli/config.mjs` - the command line (the config reader uses plain `fs`; nothing outside `board/` is imported).
- `migrations/` - the D1 schema, applied in order (`0005` adds projects, `0006` per-column counts, `0007` the files index, `0008` quotas and
  stored chip counts, `0009` the priority, `0011` the card status, `0013` an open status column, `0014` the file bytes of a `d1` board,
  `0015` a sign-in throttle that `0016` drops again, `0016` the one-time sign-in links).
- `scripts/setup-secrets.sh`, `scripts/add-agent.sh` - the Worker secrets and the agent keys (nothing is asked; they never print a key);
  `scripts/owner-link.sh` - the Owner's one-time sign-in link; `scripts/backup.mjs` - manual verified backups.
- `wrangler.jsonc.tmpl` - the Worker configuration template; `tools/setup/apply.mjs` renders it to `wrangler.jsonc`.
- `docs/STATUSES.md`, `docs/MAINTENANCE.md` - the status table and the quota, usage and backup notes.

## Keeping D1 reads low

D1's free tier counts rows read per day. With about a thousand cards (most of them done) a refresh reads about 900 rows, almost all of it
the board's own cards. The habits that keep it there:

- The page asks `/api/version` (two one-row reads) every 30 seconds and when you come back to the tab, and reloads only when it changed.
- A reload is one request, `/api/cards?hide=done&version=1&chips=1`, one batch: the cards, the change check (read first) and the chips.
- Done is not loaded until its panel opens, and its count is one row of `column_counts`, not a `COUNT(*)`. **Every write that creates,
  moves, removes or restores a card must bump it** (`bump()` in `src/index.ts`).
- Chip `used` counts are maintained transactionally by card triggers, scoped to `(project_id, name)`. `?counts=1` (the chip manager and the
  CLI) reads only chip rows. Ordinary card edits never rebuild counts with a card/JSON scan.
- A card's screenshot and attachment counts and thumbnail are one pass over `files_card_stats`, an index that holds every column it needs.
- A project key's id is remembered per isolate, so most requests skip the lookup.
- The CLI's `list` leaves done out.

D1 bills rows read and written, not calls, so measure a query's `meta.rows_read` through the D1 binding (`wrangler d1 execute --local` does
not report it). Quota rules, daily usage and the backup script: [docs/MAINTENANCE.md](docs/MAINTENANCE.md).

## Set up and deploy for a new owner

Everything below runs in **your own terminal and browser**. Credentials are created by you in the vendors' consoles or by the scripts you
run; no agent asks for, stores or types one. The default path needs no domain and no payment card.

1. **Prerequisites.** Node 22.14 or newer and a free Cloudflare account. Sign Wrangler in yourself: `npx wrangler login` (it opens a
   browser). Then `npm install` in `board/`.
2. **Pick the address.** The default is free and needs no domain: `https://<workerName>.<subdomain>.workers.dev`. Before the first deploy,
   register your account's workers.dev subdomain once in the dashboard (Workers & Pages, "Your subdomain"); Wrangler cannot do this
   non-interactively. Put the address in `board.url` in `skeleton.config.json`. The apply script (step 4) rewrites the `routes` and
   `workers_dev` lines of the Worker configuration for a `*.workers.dev` address. *Optional, a custom domain:* set `board.url` to
   `https://board.example.com` on a domain whose DNS is in the same Cloudflare account; the template's `custom_domain` route creates the DNS
   record on deploy.
3. **Decide the names and the options.** In the config's `board` section: `workerName`, `d1Name`, `url` (step 2), `fileStorage` (`none`,
   `d1` or `r2`, see "File storage" above), `r2Bucket` (only for `r2`) and `language` (`en`, `zh-CN`, ... see "Language of the page").
   `project.name` becomes the `PROJECT_NAME` the page shows.
4. **Create the database (and the bucket).**
   ```bash
   npx wrangler d1 create <d1Name>            # prints a database_id: put it in board.d1Id
   npx wrangler r2 bucket create <r2Bucket>   # only with fileStorage r2 (Cloudflare asks for a payment card for R2)
   ```
   Put the Cloudflare account id (shown by `npx wrangler whoami` or in the dashboard URL) in `board.cloudflareAccountId` if the config
   does not have it, then render the Worker configuration from the repository root: `node tools/setup/apply.mjs --board-only`. It writes
   `board/wrangler.jsonc` from `board/wrangler.jsonc.tmpl`; run it again whenever you change the config.
5. **Secrets and keys.** Re-run `node tools/setup/apply.mjs --board-only` after step 4, then from `board/`:
   ```bash
   npm run check && npm test       # the code and the migrations are sound
   npm run setup:secrets           # asks for nothing: makes SESSION_SECRET and one key per agent, stores the agent keys on this
                                   # machine, sets the Worker secrets
   ```
   The agent keys go into the macOS Keychain (service `board.keychainService`) or, without `security`, into key files under
   `~/.boardkit/<project slug>/keys/`. Re-running the script renews everything and signs every browser out; `-- --sessions-only` and
   `-- --keys-only` renew one half. A cloud session gets its key as an API credential on its environment (or `BOARD_KEY`).
6. **Create the schema and deploy.**
   ```bash
   npm run db:remote               # wrangler d1 migrations apply DB --remote
   npm run deploy                  # wrangler deploy
   ```
7. **Name the default project, sign in and check.** (Order: step 6 first, since the sign-in link is stored in the database.)
   ```bash
   BOARD_AS=<an agent name> node cli/board.mjs projects rename main "<Project Name>"
   BOARD_AS=<an agent name> node cli/board.mjs whoami
   ```
   Then `npm run owner-link`: it opens the Owner's browser, signed in. Nothing is typed.

Local development: `npm run db:local`, a `.dev.vars` file with test values (`SESSION_SECRET` and
`AGENT_KEYS` as a JSON object of name to key, each key at least 32 characters; never commit it), then `npm run dev`. On localhost the page
offers a development sign-in as well. With `FILE_STORAGE` set to `d1` the files live in the local D1; with `r2` and the `r2_buckets` line
in `wrangler.jsonc` Wrangler simulates the bucket locally; with `none` the board runs without file storage.

## Adding a developer

The Lead does this when the Owner names one. The database has no CHECK on the assignee, so a new name needs no migration.

1. Add the role to `skeleton.config.json` and run `node tools/setup/apply.mjs --board-only`, or add `{ name: "...", label: "..." }` to
   `AGENT_LIST` in `src/agents.ts` by hand (a limited QA agent carries `limited: true`). Then `npm run check && npm test && npm run deploy`.
2. `bash scripts/add-agent.sh <name>`, in a terminal of the person holding the Cloudflare login: it makes the key on this machine and sets the
   Worker's `AGENT_KEYS` from every agent's stored key (the others are read, not changed). A session with no Keychain or key file (a cloud
   environment) gets the key as an API credential or as `BOARD_KEY`.
3. `BOARD_AS=<name> node cli/board.mjs agents` should answer. Point the new member at its role's document in `docs/onboarding/` of the
   project repository.
