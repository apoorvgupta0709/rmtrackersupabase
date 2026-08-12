-- What the live database already does about uploading, written down.
--
-- `lib/dumps/upload.ts` calls `promote_upload`, and `is_uploader`, that function and the
-- three insert policies below all exist in production and in none of the checked-in
-- migrations. They were applied by hand. Nothing is broken today because production has
-- them; what is broken is every environment that does not — a Supabase branch, a fresh
-- project, anyone rebuilding from this repository — where an uploader can sign in, parse
-- a workbook, and be refused by a policy that this repository never mentions.
--
-- So this records them rather than changing them. Every statement is written to be a
-- no-op against a database that already has it, and the definitions below are the ones
-- read back out of production, not a fresh attempt at the same idea.
--
-- Three rules are worth keeping straight, because they are what make an upload safe to
-- open to a non-admin:
--
--  - A batch is inserted **superseded**, and only `promote_upload` makes it current. A
--    half-written sheet is therefore never the one the pipeline reads.
--  - A row may only be added to a batch that is the uploader's own and not yet current,
--    so nobody can append to a published batch or to somebody else's.
--  - `promote_upload` counts the rows before promoting and refuses a short one. PostgREST
--    fails a chunk without failing the loop, and a sheet that arrives 900 rows short is
--    the failure mode that looks like a working refresh.

create or replace function public.is_uploader()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role in ('admin', 'uploader')
  );
$$;

revoke execute on function public.is_uploader() from public, anon;
grant execute on function public.is_uploader() to authenticated;

-- Inserted as somebody's own, and only ever as somebody's own: `uploaded_by` is pinned to
-- the caller so a batch cannot be filed under another account.
drop policy if exists "uploaders create batches" on public.raw_batches;
create policy "uploaders create batches" on public.raw_batches
  for insert to authenticated
  with check (public.is_uploader() and uploaded_by = (select auth.uid()));

drop policy if exists "uploaders add rows to their own pending batch" on public.raw_rows;
create policy "uploaders add rows to their own pending batch" on public.raw_rows
  for insert to authenticated
  with check (
    public.is_uploader() and exists (
      select 1 from public.raw_batches b
      where b.id = raw_rows.batch_id
        and b.uploaded_by = (select auth.uid())
        and b.status <> 'current'
    )
  );

drop policy if exists "uploaders read their own rows" on public.raw_rows;
create policy "uploaders read their own rows" on public.raw_rows
  for select to authenticated
  using (
    public.is_admin() or exists (
      select 1 from public.raw_batches b
      where b.id = raw_rows.batch_id and b.uploaded_by = (select auth.uid())
    )
  );

-- Promotion is the one privileged step, and it is a function rather than an `update`
-- policy so that the count check cannot be skipped by writing the row directly.
create or replace function public.promote_upload(new_batch uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.raw_batches;
  actual integer;
begin
  if not public.is_uploader() then
    raise exception 'not permitted to publish an upload';
  end if;

  select * into b from public.raw_batches where id = new_batch;
  if b.id is null then
    raise exception 'no such upload';
  end if;
  if b.uploaded_by <> (select auth.uid()) and not public.is_admin() then
    raise exception 'that upload belongs to someone else';
  end if;

  -- A short batch is the failure this exists to stop. PostgREST fails one chunk without
  -- failing the loop around it, so a sheet arrives missing a thousand rows, the refresh
  -- computes over what came, and every figure derived from it is plausible and wrong.
  select count(*) into actual from public.raw_rows where batch_id = new_batch;
  if actual <> b.row_count then
    raise exception 'upload is incomplete: % of % rows arrived', actual, b.row_count;
  end if;

  update public.raw_batches
     set status = 'superseded', superseded_at = now()
   where slot = b.slot
     and coalesce(sheet, '') = coalesce(b.sheet, '')
     and status = 'current'
     and id <> new_batch;

  update public.raw_batches set status = 'current' where id = new_batch;
end;
$$;

revoke execute on function public.promote_upload(uuid) from public, anon;
grant execute on function public.promote_upload(uuid) to authenticated;
