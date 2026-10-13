-- Throttling for the owner's password sign-in. A person's password can be guessed, so
-- the Worker counts the attempts of one source (the client address, hashed with the
-- session secret: the address itself is never stored) in a window of 15 minutes
-- that starts with the first attempt. After 5 failures the sign-in answers 429
-- too_many_attempts until the window ends; a right password clears the row.
-- Rows are deleted when their window is over.
CREATE TABLE sign_in_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL   -- unix seconds
);
CREATE INDEX sign_in_attempts_expires ON sign_in_attempts(expires_at);
