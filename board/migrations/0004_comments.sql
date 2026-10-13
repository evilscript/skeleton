-- Comments on cards: where the agents and the owner talk, so the owner can
-- read it all in one place. A comment belongs to a project from the start
-- (a later migration makes the board multi-project); today there is only the
-- default project.
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO projects(id, slug, name, created_at) VALUES (1, 'main', 'Main', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL DEFAULT 1,
  card_no INTEGER NOT NULL,
  author TEXT NOT NULL,                    -- the owner or an agent (from the key, never from the request)
  to_actor TEXT,                           -- the owner or an agent, or NULL for nobody in particular
  type TEXT NOT NULL DEFAULT 'note',       -- note | assign | started | blocked | question | review | merged | decision
  body TEXT NOT NULL,                      -- at most 4 KB
  ref TEXT NOT NULL DEFAULT '',            -- an http(s) link, e.g. the pull request
  created_at TEXT NOT NULL
);
-- A card's thread, and an agent's inbox: both read only the rows they return.
CREATE INDEX comments_card ON comments(project_id, card_no, id);
CREATE INDEX comments_to ON comments(to_actor, id);

-- The board list shows a count without reading any comment.
ALTER TABLE cards ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0;
