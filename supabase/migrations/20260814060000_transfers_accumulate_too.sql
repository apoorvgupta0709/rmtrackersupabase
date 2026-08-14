-- Inter-plant transfers, as one accumulating table.
--
-- Applied to production as version 20260814030955, name `transfers_accumulate_too`. The
-- version differs from this filename because nothing in this repository applies a
-- migration — there is no `supabase db push` in either workflow — so the timestamp is
-- the moment it was applied by hand rather than the moment the file was written. Read
-- the applied list with `list_migrations`; reading this directory answers a different
-- question, and has been wrong before.
--
-- The same argument the sales ledger was built on, and the same key. A despatch of stock
-- from one plant to another is a fact with a date on it: it happened, it does not change,
-- and the daily dump carries only the current month. Superseded on every upload, the
-- closed months were simply thrown away — and unlike sales, there was never even an
-- archive to stitch back on, so nothing before the current month has ever been held.
--
-- `raw_batches` keeps ingesting the transfer dump exactly as before — that is how a dump
-- arrives and how it is audited — and every batch is then absorbed here once, adding only
-- the invoice lines this table has never seen.

-- The key is the invoice line, exactly as it is for sales, and under the same two column
-- names. Verified on the file held: 844 rows carrying a transfer invoice type, zero
-- duplicate (document, item) pairs.
--
-- Both halves are text, and for the same load-bearing reason as the sales ledger. The
-- transfer dump ends with the sheet's own grand total — no invoice type, no billing
-- document, `Quantity` 1,661,638.927 against a column that really sums to half of that —
-- and its presence makes pandas read both key columns as floats. Stored raw, the same
-- despatch would key as '4470110377.0' from a dump that carries a total row and
-- '4470110377' from one that does not, and be inserted twice. The absorber puts both
-- through `whole_number_text`, and the total row is dropped rather than deduplicated:
-- the key is required and it has none.
create table public.tsl_transfers (
  billing_document text not null,
  billing_item     text not null,
  -- The whole named line, for the reason `raw_rows` and `tsl_sales` are JSONB: the sheet
  -- is 234 columns and gains more without warning. A typed column per field would mean a
  -- migration every time SAP adds one.
  row              jsonb not null,
  billing_date     date,
  billing_month    text,
  -- The in-transit flag, and it is an absence rather than a value: a line is in transit
  -- until the receiving plant posts a goods receipt.
  --
  -- This column is why the transfer ledger resolves conflicts differently from the sales
  -- one. A billed sale is finished when it is billed, so `tsl_sales` keeps the first
  -- version of a line and ignores every later one. A transfer is not finished until it
  -- is received, and `GR DATE` therefore fills in on a dump sent days after the one that
  -- first carried the line — 227 of the 1,088 lines held did exactly that. Absorbed
  -- keep-first, all 227 would be frozen in transit for good, and the table would report
  -- 445 lines in transit against a true 218. So the absorber uses `merge-duplicates`
  -- here: the key still stops a re-sent day double counting, it just lets it correct.
  gr_date          date,
  invoice_type     text,
  -- On this dump the "customer" is a plant — 4731 and 8406 — so both ends are plants and
  -- both are stored twice over. `*_raw` is what the file wrote; the unsuffixed column is
  -- that put through `plant_code`, because the dumps disagree about padding: stock writes
  -- `0788` and `789` in the same column, zmat writes `788`, this dump writes `788.0`.
  -- Every one is the same plant, and a join on the raw value silently matches a subset.
  source_plant         text,
  source_plant_raw     text,
  receiving_plant      text,
  receiving_plant_raw  text,
  material_number  text,
  -- Which upload these values came from — the latest to carry the line, not the first,
  -- because the later dump wins here. Nullable and `on delete set null`, as the sales
  -- ledger has it and for the same reason: the batch is prunable operational data and the
  -- line is not, so losing the provenance must never take the fact with it.
  source_batch     uuid references public.raw_batches (id) on delete set null,
  -- Set once and never written again: the absorber does not send this column, so an
  -- upsert leaves it at whatever the first insert defaulted it to. That is deliberate —
  -- with `source_batch` now naming the latest dump, this is the only record left of when
  -- the line was first seen at all.
  first_seen_at    timestamptz not null default now(),
  primary key (billing_document, billing_item)
);

-- The three ways this table gets read: a month of everything, one lane between two
-- plants, and what is still in transit.
create index tsl_transfers_month_idx on public.tsl_transfers (billing_month);
create index tsl_transfers_lane_idx
  on public.tsl_transfers (source_plant, receiving_plant, billing_month);
create index tsl_transfers_in_transit_idx
  on public.tsl_transfers (receiving_plant) where gr_date is null;

-- Same sensitivity as `tsl_sales` and the same answer: these are despatch transactions
-- carrying rates, and no viewer has any business reading them. The worker writes with the
-- service role and bypasses all of this.
alter table public.tsl_transfers enable row level security;

create policy "admin reads transfer lines" on public.tsl_transfers
  for select to authenticated using (public.is_admin());

-- Pruning must not outrun absorption, exactly as it must not for sales. A superseded
-- batch is disposable once its lines are in a table that outlives it and emphatically not
-- before: without this, a transfer dump uploaded and left unrefreshed for a fortnight
-- would be deleted with its lines never recorded, and nothing downstream would report a
-- gap — the months would simply be short.
--
-- Spelled out with its own parentheses rather than left to `and` binding tighter than
-- `or`. The two readings of this clause differ by whether an unabsorbed sales batch
-- survives, which is the whole point of it, and a reader should not have to know an
-- operator precedence rule to tell which one is written.
create or replace function public.prune_uploads(keep_days integer default 14)
returns table (deleted_batches integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  with doomed as (
    delete from public.raw_batches
    where status <> 'current'
      and month_end_of is null
      and uploaded_at < now() - make_interval(days => keep_days)
      and (absorbed_at is not null
           or (slot not like 'sales%' and slot <> 'transfers'))
    returning 1
  )
  select count(*)::integer into removed from doomed;
  return query select removed;
end;
$$;

revoke execute on function public.prune_uploads(integer) from public, anon, authenticated;
grant execute on function public.prune_uploads(integer) to service_role;
