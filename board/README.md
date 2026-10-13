# Board

A small task board for a team of one human (the **Owner**) and any number of AI agents: one Cloudflare Worker with a D1 database
(cards, comments, chips, activity), an optional R2 bucket (screenshots and attachments), a web page, a public feedback form and a
command-line tool. It runs on Cloudflare's free tier, needs no domain and no build step, and the Owner signs in with a key, not with a
third-party account.

Cards have a number (global), a status, chips, a priority, an assignee and comments. **Typed, addressed card comments are the channel
agents use to talk to each other and to the Owner.** The Owner reads and writes on the web page; agents use `cli/board.mjs`.

| Path | Who | What |
|---|---|---|
| `/feedback/` | anyone, no sign-in | write a bug report or feature request (with screenshots when the board has file storage); it becomes a card in the **Feedback** column of the default project. Visitors see nothing else. |
| `/board/` | the Owner (the owner key) | the board, one project at a time |
| `/` | | redirects to `/feedback/` |
| `/api/...` | the Owner's session or an agent's key | the JSON API the page and the CLI use (`GET /api/info` and `/api/config` are public) |

The name the pages show comes from the Worker's public variable `PROJECT_NAME` (`GET /api/info`); it falls back to "Board". The same
answer says whether the board has file storage: `{ "projectName": "...", "files": true }`.

## Signing in

- **The Owner** signs in on the page at `/board/` with the **owner key**: a secret of at least 32 characters (`OWNER_KEY`, a Worker
  secret) that `npm run setup:secrets` makes. The Owner reads it on the machine that ran the script, in their own terminal:
  `node cli/board.mjs owner-key` prints it, `node cli/board.mjs owner-key --copy` puts it on the clipboard and prints nothing secret. It is
  the Owner's credential (full rights, including deleting a card for good): only the Owner runs that command, never an agent. It prints a
  warning, refuses to print when its output is not a terminal, refuses `--copy` without an interactive terminal, and refuses to run when
  `BOARD_AS` is set (an agent session). The key is looked up like an agent's: the macOS Keychain (service `board.keychainService`,
  account `owner.boardName` from `skeleton.config.json`, default `owner`), then the key file `~/.boardkit/<project slug>/keys/<that name>`.
- The page sends the key once (`POST /api/session` with `{ "key": "..." }`); a wrong key is answered `403 not_owner`. A right one sets a
  signed cookie (HMAC with `SESSION_SECRET`, `HttpOnly`, `Secure`, `SameSite=Lax`, 30 days). Writes with the cookie also need the page's
  own origin and the `x-board` header, so another site cannot make the Owner's browser change cards. **Sign out** (`DELETE /api/session`)
  clears it. Everywhere on the board the Owner is `OWNER_ASSIGNEE` from `src/agents.ts` (default `owner`, label "Owner").
- **Agents** never use the cookie: each has its own key (`Authorization: Bearer ...`) and uses the command line. The owner key is not
  accepted as an agent key.
- A Worker secret cannot be read back from Cloudflare. If the key is lost, run `npm run setup:secrets` again: it makes a new owner key,
  new agent keys and a new `SESSION_SECRET` (every signed-in browser is signed out).
- Local development only (`wrangler dev`, `ENVIRONMENT=development` on `localhost`): the page also offers a development sign-in that needs no
  key.

## File storage is optional

Screenshots, attachments and the feedback form's images are stored in an R2 bucket. Cloudflare asks for a payment card before R2 can be
switched on, even for free-tier use, so the board works without it: leave `board.r2Bucket` empty in `skeleton.config.json` and
`node tools/setup/apply.mjs --board-only` drops the `r2_buckets` line from the rendered `wrangler.jsonc`. Without the `FILES` binding:

- `POST /api/cards/<n>/files` and `GET /api/files/<id>` answer `501 { "error": "files_disabled" }`; deleting a file or purging a card still
  cleans the database, and nothing calls the bucket.
- `GET /api/info` answers `files: false`. The board page hides the screenshot and file rows of a card and the image counts; the public
  feedback form hides its image field, and a request that carries images anyway is refused with the same `files_disabled`.
- `node cli/board.mjs attach` fails with a clear message; every other command works as before.

To add storage later: create the bucket (`npx wrangler r2 bucket create <name>`), put its name in `board.r2Bucket`, run
`node tools/setup/apply.mjs --board-only` and deploy again.

## Statuses and columns

Every card has a **status**; a column shows the cards of one or more statuses ([docs/STATUSES.md](docs/STATUSES.md) says who moves a card
where).

| Column | Statuses (slug, label) |
|---|---|
| Feedback | `feedback` Feedback |
| Backlog | `backlog` Backlog, `todo` To do |
| In progress | `progress` In progress, `pr_review` PR reviewing, `spike_ready` Spike report ready, `on_main` On Main (the page draws the last three as their own column, PR submitted) |
| Ready for QA | `probe_needed` Owner check needed, `on_prod_qa` On Prod for QA, `qa_later` QA later |
| Done | `done` Done |

A new card starts in backlog; the Owner moves one to todo when work should start on it. The stored `col` (the column key: `feedback
backlog progress testing done`) follows the status in one place, `columnOf` in `public/board/statuses.js`, which the Worker, the page,
the CLI and the tests share. The old column words `todo`, `later` and `testing` are still accepted as input (`col: "todo"` is the status
todo, `later` is `qa_later`, `testing` is `on_prod_qa`; any other column name means its first status).

On the page each column is drawn as one bordered **layer** per status (always there, even empty). Drag a card onto a layer to set its
status, inside a layer to put it higher or lower; the arrow buttons on a layer's header move the layer inside its column (the order is
kept in the browser, per project). Feedback sits above Backlog and only shows while it has cards. Done is not on the board: the top bar's
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
- The public feedback form always files into the default project (id 1).
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

`node cli/board.mjs` with no command (or `--help`) prints the full command list, which includes `owner-key`: that one is the Owner's, for the
page's sign-in (see "Signing in"), and an agent never runs it. `list`, `new`, `chips`, `feed` and `version` work in one project
(`--project`, else `BOARD_PROJECT`, else `board.defaultProject`, else `main`). `list` leaves the done cards out (it says how many) unless
you ask with `--col done` or `--all`. Cards are found by number in every project; `inbox` is yours across all projects. In a project made
from this template, `node tools/board.mjs <command>` runs the same tool from any checkout.

Rules: take a card number from `new`, never pick one yourself; a card's status says where it is; do not take a card assigned to someone
else. Only the Owner can delete a card for good.

## Layout

- `src/index.ts` - routing, cards, chips, files, feedback submission.
- `src/auth.ts` - the owner key check, the Owner's session cookie, agent keys.
- `src/agents.ts` - the agents (see above). `src/validation.ts` - input rules and the feedback form limits.
- `public/feedback/`, `public/board/` - the two pages (no build step). `public/board/statuses.js` is the status table.
- `cli/board.mjs`, `cli/usage.mjs`, `cli/config.mjs` - the command line (the config reader uses plain `fs`; nothing outside `board/` is imported).
- `migrations/` - the D1 schema, applied in order (`0005` adds projects, `0006` per-column counts, `0007` the files index, `0008` quotas and
  stored chip counts, `0009` the priority, `0011` the card status, `0013` an open status column).
- `scripts/setup-secrets.sh`, `scripts/add-agent.sh` - credentials (run by a person, never by an agent); `scripts/backup.mjs` - manual
  verified backups.
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
3. **Decide the names.** In the config's `board` section: `workerName`, `d1Name`, `url` (step 2) and `r2Bucket`, which is **optional**:
   leave it empty for a board without screenshots and attachments (see "File storage is optional" above). `project.name` becomes the
   `PROJECT_NAME` the pages show.
4. **Create the database (and the bucket).**
   ```bash
   npx wrangler d1 create <d1Name>            # prints a database_id: put it in board.d1Id
   npx wrangler r2 bucket create <r2Bucket>   # only if you want file storage (Cloudflare asks for a payment card for R2)
   ```
   Put the Cloudflare account id (shown by `npx wrangler whoami` or in the dashboard URL) in `board.cloudflareAccountId` if the config
   does not have it, then render the Worker configuration from the repository root: `node tools/setup/apply.mjs --board-only`. It writes
   `board/wrangler.jsonc` from `board/wrangler.jsonc.tmpl`; run it again whenever you change the config.
5. **Optional: the feedback form's anti-spam (Cloudflare Turnstile).** In the dashboard create a Turnstile widget whose hostname is the
   board's host; put its *site key* in `board.turnstileSiteKey` and keep its *secret key* for step 6. Without it the public form stays off
   (the rest of the board works).
6. **Secrets and keys.** Re-run `node tools/setup/apply.mjs --board-only` after steps 4 and 5, then from `board/`:
   ```bash
   npm run check && npm test       # the code and the migrations are sound
   npm run setup:secrets           # makes SESSION_SECRET, the owner key and one key per agent, stores the keys on this machine, sets the
                                   # Worker secrets, and asks for the Turnstile secret key (hidden; Enter to skip)
   ```
   The keys go into the macOS Keychain (service `board.keychainService`; the owner key under the account `owner.boardName`) or, without
   `security`, into key files under `~/.boardkit/<project slug>/keys/`. Re-running the script rotates every key and signs every browser out.
   A cloud session gets its key as an API credential on its environment (or `BOARD_KEY`).
7. **Create the schema and deploy.**
   ```bash
   npm run db:remote               # wrangler d1 migrations apply DB --remote
   npm run deploy                  # wrangler deploy
   ```
   Add the final address's host to the Turnstile widget (step 5) if you use one.
8. **Name the default project, sign in and check.**
   ```bash
   BOARD_AS=<an agent name> node cli/board.mjs projects rename main "<Project Name>"
   BOARD_AS=<an agent name> node cli/board.mjs whoami
   node cli/board.mjs owner-key --copy      # the Owner only, in their own terminal; then paste the key into the page
   ```
   Open `/board/` and paste the owner key at the sign-in (the Owner reads it with `owner-key`, see "Signing in"), then open `/feedback/`
   and submit a test report: it lands in the Feedback column.

Local development: `npm run db:local`, a `.dev.vars` file with test values (`SESSION_SECRET`, `OWNER_KEY` of at least 32 characters, and
`AGENT_KEYS` as a JSON object of name to key, each key at least 32 characters; never commit it), then `npm run dev`. On localhost the page
offers a development sign-in as well, and the feedback form skips Turnstile. With the `r2_buckets` line in `wrangler.jsonc` Wrangler
simulates the bucket locally; without it the board runs in its "no file storage" mode.

## Adding a developer

The Lead does this when the Owner names one. The database has no CHECK on the assignee, so a new name needs no migration.

1. Add the role to `skeleton.config.json` and run `node tools/setup/apply.mjs --board-only`, or add `{ name: "...", label: "..." }` to
   `AGENT_LIST` in `src/agents.ts` by hand (a limited QA agent carries `limited: true`). Then `npm run check && npm test && npm run deploy`.
2. `bash scripts/add-agent.sh <name>`, in a terminal of the person holding the Cloudflare login: it makes the key on this machine and sets the
   Worker's `AGENT_KEYS` from every agent's stored key (the others are read, not changed). A session with no Keychain or key file (a cloud
   environment) gets the key as an API credential or as `BOARD_KEY`.
3. `BOARD_AS=<name> node cli/board.mjs agents` should answer. Point the new member at its role's document in `docs/onboarding/` of the
   project repository.
