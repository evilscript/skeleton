-- A status on every card (docs/STATUSES.md): backlog, todo, progress,
-- pr_review, on_main, on_prod_qa, qa_later, plus feedback and done. The stored
-- `col` stays (its CHECK already allows feedback backlog todo progress testing
-- later done) and now follows the status: feedback -> feedback; backlog, todo ->
-- backlog; progress, pr_review, on_main -> progress; on_prod_qa, qa_later ->
-- testing; done -> done. `todo` and `later` are no longer stored in `col`.
--
-- ALTER TABLE ... ADD COLUMN keeps the table, its indexes and 0008's triggers
-- (no rebuild, so nothing to recreate). No statement here has a CASE or a
-- trigger body. The default fills nothing in: the UPDATEs below set every
-- existing card's status from its old col.
ALTER TABLE cards ADD COLUMN status TEXT NOT NULL DEFAULT 'backlog'
  CHECK (status IN ('feedback','backlog','todo','progress','pr_review','on_main','on_prod_qa','qa_later','done'));
UPDATE cards SET status = 'todo' WHERE col = 'todo';
UPDATE cards SET status = 'qa_later' WHERE col = 'later';
UPDATE cards SET status = 'on_prod_qa' WHERE col = 'testing';
UPDATE cards SET status = col WHERE col IN ('feedback','backlog','progress','done');
UPDATE cards SET col = 'backlog' WHERE col = 'todo';
UPDATE cards SET col = 'testing' WHERE col = 'later';
-- The per-column counts follow the new `col` values.
DELETE FROM column_counts;
INSERT INTO column_counts(project_id, col, n)
  SELECT project_id, col, COUNT(*) FROM cards WHERE removed_at IS NULL GROUP BY project_id, col;
