-- Stored counts that survive restarts, regions and simultaneous writers.
ALTER TABLE chips ADD COLUMN used INTEGER NOT NULL DEFAULT 0;
UPDATE chips SET used = (
  SELECT COUNT(*) FROM cards c, json_each(c.chips) j
  WHERE c.project_id = chips.project_id AND c.removed_at IS NULL AND j.value = chips.name
);

-- The old and new Workers both rename the chip before rewriting the cards.
-- Rebase this one chip here so the following card triggers cannot double
-- its old count during the migration/deployment window.
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

-- Separate from the old application reservation, so migration-before-deploy
-- cannot double-charge the same row through both old code and new triggers.
CREATE TABLE comment_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
INSERT INTO comment_limits SELECT key, MIN(count, 60), expires_at FROM rate_limits WHERE key LIKE 'comment:%';
CREATE INDEX comment_limits_expiry ON comment_limits(expires_at);
-- Keep the reservations of the current hour when upgrading from the first comments version.
-- RAISE is written as SELECT ... WHERE, not CASE ... END: the remote D1 parser
-- takes the END of a CASE inside a trigger body for the end of the trigger.
CREATE TRIGGER comments_quota BEFORE INSERT ON comments BEGIN
  SELECT RAISE(ABORT, 'comment_rate_limit') WHERE COALESCE((SELECT count FROM comment_limits
    WHERE key = 'comment:' || NEW.author || ':' || (CAST(strftime('%s', NEW.created_at) AS INTEGER) / 3600)), 0) >= 60;
  SELECT RAISE(ABORT, 'comment_too_long') WHERE length(CAST(NEW.body AS BLOB)) > 4096;
END;
CREATE TRIGGER comments_count AFTER INSERT ON comments BEGIN
  INSERT INTO comment_limits(key, count, expires_at)
  VALUES ('comment:' || NEW.author || ':' || (CAST(strftime('%s', NEW.created_at) AS INTEGER) / 3600),
    1, CAST(strftime('%s', NEW.created_at) AS INTEGER) + 7200)
  ON CONFLICT(key) DO UPDATE SET count = count + 1;
END;
