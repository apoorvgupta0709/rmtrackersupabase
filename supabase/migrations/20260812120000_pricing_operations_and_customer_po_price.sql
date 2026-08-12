-- What the owner corrects about a price, kept where a refresh cannot lose it.
--
-- The SKU pricing tab reads `contract.xlsx` and adds the value-added operations the
-- schedule flags: `FC/NFC`, `Chamferring`, `Angle Cut`, and annealing off `Bucketting`.
-- Those flags are right most of the time and wrong some of it. Every one of the six SKUs
-- where the view disagrees with NMPL's own reconciliation is an operation question — a
-- fin-cut ladder charged on a `PE` line the schedule does not flag, a fin cut the customer
-- waived, annealing the sheet omitted. Until now the only way to record that was a note in
-- a document nobody reads while looking at the price.
--
-- Two tables, because they answer two different questions:
--
--  - `sku_operations` says **what this SKU actually carries**, which is an input to the
--    contract formula and therefore changes the calculated price.
--  - `customer_po_prices` says **what the customer's PO says**, which is not derived from
--    anything. It sits beside the calculated price so the difference can be read, and it
--    is what the quarterly CN/DN calculation quotes as the PO rate.
--
-- Neither is scoped to a build, for the reason `bucket_assignments` is not: a build is
-- replaced wholesale every refresh and these are facts about a SKU that have to survive
-- every one of them.
--
-- Both are keyed on the four parts that identify a priced row — customer, governed bucket,
-- material code and length — which is also what the `PRICEBUILD` drill-down key is composed
-- from, so a row and the working behind it can never disagree about which SKU they are
-- describing. The bucket earns its place: Metalman schedules code 3768904 at 878 mm as both
-- a 1.6 and a 2.5 wall, so the other three name two SKUs with prices 44% apart. A schedule
-- line carrying no material code stores the empty string rather than null, because a null
-- in a primary key would let the same SKU be recorded twice.

create table public.sku_operations (
  customer      text not null,
  bucket        text not null,
  material_code text not null,
  length_mm     numeric not null,
  -- The whole set, not a delta. A delta would need a base to apply against, and the base
  -- is the schedule's flags, which move between builds; storing the answer means the row
  -- says what it means without knowing which build it was written on.
  operations    text[] not null,
  note          text,
  set_by        uuid references public.profiles (id),
  set_at        timestamptz not null default now(),
  primary key (customer, bucket, material_code, length_mm)
);

create table public.customer_po_prices (
  customer      text not null,
  bucket        text not null,
  material_code text not null,
  length_mm     numeric not null,
  -- Per quarter, because a PO price is negotiated per quarter. One price against three
  -- quarter columns would be ambiguous about which of them it belonged to.
  quarter       text not null,
  price         numeric,
  -- The SKU's own unit, copied from the priced row: INR/m for a long length, INR/nos for
  -- a cut piece. Stored rather than derived so a price recorded today still reads
  -- correctly if the LL/CTL cut-off ever moves.
  unit          text not null,
  note          text,
  set_by        uuid references public.profiles (id),
  set_at        timestamptz not null default now(),
  primary key (customer, bucket, material_code, length_mm, quarter)
);

alter table public.sku_operations     enable row level security;
alter table public.customer_po_prices enable row level security;

-- Read is held to the same grant as the figures these annotate. This is the difference
-- from `bucket_assignments`, whose read policy is `using (true)`: a material code and the
-- bucket it belongs to is the same mapping the material master carries and is not
-- commercial, where an operation set and a PO price are both worth money to a competitor
-- and belong to the tab that is granted deliberately. `can_read_view` folds in
-- `is_admin()`.
--
-- Writing is the owner's alone, unlike an overdue remark. A remark feeds no figure; both
-- of these do — an operation changes the calculated price and a PO price is quoted in a
-- CN/DN claim — so the person who may change them is the person who publishes the build.
-- It is the policy that enforces that and not the hidden control: a viewer who forges the
-- request is refused by the database, and the refusal is what the cell reports.
create policy "read sku operations" on public.sku_operations
  for select to authenticated using (public.can_read_view('pricingView'));

create policy "admin sets operations" on public.sku_operations
  for insert to authenticated with check (public.is_admin());

create policy "admin revises operations" on public.sku_operations
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Clearing is a delete, so a SKU with nothing recorded reads as "the schedule's flags
-- govern this" rather than "somebody decided it carries no operations".
create policy "admin clears operations" on public.sku_operations
  for delete to authenticated using (public.is_admin());

create policy "read customer po prices" on public.customer_po_prices
  for select to authenticated using (public.can_read_view('pricingView'));

create policy "admin sets po prices" on public.customer_po_prices
  for insert to authenticated with check (public.is_admin());

create policy "admin revises po prices" on public.customer_po_prices
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin clears po prices" on public.customer_po_prices
  for delete to authenticated using (public.is_admin());

create index sku_operations_recent     on public.sku_operations (set_at desc);
create index customer_po_prices_recent on public.customer_po_prices (set_at desc);

-- The quarterly CN/DN calculation is published as a drill-down rather than a section: a
-- quarter is around eight thousand billing lines across all customers and a tab fetches a
-- section whole. `detail_rows` is fetched one key at a time and gated on its prefix, so
-- only the customer and quarter actually asked for is ever read.
insert into public.detail_prefix_views (prefix, view_key) values ('RECO', 'pricingView')
  on conflict do nothing;
