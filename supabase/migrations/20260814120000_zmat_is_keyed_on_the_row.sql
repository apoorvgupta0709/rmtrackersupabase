-- `dump_zmat` is keyed on the row's own content, not on the code and the plant.
--
-- Applied to production on 14 August 2026 as
-- `zmat_is_keyed_on_the_row_not_just_the_code_and_plant`. Nothing in this repository
-- applies a migration — there is no `supabase db push` in either workflow — so read the
-- applied list with `list_migrations` rather than this directory.
--
-- The old key was `(material_code, plant)`, and it is coarser than the data. zmat has no
-- natural key: no combination of its 24 columns is unique, 480 rows are byte-identical
-- repeats and that pair leaves 1,104 more over. Those 1,104 were read as noise — an end
-- finish and a surface finish swapped, a specification written `10` on one row and `010`
-- on the next — and they are not noise. The pipeline identifies a material by its code,
-- its description and an attribute key built from both diameters, the thickness, the
-- specification and both finishes, so two rows this pair calls the same are two different
-- materials to everything downstream.
--
-- Measured, running the pipeline off this table against off the uploaded sheet: nine
-- stock rows stopped resolving to a bucket, the STR plan lost two lines, a long-length
-- SKU's signed-off tonnage read 4.925 MT against a true 7.205, and the missing-mappings
-- queue gained a row that is not missing.
--
-- So the third part of the key is a digest of the row's own content, written by
-- `sources._row_digest` over the stored form of every column in `ZMAT_COLUMNS`. In
-- Python rather than as a generated column, so that the digest is decided by the value
-- as *stored* and cannot move with how a column happened to read that morning.
-- Byte-identical repeats still collapse — 481 of them — and anything the file wrote
-- differently is kept: 64,697 rows against the 64,074 the old key allowed.
alter table public.dump_zmat add column if not exists row_digest text;

-- The row's position in the sheet, and what the table is read back in order of. The
-- pipeline deduplicates zmat again on its own key with `keep="first"`, so "first" has to
-- mean the row the sheet wrote first and not whichever material code sorts lowest.
alter table public.dump_zmat add column if not exists source_seq integer;

-- Every row held was absorbed under the old key, so none carries a digest and the 1,104
-- are not there to backfill from. Emptied and re-absorbed instead: `raw_batches` still
-- holds the upload, which is what that table is for.
truncate table public.dump_zmat;
update public.raw_batches set absorbed_at = null where slot = 'zmat';

alter table public.dump_zmat drop constraint if exists dump_zmat_pkey;
alter table public.dump_zmat alter column row_digest set not null;
alter table public.dump_zmat add constraint dump_zmat_pkey
  primary key (material_code, plant, row_digest);

create index if not exists dump_zmat_source_seq_idx on public.dump_zmat (source_seq);
