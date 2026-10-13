-- Cards per column (live ones, not removed), so the board's "done" button reads
-- one row instead of counting a thousand on every refresh. The Worker keeps it
-- in step wherever a card is created, moved, removed or restored.
CREATE TABLE column_counts (
  project_id INTEGER NOT NULL,
  col TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, col)
) WITHOUT ROWID;
INSERT INTO column_counts(project_id, col, n)
  SELECT project_id, col, COUNT(*) FROM cards WHERE removed_at IS NULL GROUP BY project_id, col;
