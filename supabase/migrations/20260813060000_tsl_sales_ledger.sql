-- TSL sales, as one accumulating table.
--
-- Every other dump is a full snapshot and supersedes the last, which is right for stock,
-- WIP and receivables: each is a fresh statement of what is true now, and yesterday's is
-- of no further interest. Sales is not like that. A billed line is a fact that happened
-- on a date and never changes, and the daily dump carries only the current month, so the
-- supersede model throws away history the moment a month closes. What filled the gap was
-- three archived quarterly extracts stitched to the daily dump under a one-month-one-
-- source rule — and two of those were pulled for the southern plants only, so every
-- figure before July is missing Jamshedpur and Khopoli.
--
-- So sales gets a ledger. `raw_batches` keeps ingesting sales exactly as before — that is
-- how a dump arrives and how it is audited — and every batch is then absorbed here once,
-- adding only the invoice lines this table has never seen.
--
-- Three consequences worth stating, because each is the point:
--
--  * **A backfill merges rather than replaces.** Send a Jan-June extract that does carry
--    Jamshedpur, and it inserts only its missing lines: the closed months become whole
--    without disturbing the lines already held.
--  * **A re-sent day cannot double count.** That was the original objection to a delta
--    merge, and the natural key is the answer to it.
--  * **The month-one-source rule can go.** It deduplicated whole months because it had no
--    finer key; this one deduplicates lines.

-- The key is the invoice line: billing document plus billing item. Verified unique across
-- all four sales extracts held today — 786, 4,941, 7,948 and 7,932 rows, zero duplicate
-- pairs within any file and zero collisions between any two of them.
--
-- Both halves are text, and that is load-bearing. Each daily dump ends with the sheet's
-- own grand total, a row with no customer, no date and no billing document, and its
-- presence makes pandas read both columns as floats — while the quarterly extracts, which
-- have no such row, read as integers. Stored raw, the same invoice would key as
-- '4731002954.0' from one file and '4731002954' from the other and be inserted twice. The
-- absorber puts both through `whole_number_text` before they arrive here.
create table public.tsl_sales (
  billing_document text not null,
  billing_item     text not null,
  -- The whole named line, for the same reason `raw_rows` is JSONB: the sheet is 234
  -- columns today, was 225 when the data contract described it, and gains more without
  -- warning. A typed column per field would mean a migration every time SAP adds one.
  row              jsonb not null,
  -- Extracted at insert, because these are the fields every reader slices on and a
  -- JSONB expression index on each would cost more than the columns do.
  billing_date     date,
  billing_month    text,
  despatch_plant   text,
  material_number  text,
  customer_code    text,
  -- Which upload first carried this line. Nullable and `on delete set null`: the batch is
  -- prunable operational data and the line is not, so losing the provenance must never
  -- take the fact with it.
  source_batch     uuid references public.raw_batches (id) on delete set null,
  first_seen_at    timestamptz not null default now(),
  primary key (billing_document, billing_item)
);

-- The two ways this table is read: a month of everything, and one customer down the
-- months. The trend tab does the first, the Megh and customer tabs the second.
create index tsl_sales_month_idx on public.tsl_sales (billing_month);
create index tsl_sales_customer_month_idx on public.tsl_sales (customer_code, billing_month);

-- Same sensitivity as `raw_rows`, and the same answer: this is sales transactions, and no
-- viewer has any business reading them. The worker writes with the service role and
-- bypasses all of this.
alter table public.tsl_sales enable row level security;

create policy "admin reads sales lines" on public.tsl_sales
  for select to authenticated using (public.is_admin());

-- Which batches have been folded in. Absorption runs over every batch that has none,
-- oldest first — not over the current one — because `promote_upload` supersedes the
-- previous batch the moment a second sales dump is uploaded, and a refresh that only
-- looked at `current` would never see the first one's lines.
alter table public.raw_batches add column absorbed_at timestamptz;

create index raw_batches_unabsorbed_idx on public.raw_batches (slot, uploaded_at)
  where absorbed_at is null;

-- Pruning must not outrun absorption. A superseded batch is disposable once its lines are
-- in the ledger and emphatically not before: without this clause, a sales dump uploaded
-- and left unrefreshed for a fortnight would be deleted with its lines never recorded,
-- and nothing downstream would report a gap — the months would simply be short.
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
      and (slot not like 'sales%' or absorbed_at is not null)
    returning 1
  )
  select count(*)::integer into removed from doomed;
  return query select removed;
end;
$$;

revoke execute on function public.prune_uploads(integer) from public, anon, authenticated;
grant execute on function public.prune_uploads(integer) to service_role;
