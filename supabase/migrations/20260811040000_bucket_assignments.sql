-- What the owner decides about a material code, kept where a refresh cannot lose it.
--
-- The mapping queues have always been the working end of this dashboard: a code carrying
-- no governed bucket reaches no tracker, so its tonnage shows nowhere and somebody has to
-- say which bucket it belongs to. On the static page that decision was a dropdown backed
-- by an object in memory — it vanished on reload, and it changed no figure on any tab.
--
-- So this table is deliberately **not** scoped to a build. A build is a self-contained
-- answer that the next refresh replaces wholesale; an assignment is a fact about a
-- material code that has to survive every one of them. Scoping it to a build would
-- reproduce exactly the defect it exists to fix, one day later.
--
-- The assignment is applied by the **next refresh**, not to the build on screen. The
-- pipeline is stateless and recomputes everything from the dumps; a bucket decides which
-- tracker a code's tonnage lands on, what coverage that bucket then shows, and what the
-- STR plan does about it. Editing one cell of a published build would leave every figure
-- derived from it stale and no way to tell. The page says which state a row is in rather
-- than letting an assignment look applied when it is not.

create table public.bucket_assignments (
  -- Which queue the code came from, and so what space `assigned_to` is in: `bucket` is a
  -- governed bucket from `Bucketting`, `megh_sku` is a key on the vsm stock plan.
  scope         text not null check (scope in ('bucket', 'megh_sku')),
  material_code text not null,
  -- Null is a decision too: it clears an assignment without losing who cleared it.
  assigned_to   text,
  note          text,
  assigned_by   uuid references public.profiles (id),
  assigned_at   timestamptz not null default now(),
  primary key (scope, material_code)
);

alter table public.bucket_assignments enable row level security;

-- A material code and the bucket it belongs to is not commercial information — it is the
-- same mapping the material master carries — so anyone signed in may read it. Writing is
-- the owner's alone, and it is the policy that enforces that rather than a hidden
-- control: a viewer who forges the request is refused by the database.
create policy "read assignments" on public.bucket_assignments
  for select to authenticated using (true);

create policy "admin assigns" on public.bucket_assignments
  for insert to authenticated with check (public.is_admin());

create policy "admin reassigns" on public.bucket_assignments
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin unassigns" on public.bucket_assignments
  for delete to authenticated using (public.is_admin());

-- Who made the call is part of the record: these decisions are judgement, not lookup, and
-- the next person to look at a bucket needs to know whose judgement it was.
create index bucket_assignments_recent
  on public.bucket_assignments (assigned_at desc);
