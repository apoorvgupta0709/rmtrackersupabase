-- A scope the browser can write and the pipeline never reads is worse than no box at all.
--
-- `oem` was added an hour ago so the OEM master could be corrected from the all-mappings
-- tab. The cell would have saved, read back, and changed nothing: `oem_map` is built from
-- `OEM_key_1_rev codes` and no assignment is applied to it, so the mapping would have
-- looked answered while every figure that keys off the OEM stayed exactly as it was.
--
-- That is the failure `test_every_scope_the_browser_can_write_is_one_the_pipeline_reads`
-- exists to catch, and it caught it — `megh_sku` sat written-but-unread for a fortnight
-- before that test was written.
--
-- Withdrawn rather than wired, because wiring it changes how customers are classified —
-- and therefore the sales summary, the TVS scope and the trend segments — which is the
-- owner's decision and not a side effect of adding a tab. The tab still shows the OEM
-- master; the column is read-only until the loop can be closed.

alter table public.bucket_assignments
  drop constraint if exists bucket_assignments_scope_check;

alter table public.bucket_assignments
  add constraint bucket_assignments_scope_check
  check (scope in ('bucket', 'megh_sku', 'ctl_bucket'));
