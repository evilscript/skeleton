-- Removing a card hides it instead of deleting it : it keeps its
-- number and can be restored. Only the owner purges a removed card.
ALTER TABLE cards ADD COLUMN removed_at TEXT;
ALTER TABLE cards ADD COLUMN removed_by TEXT;
