-- Cards: one row per ticket. `no` is the card number everyone quotes
-- (#12); the Worker hands out MAX(no)+1 in a single statement, so two
-- writers can't get the same number.
CREATE TABLE cards (
  no INTEGER PRIMARY KEY,
  col TEXT NOT NULL CHECK (col IN ('backlog','progress','testing','later','done')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee TEXT CHECK (assignee IN ('lead','developer')),
  chips TEXT NOT NULL DEFAULT '[]',        -- JSON array of chip names
  sort REAL NOT NULL DEFAULT 0,            -- order in a column, higher first
  source TEXT NOT NULL DEFAULT 'board',    -- board | migrated
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX cards_col ON cards(col, sort DESC);

CREATE TABLE chips (
  name TEXT PRIMARY KEY,
  color TEXT NOT NULL DEFAULT '#6b7280',
  sort INTEGER NOT NULL DEFAULT 0
);

-- Screenshots and attached files; the bytes live under `id` in the R2 bucket or in file_blobs (0014).
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  card_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot','file')),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX files_card ON files(card_no);

-- Who changed what, shown on the card.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_no INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX activity_card ON activity(card_no, id);

CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);

INSERT INTO chips(name, color, sort) VALUES
  ('Bug', '#dc2626', 1), ('Feature', '#2563eb', 2);
