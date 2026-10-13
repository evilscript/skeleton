// Shared by the Worker, browser and CLI. The limit is on the stored UTF-8 body.
export const MAX_COMMENT_BYTES = 4096;
export const COMMENTS_PER_HOUR = 60;
export const COMMENT_ERRORS = {
  comment_too_long: "Comments are limited to 4 KB (4096 UTF-8 bytes); put long content in a link.",
  comment_rate_limit: "Each author can post 60 comments per UTC clock hour; retry at the next hour.",
};
export function commentBodyError(text) {
  return new TextEncoder().encode(text.trim()).length > MAX_COMMENT_BYTES ? "comment_too_long" : "";
}
