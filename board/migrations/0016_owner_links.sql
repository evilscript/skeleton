-- The owner has no password any more (see src/auth.ts). A sign-in link is made by
-- `npm run owner-link`: a random token of which only the SHA-256 hash is stored here,
-- good for 15 minutes and for one use (src/index.ts signIn deletes the row that matches).
-- The password's throttling table is not needed any more.
DROP TABLE IF EXISTS sign_in_attempts;
CREATE TABLE owner_links (
  hash TEXT PRIMARY KEY,        -- SHA-256 of the token, in hex
  expires_at INTEGER NOT NULL   -- unix seconds
);
