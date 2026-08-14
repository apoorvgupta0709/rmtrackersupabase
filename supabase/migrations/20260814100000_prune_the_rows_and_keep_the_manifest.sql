-- Drop a superseded batch's rows, and keep the record that it arrived.
--
-- Applied to production as `prune_the_rows_and_keep_the_manifest`.
--
-- `prune_uploads` deletes the whole `raw_batches` row, which takes the upload history with
-- it: what arrived, when, from whom, and its content digest — the thing `previouslySeen`
-- checks to warn that a dump has been sent twice. That history is a few hundred bytes per
-- upload. The rows behind it are 52 MB.
--
-- And the rows behind a *superseded* batch are now genuinely spent. Every snapshot dump is
-- read through a view that filters `status = 'current'`, so nothing can see them; every
-- accumulating dump has had its lines folded into a table that outlives the batch. The
-- owner has said outright that yesterday's stock is not wanted.
--
-- So this separates the two. `prune_upload_rows` frees the space on the schedule the data
-- deserves; `prune_uploads` still exists and still eventually removes the manifest row
-- itself, on the longer one that history deserves.
--
-- The `keep_days` default is 1 rather than 0 deliberately: a batch superseded ten minutes
-- ago by an upload that turns out to be the wrong file is exactly when somebody wants the
-- previous rows back, and a day is long enough to notice and short enough not to matter.

alter table public.raw_batches add column rows_pruned_at timestamptz;

comment on column public.raw_batches.rows_pruned_at is
  'When this batch''s raw_rows were dropped. Distinguishes a batch whose rows were '
  'reclaimed from one that arrived empty — without it a pruned batch reads as a dump '
  'that never had any rows, and `row_count` would be the only thing contradicting it.';

create or replace function public.prune_upload_rows(keep_days integer default 1)
returns table (pruned_batches integer, pruned_rows bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  batches integer;
  rows_gone bigint;
begin
  create temporary table doomed_batches on commit drop as
    select id from public.raw_batches
     where status <> 'current'
       and month_end_of is null
       and rows_pruned_at is null
       and uploaded_at < now() - make_interval(days => keep_days)
       -- The same rule `prune_uploads` applies, and for the same reason: a dump whose
       -- rows are not yet in a table that outlives the batch is not spent, however old
       -- it is. Deleting one loses the lines with nothing downstream reporting a gap.
       and (absorbed_at is not null
            or (slot not like 'sales%'
                and slot not in ('transfers', 'bucketting', 'oem_key', 'zmat')));

  with gone as (
    delete from public.raw_rows
     where batch_id in (select id from doomed_batches)
    returning 1
  )
  select count(*) into rows_gone from gone;

  update public.raw_batches
     set rows_pruned_at = now()
   where id in (select id from doomed_batches);
  get diagnostics batches = row_count;

  return query select batches, rows_gone;
end;
$$;

revoke execute on function public.prune_upload_rows(integer) from public, anon, authenticated;
grant execute on function public.prune_upload_rows(integer) to service_role;
