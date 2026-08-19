-- A customer's OEM becomes assignable, and this time the pipeline reads it.
--
-- The scope was opened on 17 August and withdrawn eight hours later, because a decision
-- filed under a scope nothing reads is worse than no box at all: it saves, it reads back,
-- the queue stops showing the row, and every figure keyed off that customer's OEM stays
-- exactly as it was. `megh_sku` was in that state for a fortnight and the withdrawal note
-- said the scope would return when the pipeline read it.
--
-- It now does. `refresh_dashboard.py` applies an `oem` assignment over `oem_map` at the
-- point that map is built, as an override and not a fallback — the same arrangement the
-- bucket assignments have had since the beginning, and for the same reason: a customer
-- the OEM key resolves *wrongly* is precisely the case somebody is correcting.
--
-- That map is the single place a customer name becomes an OEM. Everything downstream
-- reads it: the sales frame, the schedule (twice), stock, receivables, the code
-- repository and the trend segments. So the reach of one answer here is wider than a
-- bucket's, which is why it waited for the pipeline rather than the other way round.
--
-- The key is the customer name as the dump spells it. Both sides normalise through
-- `norm_text`, so a decision filed against the raw spelling still meets the lookup.

alter table public.bucket_assignments
  drop constraint if exists bucket_assignments_scope_check;

alter table public.bucket_assignments
  add constraint bucket_assignments_scope_check
  check (scope in ('bucket', 'megh_sku', 'ctl_bucket', 'oem'));
