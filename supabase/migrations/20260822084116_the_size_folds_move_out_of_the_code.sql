-- The size-fold rules, moved out of the code and into the owner's hands.
--
-- `THICKNESS_GROUPS` and `OD_GROUPS` fold a customer-written near-value onto the
-- dimension Bucketting governs — 1.22 onto 1.2, 22.2 onto 22.23 — before any join,
-- everywhere a wall or an OD is read. They were code constants, which meant the next
-- fold (the next 1.22, which cost 85,500 pieces of August schedule a bucket) was a code
-- change. Now they are rows: edited on the Missing mappings tab, read by the pipeline at
-- the start of every run, echoed to `config/size_folds.json` so a clean clone rebuilds
-- identically.
--
-- Not build-scoped, for the same reason `bucket_assignments` is not: a fold is a fact
-- about a size that has to survive the refresh that replaces every row on the page.
-- Numeric at two decimals because that is the space the lookup happens in — the norm
-- functions key on `round(float(value), 2)`, so the column type is what keeps the key
-- exact and "1.20" and "1.2" one row.

create table public.size_folds (
  kind       text not null check (kind in ('thickness', 'od')),
  written    numeric(8,2) not null,
  governed   numeric(8,2) not null,
  note       text,
  decided_by uuid references public.profiles (id),
  decided_at timestamptz not null default now(),
  primary key (kind, written)
);

alter table public.size_folds enable row level security;

-- A size and the size it folds onto is not commercial information — it is the same
-- mapping the material master implies — so anyone signed in may read it. Writing is the
-- owner's alone, and the policy is what enforces that rather than a hidden control.
create policy "read folds" on public.size_folds
  for select to authenticated using (true);

create policy "admin folds" on public.size_folds
  for insert to authenticated with check (public.is_admin());

create policy "admin refolds" on public.size_folds
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin unfolds" on public.size_folds
  for delete to authenticated using (public.is_admin());

-- The seed is the constants as they stood on 22 August 2026, generated from the module
-- itself rather than retyped. Identity pairs (1.20 -> 1.20) are kept deliberately: the
-- master then reads as "the governed sizes and their aliases", and behaviour-equality
-- with the code it replaces is trivially checkable. Rows seeded here carry no decided_by,
-- which is honest — they are the pipeline's history, not one person's call.
insert into public.size_folds (kind, written, governed, note) values
  ('thickness', 1.00, 1.00, null),
  ('thickness', 1.01, 1.00, null),
  ('thickness', 1.02, 1.00, null),
  ('thickness', 1.20, 1.20, null),
  ('thickness', 1.21, 1.20, 'Near-gauge: Bucketting governs 256 buckets at 1.20 and none at 1.21 or 1.22.'),
  ('thickness', 1.22, 1.20, 'Near-gauge written by Srikam, Rajsriya and NMPL; its absence left 85,500 pieces of August schedule reaching no bucket.'),
  ('thickness', 1.50, 1.60, null),
  ('thickness', 1.60, 1.60, null),
  ('thickness', 1.62, 1.60, 'Sandhar Technology writes 1.62; Bucketting governs only 1.6.'),
  ('thickness', 1.63, 1.60, null),
  ('thickness', 1.90, 2.00, null),
  ('thickness', 1.95, 2.00, null),
  ('thickness', 2.00, 2.00, null),
  ('thickness', 2.03, 2.00, null),
  ('thickness', 2.25, 2.25, null),
  ('thickness', 2.30, 2.30, null),
  ('thickness', 2.32, 2.25, null),
  ('thickness', 2.34, 2.30, null),
  ('thickness', 2.41, 2.50, null),
  ('thickness', 2.45, 2.50, null),
  ('thickness', 2.50, 2.50, null),
  ('thickness', 2.60, 2.60, null),
  ('thickness', 2.65, 2.60, null),
  ('thickness', 2.70, 2.80, null),
  ('thickness', 2.75, 2.80, null),
  ('thickness', 2.80, 2.80, null),
  ('thickness', 3.00, 3.00, null),
  ('thickness', 3.02, 3.00, null),
  ('thickness', 3.40, 3.50, null),
  ('thickness', 3.50, 3.50, null),
  ('od', 22.20, 22.23, 'Bucketting holds 22.23 and never 22.2.'),
  ('od', 22.23, 22.23, null),
  ('od', 28.58, 28.58, null),
  ('od', 28.60, 28.58, null),
  ('od', 37.90, 37.95, null),
  ('od', 37.95, 37.95, null),
  ('od', 41.28, 41.28, null),
  ('od', 41.30, 41.28, 'Bucketting holds 41.28 and never 41.3.');
