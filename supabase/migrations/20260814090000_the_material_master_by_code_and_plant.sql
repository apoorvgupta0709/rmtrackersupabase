-- zmat, the material master, keyed on the code and the plant it is extended at.
--
-- Applied to production as `the_material_master_by_code_and_plant`. Nothing in this
-- repository applies a migration, so read the applied list with `list_migrations`.
--
-- **The plant is half the key, and that is the point of the table.** zmat is a material ×
-- plant extract: the same code appears once per plant it is extended at, otherwise
-- identical. Keyed on the code alone it would be 57,478 rows instead of 64,074 and would
-- answer nothing about where a material can actually be made — which is exactly the
-- question a stock-transfer plan for 8406 asks, code by code, of both the sending and the
-- receiving plant. On the extract held, 1,257 codes are extended at 8406 and 100 of those
-- at 4731 as well.
--
-- The pair is not unique either, and no combination of these 24 columns is: 480 rows are
-- byte-identical repeats of another row, and `(Column1, PLANT)` still leaves 1,104 over —
-- pairs differing only in noise, `PE` and `AW` swapped between end finish and surface
-- finish, a specification written `10` on one row and `010` on the next. So the absorber
-- deduplicates in **frame order, first wins**, before it inserts. Left to
-- `resolution=ignore-duplicates`, PostgREST would resolve against whatever happened to
-- share a 2,000-row chunk, and which of two near-identical rows survived would move the
-- day the file gains a row above them.

-- Typed columns rather than the `row jsonb` every other accumulating table keeps, and
-- this is the one place that trade is worth making. 65,178 rows of 24 columns whose
-- *names* are longer than most of their values: stored as named JSONB objects they cost
-- about 59 MB against 15, on a database that had 105 MB of headroom. It is safe here and
-- would not be for the sales dump — SAP's material master does not gain a column every
-- few weeks, and if it ever does that is a migration rather than a silent loss.
create table public.dump_zmat (
  -- Canonical, through `material_code`: SAP pads a material number to eighteen characters
  -- or does not, per extract, and this master pads none while the transfer dump pads all.
  material_code text not null,
  -- Canonical, through `plant_code`, for the same reason: this file writes `788` where
  -- stock writes `0788`, and a join on the raw value silently matches a subset.
  plant         text not null,
  plant_raw     text,

  material_description    text,
  material_type           text,
  material_group          text,
  old_material_number     text,
  base_unit_of_measure    text,
  -- Text, not a number: `DIVISION` is an int64 out of pandas and a code in SAP, and left
  -- numeric it reads `10` where the file says `010`.
  division                text,
  material_grade          text,
  outer_diameter          numeric,
  inner_diameter          numeric,
  thickness               numeric,
  length                  numeric,
  weight_per_metre        numeric,
  weight_per_metre_2      numeric,
  weight_per_number       numeric,
  weight_per_number_2     numeric,
  item_type               text,
  material_draw_type      text,
  material_category       text,
  material_specification  text,
  material_end_finish     text,
  material_surface_finish text,
  material_geometry       text,

  source_batch  uuid references public.raw_batches (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  primary key (material_code, plant)
);

-- "Which plants is this code extended at" is the primary key already. "Which codes does
-- this plant hold" is the other half of a transfer plan, and needs its own index.
create index dump_zmat_plant_idx on public.dump_zmat (plant);
-- The pipeline's own use of zmat is a description lookup, and `first_unique` over a
-- description is how a recovered code is found.
create index dump_zmat_description_idx on public.dump_zmat (material_description);

-- A material master is not a transaction. Anyone signed in may read it, as they may the
-- bucket master and the OEM key.
alter table public.dump_zmat enable row level security;

create policy "signed in reads the material master" on public.dump_zmat
  for select to authenticated using (true);
