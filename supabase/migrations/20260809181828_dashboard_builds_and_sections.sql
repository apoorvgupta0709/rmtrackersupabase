-- What a refresh produces, versioned.
--
-- The pipeline is stateless: it recomputes everything from the current dumps and reads
-- no prior output. So a build is a complete, self-contained answer, and publishing is
-- swapping which one readers see. Nothing is ever edited in place, which means a bad
-- refresh is a build you do not publish rather than a page you have to repair.

create table public.dashboard_builds (
  id           uuid primary key default gen_random_uuid(),
  as_of        date not null,
  status       text not null check (status in ('PASS', 'WARN', 'FAIL')),
  warnings     jsonb not null default '[]'::jsonb,
  failures     jsonb not null default '[]'::jsonb,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  -- Only a published build is visible to readers. The gate is the pipeline's own:
  -- PASS and WARN publish, FAIL does not.
  published_at timestamptz,
  -- The last build of a calendar month, kept indefinitely while the rest are pruned.
  is_month_end boolean not null default false,
  triggered_by uuid references public.profiles (id),
  run_url      text,
  notes        text
);

create index dashboard_builds_published_idx
  on public.dashboard_builds (published_at desc nulls last);
-- Cast to timestamp so date_trunc resolves to the immutable overload rather than the
-- timestamptz one, which depends on the session time zone and cannot be indexed.
create unique index dashboard_builds_one_month_end
  on public.dashboard_builds (date_trunc('month', as_of::timestamp)) where is_month_end;

-- The build a reader sees: the most recently published one.
create or replace function public.current_build_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.dashboard_builds
  where published_at is not null
  order by published_at desc
  limit 1;
$$;

-- Which tab each section belongs to. Data rather than a policy per table, so adding a
-- section is a row and cannot accidentally ship with no policy at all.
create table public.section_views (
  section  text not null,
  view_key text not null references public.dashboard_views (key),
  primary key (section, view_key)
);

create table public.detail_prefix_views (
  prefix   text not null,
  view_key text not null references public.dashboard_views (key),
  primary key (prefix, view_key)
);

create or replace function public.can_read_section(target_section text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1
    from public.section_views sv
    join public.view_grants vg on vg.view_key = sv.view_key
    where sv.section = target_section and vg.profile_id = (select auth.uid())
  );
$$;

create or replace function public.can_read_prefix(target_prefix text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1
    from public.detail_prefix_views dp
    join public.view_grants vg on vg.view_key = dp.view_key
    where dp.prefix = target_prefix and vg.profile_id = (select auth.uid())
  );
$$;

-- The row-shaped output. Sections start as JSONB and are promoted to typed columns as
-- each view is ported, so the schema grows with the front end instead of ahead of it.
create table public.build_sections (
  build_id uuid not null references public.dashboard_builds (id) on delete cascade,
  section  text not null,
  seq      integer not null,
  row      jsonb not null,
  primary key (build_id, section, seq)
);

create index build_sections_lookup on public.build_sections (build_id, section);

-- The scalars and small config blobs: summary, metadata, mapping_quality,
-- detail_columns, governed_buckets, qc.
create table public.build_scalars (
  build_id uuid not null references public.dashboard_builds (id) on delete cascade,
  key      text not null,
  value    jsonb not null,
  -- The headline cards and the tab config are not what the grants are protecting, so
  -- they are readable by anyone signed in. `qc` is admin-only.
  admin_only boolean not null default false,
  primary key (build_id, key)
);

-- The drill-downs. 6,013 keys and 16,689 rows, 3.6 MB — 56% of the old payload, for
-- data nobody sees until they open a modal. One key is fetched at a time.
create table public.detail_rows (
  build_id   uuid not null references public.dashboard_builds (id) on delete cascade,
  prefix     text not null,
  detail_key text not null,
  seq        integer not null,
  row        jsonb not null,
  primary key (build_id, prefix, detail_key, seq)
);

alter table public.dashboard_builds    enable row level security;
alter table public.build_sections      enable row level security;
alter table public.build_scalars       enable row level security;
alter table public.detail_rows         enable row level security;
alter table public.section_views       enable row level security;
alter table public.detail_prefix_views enable row level security;

-- A reader sees published builds and, within them, only the sections their grants cover.
create policy "read published builds" on public.dashboard_builds
  for select to authenticated using (published_at is not null or public.is_admin());

create policy "read granted sections" on public.build_sections
  for select to authenticated
  using (public.can_read_section(section)
         and (build_id = public.current_build_id() or public.is_admin()));

create policy "read scalars" on public.build_scalars
  for select to authenticated
  using ((not admin_only or public.is_admin())
         and (build_id = public.current_build_id() or public.is_admin()));

create policy "read granted details" on public.detail_rows
  for select to authenticated
  using (public.can_read_prefix(prefix)
         and (build_id = public.current_build_id() or public.is_admin()));

create policy "read section map" on public.section_views
  for select to authenticated using (true);
create policy "read prefix map" on public.detail_prefix_views
  for select to authenticated using (true);

revoke execute on function public.current_build_id() from public, anon;
revoke execute on function public.can_read_section(text) from public, anon;
revoke execute on function public.can_read_prefix(text) from public, anon;
grant execute on function public.current_build_id() to authenticated;
grant execute on function public.can_read_section(text) to authenticated;
grant execute on function public.can_read_prefix(text) to authenticated;
