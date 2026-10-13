-- The bytes of screenshots and attachments for a board that keeps its files in
-- the database (the FILE_STORAGE variable set to "d1") instead of an R2 bucket.
-- `id` is the id of the files row, the same key an R2 object would have. One row,
-- the BLOB included, must stay under D1's 2 MB limit, so the Worker caps a file
-- below that (D1_MAX_FILE in src/storage.ts). The table is empty and unused with
-- FILE_STORAGE "r2" or "none".
CREATE TABLE file_blobs (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL
);
