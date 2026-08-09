-- The daily Excel dumps, as rows.
--
-- Every dump is a full snapshot, not a delta. sales.xlsx carries the whole month to
-- date and is re-sent each day, which is why it looks like it grows; stock, wip, yf65
-- and the rest are each a fresh extract. So the model is uniform: one *current* batch
-- per slot, and uploading a new one supersedes it. That is exactly what dropping a file
-- into dumps/ and re-running has always done, and it avoids inventing a delta merge
-- that could double-count a re-sent day.
--
-- Rows are stored as JSONB rather than typed columns because these sheets are wide and
-- unstable: sales.xlsx has 225 columns and dumps gain columns without warning. Rebuilt
-- with pd.DataFrame(rows, columns=...), a batch reproduces exactly what pd.read_excel
-- produced, and a new column in a dump never needs a migration.

create type batch_status as enum ('current', 'superseded', 'archived');

create table public.raw_batches (
  id                uuid primary key default gen_random_uuid(),
  -- The slot name from scripts/sources.py — 'sales', 'stock', 'orders:jsr'. The registry
  -- is the single definition of what the pipeline reads; this column names one of them.
  slot              text not null,
  -- Only the schedule needs this: its sheet is named for the month it covers, so a
  -- workbook holds Schedule July beside Schedule August and the pipeline picks by date.
  sheet             text,
  original_filename text not null,
  -- Content, not size. On 7 August rfd_4731.xlsx arrived at exactly the previous day's
  -- 57,435 bytes with a different digest, so a size check would have called a genuinely
  -- new extract stale and skipped it.
  content_sha256    text not null,
  -- Column order and per-column Excel cell type, captured at parse time. Order matters
  -- because two reads are positional (Bucketting's U:AF window, the contract sheets);
  -- the types are what lets a date come back a date rather than a string.
  columns           jsonb not null,
  column_types      jsonb not null,
  row_count         integer not null,
  status            batch_status not null default 'current',
  uploaded_by       uuid references public.profiles (id),
  uploaded_at       timestamptz not null default now(),
  superseded_at     timestamptz,
  -- Set when this batch was the current one at a month close, which is what keeps it
  -- out of the pruning job.
  month_end_of      date,
  notes             text
);

-- One current batch per slot. The schedule is the only slot that keeps more than one,
-- one per month sheet, so the key includes the sheet with an empty string standing in
-- for the slots that have none.
create unique index raw_batches_one_current_per_slot
  on public.raw_batches (slot, coalesce(sheet, ''))
  where status = 'current';

create index raw_batches_slot_idx on public.raw_batches (slot, uploaded_at desc);
create index raw_batches_month_end_idx on public.raw_batches (month_end_of)
  where month_end_of is not null;

create table public.raw_rows (
  batch_id uuid not null references public.raw_batches (id) on delete cascade,
  seq      integer not null,
  row      jsonb not null,
  primary key (batch_id, seq)
);

-- Uploads and the dumps behind them are operational data, not dashboard output: no
-- viewer has any business reading a raw sales extract. The worker writes with the
-- service role and bypasses all of this.
alter table public.raw_batches enable row level security;
alter table public.raw_rows    enable row level security;

create policy "uploaders read batches" on public.raw_batches
  for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role in ('admin', 'uploader')
  ));

create policy "admin manages batches" on public.raw_batches
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin reads rows" on public.raw_rows
  for select to authenticated using (public.is_admin());

-- Supersede the current batch for a slot and make this one current, in one statement so
-- there is never a moment with two current batches or none.
create or replace function public.supersede_slot(target_slot text, target_sheet text, new_batch uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.raw_batches
     set status = 'superseded', superseded_at = now()
   where slot = target_slot
     and coalesce(sheet, '') = coalesce(target_sheet, '')
     and status = 'current'
     and id <> new_batch;

  update public.raw_batches
     set status = 'current'
   where id = new_batch;
end;
$$;
