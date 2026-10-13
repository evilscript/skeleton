-- The board list reads each card's files for its screenshot and attachment
-- counts and its thumbnail. With every column it needs in the index that is
-- one index-only pass per card (it was three passes, each also reading the
-- table row for every file). The new index starts with card_no, so it also
-- serves everything the old files_card index did.
CREATE INDEX files_card_stats ON files(card_no, kind, created_at, id);
DROP INDEX files_card;
