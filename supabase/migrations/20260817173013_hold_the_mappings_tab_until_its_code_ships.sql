-- The tab row must not land before the code that renders it.
--
-- `dashboard_views` is what builds the tab strip, and an admin sees every row in it —
-- `layout.tsx` filters on grants, and an admin passes them all. A key the deployed bundle
-- has no spec for reaches `notFound()` in `[view]/page.tsx`, so inserting the row first
-- advertises a tab that 404s for exactly as long as the deploy takes.
--
-- This withdraws a row that was inserted a minute earlier, before that was noticed. The
-- scope constraint from the previous migration stays: it is inert without a tab to use it.
--
-- **To finish the feature**, once `mappingsView` exists in `app/dashboard/[view]/views.ts`
-- on `main` and both deployments are green:
--
--   insert into public.dashboard_views (key, label, sort_order)
--     values ('mappingsView', 'All mappings', 5)
--     on conflict (key) do update set label = excluded.label, sort_order = excluded.sort_order;
--   update public.dashboard_views set sort_order = sort_order + 1
--    where sort_order >= 5 and key <> 'mappingsView';
--   insert into public.section_views (section, view_key)
--     values ('megh_length_bucketing', 'mappingsView')
--     on conflict (section, view_key) do nothing;
--
-- The section grant matters: a section absent from `section_views` is readable by nobody
-- but an admin, so without that last row the length-key table renders empty for everyone
-- else — and an empty table is indistinguishable from a master with nothing in it.

delete from public.section_views where view_key = 'mappingsView';

delete from public.dashboard_views where key = 'mappingsView';

update public.dashboard_views set sort_order = sort_order - 1 where sort_order >= 6;
