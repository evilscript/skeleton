-- Cards get a priority (minor, major, critical, blocker; NULL is none) and more
-- assignees. SQLite can't change a CHECK, so the cards table is rebuilt with the
-- same columns, in the same order, plus `priority`; its indexes are made again.
-- Comments, files and activity point at cards by number, which doesn't change.
-- Dropping the table also drops the triggers that sit on it (0008's
-- cards_chip_insert/delete/update), and a trigger on chips that reads cards
-- (chips_rename) would point at a missing table while the new one is renamed
-- into place: those four are dropped first and made again at the end, exactly
-- as 0008 defines them.
DROP TRIGGER chips_rename;
CREATE TABLE cards_new (
  no INTEGER PRIMARY KEY,
  col TEXT NOT NULL CHECK (col IN ('feedback','backlog','progress','testing','later','done')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee TEXT CHECK (assignee IN ('lead','developer','qa','owner')),
  chips TEXT NOT NULL DEFAULT '[]',        -- JSON array of chip names
  sort REAL NOT NULL DEFAULT 0,            -- order in a column, higher first
  source TEXT NOT NULL DEFAULT 'board',    -- board | feedback | migrated
  report TEXT NOT NULL DEFAULT '',         -- feedback: diagnostics the visitor pasted
  contact TEXT NOT NULL DEFAULT '',        -- feedback: optional, never public
  locale TEXT NOT NULL DEFAULT '',
  request_key TEXT UNIQUE,                 -- feedback: retry de-duplication
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  removed_at TEXT,
  removed_by TEXT,
  comment_count INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER NOT NULL DEFAULT 1,
  priority TEXT CHECK (priority IN ('minor','major','critical','blocker'))
);
INSERT INTO cards_new(no, col, title, description, assignee, chips, sort, source, report, contact, locale, request_key,
    created_at, updated_at, updated_by, removed_at, removed_by, comment_count, project_id)
  SELECT no, col, title, description, assignee, chips, sort, source, report, contact, locale, request_key,
    created_at, updated_at, updated_by, removed_at, removed_by, comment_count, project_id FROM cards;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
CREATE INDEX cards_project_col ON cards(project_id, col, sort DESC);
CREATE INDEX cards_project_updated ON cards(project_id, updated_at);

CREATE TRIGGER chips_rename AFTER UPDATE OF name ON chips
WHEN OLD.name <> NEW.name BEGIN
  UPDATE chips SET used = (
    SELECT COUNT(*) FROM cards c, json_each(c.chips) j
    WHERE c.project_id = NEW.project_id AND c.removed_at IS NULL AND j.value = NEW.name
  ) WHERE project_id = NEW.project_id AND name = NEW.name;
END;
CREATE TRIGGER cards_chip_insert AFTER INSERT ON cards
WHEN NEW.removed_at IS NULL BEGIN
  UPDATE chips SET used = used + (SELECT COUNT(*) FROM json_each(NEW.chips) WHERE value = chips.name)
  WHERE project_id = NEW.project_id AND name IN (SELECT value FROM json_each(NEW.chips));
END;
CREATE TRIGGER cards_chip_delete AFTER DELETE ON cards
WHEN OLD.removed_at IS NULL BEGIN
  UPDATE chips SET used = used - (SELECT COUNT(*) FROM json_each(OLD.chips) WHERE value = chips.name)
  WHERE project_id = OLD.project_id AND name IN (SELECT value FROM json_each(OLD.chips));
END;
CREATE TRIGGER cards_chip_update AFTER UPDATE OF chips, removed_at, project_id ON cards
WHEN OLD.project_id <> NEW.project_id OR OLD.chips <> NEW.chips OR (OLD.removed_at IS NULL) <> (NEW.removed_at IS NULL) BEGIN
  UPDATE chips SET used = used - (SELECT COUNT(*) FROM json_each(OLD.chips) WHERE value = chips.name)
  WHERE project_id = OLD.project_id AND OLD.removed_at IS NULL AND name IN (SELECT value FROM json_each(OLD.chips));
  UPDATE chips SET used = used + (SELECT COUNT(*) FROM json_each(NEW.chips) WHERE value = chips.name)
  WHERE project_id = NEW.project_id AND NEW.removed_at IS NULL AND name IN (SELECT value FROM json_each(NEW.chips));
END;
