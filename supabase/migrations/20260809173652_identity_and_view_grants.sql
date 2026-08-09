-- Who may sign in, and which of the eleven dashboard views each person may read.
--
-- This replaces access.json, where a SHA-256 of the password sat in a world-readable
-- file, the browser compared it to what was typed, and "authorization" was toggling a
-- CSS class on a tab button. Every account still downloaded the whole 6.5 MB payload,
-- so the Megh Steel account could read customer contract prices out of devtools. Here a
-- grant is a row and it is enforced by the database, so a view nobody granted returns
-- no rows rather than being hidden.

create type app_role as enum ('admin', 'uploader', 'viewer');

-- The eleven tabs, named. Ordinals broke twice in this project's history, so views are
-- referred to by key everywhere and never by position.
create table public.dashboard_views (
  key         text primary key,
  label       text not null,
  sort_order  int  not null
);

insert into public.dashboard_views (key, label, sort_order) values
  ('customerView',  'Customer tracker',   1),
  ('meghView',      'Megh Steel sales',   2),
  ('llView',        'Long-length tracker',3),
  ('mappingView',   'Missing mappings',   4),
  ('salesView',     'Sales summary',      5),
  ('trendView',     'Past sales trend',   6),
  ('pricingView',   'SKU pricing',        7),
  ('stockView',     'Stock analysis',     8),
  ('strView',       'STR to 8406',        9),
  ('transferView',  'Transfers',         10),
  ('overdueView',   'Ancillary overdue', 11);

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text,
  role       app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

create table public.view_grants (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  view_key   text not null references public.dashboard_views (key),
  granted_at timestamptz not null default now(),
  primary key (profile_id, view_key)
);

create index view_grants_profile_idx on public.view_grants (profile_id);

-- Self-signup is open only to addresses on this list. Enforced in the database rather
-- than in the sign-up form, so a direct call to the auth endpoint is refused too.
create table public.allowed_domains (
  domain     text primary key,
  note       text,
  created_at timestamptz not null default now()
);

-- `security definer` with an empty search_path: these run as the owner, so an
-- unqualified name must never be resolvable to something a caller planted.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

-- Wrapped in `select` at every call site so the planner evaluates it once per query
-- rather than once per row.
create or replace function public.can_read_view(target_view text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1 from public.view_grants
    where profile_id = (select auth.uid()) and view_key = target_view
  );
$$;

-- Any of a set of views. A table feeding more than one tab is readable by anyone
-- granted any of them.
create or replace function public.can_read_any_view(target_views text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1 from public.view_grants
    where profile_id = (select auth.uid()) and view_key = any(target_views)
  );
$$;

alter table public.profiles        enable row level security;
alter table public.view_grants     enable row level security;
alter table public.dashboard_views enable row level security;
alter table public.allowed_domains enable row level security;

create policy "read own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "admin reads every profile" on public.profiles
  for select to authenticated using (public.is_admin());
create policy "admin writes profiles" on public.profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "read own grants" on public.view_grants
  for select to authenticated using ((select auth.uid()) = profile_id);
create policy "admin reads every grant" on public.view_grants
  for select to authenticated using (public.is_admin());
create policy "admin writes grants" on public.view_grants
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- The tab list itself is not secret; which tabs you may read is.
create policy "anyone signed in reads the view list" on public.dashboard_views
  for select to authenticated using (true);

create policy "admin manages allowed domains" on public.allowed_domains
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
