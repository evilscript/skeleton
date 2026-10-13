# Card statuses and columns

Every card has a **status**; a **column** is where the cards of some statuses are shown together. A column is drawn as one bordered layer
per status, so a status is always visible, even when it has no cards. Cards can be dragged between layers and reordered inside a layer, and
the layers of a column can be moved up and down (kept in the browser, per project).

## Statuses (slug, label) and their columns

The board page draws these columns: Backlog (Feedback on top of it while it has cards; `backlog`, `todo`), In progress (`progress`),
PR submitted (`pr_review`, `spike_ready`, `on_main`), Ready for QA (`probe_needed`, `on_prod_qa`, `qa_later`), and Done as a panel. That is
`VIEW_COLUMNS` in `public/board/statuses.js`. The stored column (`col`, the CLI's `--col`, the filters) is the one in the table below:
`progress` there holds In progress and PR submitted together; the page only splits it.

| Column | Status slug | Label | Means |
|---|---|---|---|
| Feedback | `feedback` | Feedback | a visitor's report; nobody has looked at it yet |
| Backlog | `backlog` | Backlog | where every new card starts; nobody works on it |
| Backlog | `todo` | To do | the Owner's go: work should start on it |
| In progress | `progress` | In progress | a Developer is working on it |
| In progress | `pr_review` | PR reviewing | a pull request is open, the Lead is reviewing it |
| In progress | `on_main` | On Main | merged into the default branch, not released or deployed yet |
| In progress | `spike_ready` | Spike report ready | a spike card only (research, no product code): the report is on the default branch; the Owner reads it, decides what to build and makes the cards, then moves the spike to `done` |
| Ready for QA | `probe_needed` | Owner check needed | something only the Owner can run or verify by hand, outside the normal QA flow: the Lead puts the exact steps on the card once the thing to check is in a build the Owner has, the Owner reports the short result on the card and moves it to `done` |
| Ready for QA | `on_prod_qa` | On Prod for QA | released or deployed; the Owner tests it |
| Ready for QA | `qa_later` | QA later | released or deployed, but the Owner cannot test it yet |
| Done | `done` | Done | the Owner tested it |

## Who moves a card

The project's constitution (`docs/CONSTITUTION.md`, the board protocol) is the authority; in short:

- The Owner moves backlog to `todo`, and every card to `done` or `qa_later`.
- The Lead hands a `todo` card out with an `assign` comment (the card stays `todo`).
- The Developer sets `progress` when it starts.
- The Lead sets `pr_review` when a pull request arrives, `on_main` at the merge, and `on_prod_qa` at the release or deploy.
- For a spike card the Lead sets `spike_ready` once its report is on the default branch. For a card that needs the Owner's own check the
  Lead sets `probe_needed` instead of `on_prod_qa`, with the exact steps in a comment.

## How the data works

- The cards table has a `status` column and a `col` column. `col` is the stored column key and follows the status in one place,
  `columnOf` in `public/board/statuses.js`: `feedback` to `feedback`; `backlog` and `todo` to `backlog`; `progress`, `pr_review`,
  `on_main` and `spike_ready` to `progress`; `probe_needed`, `on_prod_qa` and `qa_later` to `testing`; `done` to `done`. The Worker
  validates every status it is given against `STATUS_SLUGS`; the database has no CHECK on the status (migration 0013), so a new status
  needs no migration.
- `PATCH /api/cards/:no` takes `status`, and still `col`: a column name means the column's first status, `todo` and `later` mean their own
  statuses (`testing` is `on_prod_qa`). Both may be given if they agree. Creating takes either; the default is `backlog`. The card JSON
  carries both. The list filters by `status` and by `col`. Every status change is in the card's activity.
- `column_counts` stays right: every write that creates, moves, removes or restores a card bumps it.
- Moving a card to another layer of its column puts it on top of that layer unless a `sort` is given.
- CLI: `board move <no> <status or column name>`, `board set <no> --status ...`, `board list --status ...`. `show` prints the status and
  the help lists every slug.

## A project can show fewer statuses

`PROJECT_LAYOUTS` in `public/board/statuses.js` lets one project hide statuses, rename some and put the layers of a column in another
order. A project that is not listed shows all eleven, as above. The page draws only what the project keeps, and the Worker refuses a hidden
status for that project's cards (create and change; `invalid_status`), so no card can sit in a layer nobody draws. The stored columns and
the CLI words do not change.

## Changing the status set

- Add or rename a status in `STATUSES` (and `VIEW_COLUMNS`) in `public/board/statuses.js`, with a colour `--s-<slug>` in
  `public/board/board.css`. Keep `tests/cards.test.ts` in step (it pins the list, the column map and the CLI help).
- A migration that rebuilds the cards table must drop and recreate the four chip-count triggers (see `0009`, `0010`, `0012`, `0013`),
  must not use `CASE ... END` inside a trigger body (D1's remote parser takes the `END` for the end of the trigger), should be tried on a
  copy of the real data first (`wrangler d1 execute DB --local`), and should be applied right before the deploy. Back the database up before
  applying it (`npm run backup`).
