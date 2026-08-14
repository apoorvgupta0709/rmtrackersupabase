-- The bucketing and OEM masters, as tables that accumulate.
--
-- Applied to production as `the_two_mapping_masters_accumulate`. Nothing in this
-- repository applies a migration, so read the applied list with `list_migrations`.
--
-- Both come off the approved RM tracker workbook and both are mappings rather than
-- statements of a moment: a material code belongs to a bucket, a customer belongs to an
-- OEM. Superseded on every upload, a workbook that happens not to mention a code deletes
-- it, and there is nothing to say it ever existed.
--
-- **The newer workbook wins.** That is the owner's decision and it is the opposite of the
-- sales ledger's: a code really does get re-bucketed and an OEM's spelling really does get
-- corrected, and keep-first would mean neither ever landed — the workbook would stop being
-- the thing that decides, and `bucket_assignments` would become the only way to correct a
-- master it exists to override. What accumulating buys is the other direction: a code the
-- newest workbook does not mention is not thereby forgotten.

-- Keyed on the material code, and emphatically not on `Bucket`.
--
-- `Bucket` is what the slot's read spec names as its key column, and it is a *label*: the
-- size family a code belongs to, shared across codes. 167 distinct buckets over 1,538
-- rows, and `12.7-0-1.6-ERW 1-PE` alone covers 27 material codes. Keyed on it this table
-- would hold 167 rows and lose nine tenths of the mapping without any of it failing.
-- `Material Codes` is unique across all 1,538 rows, measured on the workbook held.
--
-- The code is text, through `whole_number_text`. The column has blanks so pandas reads it
-- as float64 — `2426342.0` — and stored that way it joins to the material code on the
-- sales, stock and zmat side not at all.
create table public.dump_bucketing (
  material_code text primary key,
  -- The named row, for the same reason the ledgers keep one: a column added to the
  -- workbook lands here without a migration.
  row           jsonb not null,
  bucket        text,
  ctl_bucket    text,
  ll_or_ctl     text,
  grade         text,
  fc_pe         text,
  annealed      text,
  od            numeric,
  inner_diameter numeric,
  thickness     numeric,
  length        numeric,
  -- Which upload these values came from — the latest to carry the code, since the later
  -- workbook wins.
  source_batch  uuid references public.raw_batches (id) on delete set null,
  first_seen_at timestamptz not null default now()
);

-- Deliberately no column for `kG/nos`. It is in `row` and stays there: the sheet writes
-- kilograms per *piece* on CTL rows and per *metre* on the 5.6 and 6 m rows, with nothing
-- in the row to say which, so a column of that name invites a sum that means nothing.

-- The two ways a bucket master is read: which codes are in this bucket, and which bucket
-- is this code in. The second is the primary key already.
create index dump_bucketing_bucket_idx on public.dump_bucketing (bucket);
create index dump_bucketing_ctl_bucket_idx on public.dump_bucketing (ctl_bucket);

-- Keyed on the customer exactly as the sheet spells it — `Customer ` really does end in a
-- space, and the read is by name.
--
-- Not normalised for case or whitespace on the way in, and that is load-bearing: two of
-- the 174 customers collide once upper-cased, so a `citext` key or a `.upper()` here would
-- silently drop a row. The OEM key is also the one place exact spelling is the point —
-- `Rane` against `RANE` is one OEM in some summaries and two in others.
create table public.dump_oem_key (
  customer      text primary key,
  row           jsonb not null,
  oem           text,
  cam           text,
  source_batch  uuid references public.raw_batches (id) on delete set null,
  first_seen_at timestamptz not null default now()
);

create index dump_oem_key_oem_idx on public.dump_oem_key (oem);

-- Neither of these is a transaction, and both are mappings the dashboard already exposes,
-- so the read is open to anyone signed in rather than admin-only as the ledgers are.
alter table public.dump_bucketing enable row level security;
alter table public.dump_oem_key   enable row level security;

create policy "signed in reads the bucket master" on public.dump_bucketing
  for select to authenticated using (true);
create policy "signed in reads the OEM key" on public.dump_oem_key
  for select to authenticated using (true);

-- Pruning must not outrun absorption, for every slot that accumulates. Written as a
-- lookup against the slots that have an accumulating table rather than a growing `or`
-- chain, so that adding the next one cannot silently leave a dump prunable unstored.
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
           or (slot not like 'sales%'
               and slot not in ('transfers', 'bucketting', 'oem_key', 'zmat')))
    returning 1
  )
  select count(*)::integer into removed from doomed;
  return query select removed;
end;
$$;

revoke execute on function public.prune_uploads(integer) from public, anon, authenticated;
grant execute on function public.prune_uploads(integer) to service_role;

-- ---- Material codes, canonicalised the way plant codes are --------------------------
--
-- Applied as `material_codes_canonicalise_like_plants`.
--
-- SAP holds a material number zero-padded to eighteen characters and shows it unpadded,
-- and which of the two reaches a dump is decided per extract. Measured on what is stored:
-- the transfer dump pads all 1,088 of its lines and WIP all 693; stock and the bucketing
-- master pad none; and the sales ledger pads 6,539 of 22,419, because the daily dump and
-- the quarterly archives disagree with each other.
--
-- So the same material is `000000000003501105` in one table and `3501105` in the next.
-- **Before this, 0 of 1,088 transfer lines reached a bucket. After it, 837 do**, and
-- 20,118 of 22,419 sales lines. That join is the groundwork the 8406 stock-transfer plan
-- stands on, so it was worth finding now rather than there.
create or replace function public.material_code(value text)
returns text language sql immutable as $$
  select case
    when value is null or btrim(value) = '' then null
    when btrim(value) ~ '^[0-9]+$'
      then coalesce(nullif(ltrim(btrim(value), '0'), ''), '0')
    when btrim(value) ~ '^[0-9]+\.0+$'
      then coalesce(nullif(ltrim(split_part(btrim(value), '.', 1), '0'), ''), '0')
    else btrim(value)
  end;
$$;

grant execute on function public.material_code(text) to authenticated;

-- The file's own spelling is kept beside the canonical one, as it is for plants: which
-- padding an extract chose is evidence about the extract, and throwing it away would
-- make a genuine inconsistency between two dumps unprovable afterwards.
alter table public.tsl_sales     add column material_number_raw text;
alter table public.tsl_transfers add column material_number_raw text;
alter table public.tsl_sales     add column despatch_plant_raw  text;
alter table public.tsl_transfers add column despatch_plant_raw  text;

update public.tsl_sales
   set material_number_raw = material_number,
       material_number     = public.material_code(material_number),
       despatch_plant_raw  = despatch_plant,
       despatch_plant      = public.plant_code(despatch_plant);

update public.tsl_transfers
   set material_number_raw = material_number,
       material_number     = public.material_code(material_number);

create index tsl_sales_material_idx     on public.tsl_sales (material_number);
create index tsl_transfers_material_idx on public.tsl_transfers (material_number);
