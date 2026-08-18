-- One tab where every mapping is stated, and answerable.
--
-- Until now a mapping could only be seen where it was *missing*. The queues show what
-- reached no bucket, no OEM and no plan SKU, which is the right thing to act on but the
-- wrong thing to check against: a reader asking "what is this code governed as today" had
-- nowhere to look, and a mapping that was wrong rather than absent appeared on no tab at
-- all. This is the space that tab writes in.
--
-- The three masters are genuinely different spaces and `scope` is what keeps them apart:
--
--   * `Bucketting`      material code -> governed bucket          scope `bucket`
--   * `OEM_key_1_rev`   customer      -> OEM                      scope `oem`   (new)
--   * `vsm stock`       material code -> plan SKU (length key)    scope `megh_sku`
--
-- `oem` is new because the customer queue has never had an answer box. A customer absent
-- from the OEM key has been reported since the queue existed and could only be fixed by
-- editing the workbook; the tab that shows the mapping is the place to correct it, so the
-- space it corrects in has to exist. The check constraint is what makes a scope mean
-- something — without it the column is a free-text label and a typo files a decision where
-- nothing reads it and nothing complains.
--
-- **The tab row itself is not here.** See the migration that follows.

alter table public.bucket_assignments
  drop constraint if exists bucket_assignments_scope_check;

alter table public.bucket_assignments
  add constraint bucket_assignments_scope_check
  check (scope in ('bucket', 'megh_sku', 'ctl_bucket', 'oem'));
