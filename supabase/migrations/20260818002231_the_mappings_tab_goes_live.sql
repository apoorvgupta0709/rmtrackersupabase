-- The tab row, now that the code that renders it is deployed on both hosts.
--
-- Held back two migrations ago on purpose: `dashboard_views` builds the tab strip,
-- `layout.tsx` shows an admin every row in it, and a key the deployed bundle has no spec
-- for reaches `notFound()` in `[view]/page.tsx`. Inserting the row before the deploy
-- advertises a tab that 404s for as long as the deploy takes, which is what happened for
-- about a minute before it was withdrawn.
--
-- With `mappingsView` live in `app/dashboard/[view]/views.ts` on `main` and both
-- deployments green on that commit, the row is safe.

insert into public.dashboard_views (key, label, sort_order) values
  ('mappingsView', 'All mappings', 5)
on conflict (key) do update set label = excluded.label, sort_order = excluded.sort_order;

-- Sorted next to the queue it complements: the two tabs answer the same question from
-- opposite sides, and a reader moving between them should not have to cross the strip.
update public.dashboard_views set sort_order = sort_order + 1
 where sort_order >= 5 and key <> 'mappingsView';

-- Without this the length-key table renders empty for everyone but an admin, and an empty
-- table is indistinguishable from a master with nothing in it. Bucketting and the OEM key
-- need no equivalent: they are read live and already carry their own read policies.
insert into public.section_views (section, view_key) values
  ('megh_length_bucketing', 'mappingsView')
on conflict (section, view_key) do nothing;
