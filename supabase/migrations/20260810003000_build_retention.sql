-- Keep the current build, the month-end ones, and a short tail. Drop the rest.
--
-- A build is about 23,000 rows, and refreshing more than once a day is normal — a stock
-- extract arrives stale, the corrected one follows within the hour, and both get run. So
-- without this the table grows by a few hundred thousand rows a week for data nobody
-- will look at again.
--
-- What is kept is what someone might have to answer a question about: what the dashboard
-- says now, what it said at each month close, and the last fortnight in case a figure is
-- queried while it is still fresh in mind.

create or replace function public.prune_builds(keep_days integer default 14)
returns table (deleted_builds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  with doomed as (
    delete from public.dashboard_builds
    where is_month_end = false
      and id <> public.current_build_id()
      and coalesce(published_at, started_at) < now() - make_interval(days => keep_days)
    returning 1
  )
  select count(*)::integer into removed from doomed;

  -- Sections, scalars and drill-downs go with their build; the foreign keys cascade.
  return query select removed;
end;
$$;

revoke execute on function public.prune_builds(integer) from public, anon, authenticated;
grant execute on function public.prune_builds(integer) to service_role;

-- Uploads are superseded rather than deleted, for the same reason and with the same
-- shape: the current one per slot always stays, month-end ones stay, the rest age out.
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
    returning 1
  )
  select count(*)::integer into removed from doomed;
  return query select removed;
end;
$$;

revoke execute on function public.prune_uploads(integer) from public, anon, authenticated;
grant execute on function public.prune_uploads(integer) to service_role;
