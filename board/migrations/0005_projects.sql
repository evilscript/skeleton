-- Many projects on one board. `projects` and `comments.project_id`
-- came with the comments (0004); now a card belongs to a project too.
-- Card numbers stay global (`no` is still the one primary key), so a number
-- names one card everywhere: files, comments, activity and the CLI don't need
-- to know the project. Everything that exists today is the default project (id 1).
ALTER TABLE cards ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;
-- The board's reads are all "this project's cards": the column list and the
-- one-row change check ("did anything change?") start from project_id.
CREATE INDEX cards_project_col ON cards(project_id, col, sort DESC);
CREATE INDEX cards_project_updated ON cards(project_id, updated_at);
DROP INDEX cards_col;
DROP INDEX cards_updated;

-- Chips belong to a project (a chip that means something in one project means nothing in another), so
-- the primary key becomes (project_id, name): rebuild the table.
CREATE TABLE chips_new (
  project_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, name)
);
INSERT INTO chips_new(project_id, name, color, sort) SELECT 1, name, color, sort FROM chips;
DROP TABLE chips;
ALTER TABLE chips_new RENAME TO chips;

-- Chip changes have no card, so the activity log carries the project itself.
ALTER TABLE activity ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX activity_project ON activity(project_id, id);

-- A project's newest comment (the change check) and its feed: one-row reads.
CREATE INDEX comments_project ON comments(project_id, id);
