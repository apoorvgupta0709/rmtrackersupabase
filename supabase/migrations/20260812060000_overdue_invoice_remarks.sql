-- Why an invoice is late, kept where a refresh cannot lose it.
--
-- The overdue tab says what is owed and for how long. It has never said *why*, and that is
-- the only part of the row that is judgement rather than arithmetic: a rate under dispute,
-- a GRN the customer has not passed, a cheque promised for the twentieth. That reason has
-- lived in somebody's head and in email, so the same invoice gets chased twice and the
-- person chasing it the second time starts from nothing.
--
-- Like `bucket_assignments`, this table is deliberately **not** scoped to a build. Every
-- refresh publishes a new build and replaces the last wholesale, and the drill-down rows
-- have no stable identity within one — their primary key ends in `seq`, which is a sort
-- position that moves as invoices age and are paid. A remark written onto a build row
-- would be gone by morning.
--
-- Unlike an assignment, a remark is **live the moment it is saved**. An assignment decides
-- which tracker a code's tonnage lands on, so it cannot take effect until the pipeline
-- recomputes everything downstream of it; a remark is read by nobody but a person and
-- feeds no figure on any tab. So the cell that writes it must not say "applies at the next
-- refresh" — it applies now.

create table public.invoice_remarks (
  -- `Billing Doc` from the receivables file: the invoice, not the accounting document.
  -- One invoice can arrive as several line items differing only in amount (58 of 485 rows
  -- in the current build), and they are the same invoice with the same reason for being
  -- late, so they share one remark. `Document Number` would split them.
  invoice_no  text primary key,
  -- Who it was written against. Not part of the key — an invoice number belongs to one
  -- ancillary — but the remark is unreadable without it once the invoice is paid and has
  -- dropped off the tab.
  ancillary   text not null,
  remark      text not null,
  remarked_by uuid references public.profiles (id),
  remarked_at timestamptz not null default now()
);

alter table public.invoice_remarks enable row level security;

-- A remark names a customer and a commercial dispute, so it is held to the same grant as
-- the figures it annotates: whoever may read the overdue tab may read and write its
-- remarks, and nobody else. `can_read_view` already folds in `is_admin()`.
--
-- Writing is open to every reader of the tab rather than the owner alone, because the
-- person who knows why an invoice is stuck is usually not the person who published the
-- build. The cost is that one reader can overwrite another's remark, so the row records
-- who wrote it and when. The panel shows the date to everyone; `remarked_by` resolves to
-- a name only for the owner, since `profiles` lets a reader see nobody's row but their
-- own. It is there for the question "who said this", which is the owner's to ask.
create policy "read overdue remarks" on public.invoice_remarks
  for select to authenticated using (public.can_read_view('overdueView'));

create policy "record a remark" on public.invoice_remarks
  for insert to authenticated with check (public.can_read_view('overdueView'));

create policy "revise a remark" on public.invoice_remarks
  for update to authenticated
  using (public.can_read_view('overdueView'))
  with check (public.can_read_view('overdueView'));

-- Clearing is a delete rather than a row holding an empty string, so an invoice with
-- nothing recorded against it reads as "nobody has said why" rather than "somebody said
-- nothing".
create policy "withdraw a remark" on public.invoice_remarks
  for delete to authenticated using (public.can_read_view('overdueView'));

create index invoice_remarks_recent on public.invoice_remarks (remarked_at desc);
