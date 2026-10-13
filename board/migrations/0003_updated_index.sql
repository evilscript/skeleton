-- The board asks "did anything change?" every 30 seconds; with this index that is one row read, not a scan of every card.
CREATE INDEX cards_updated ON cards(updated_at);
