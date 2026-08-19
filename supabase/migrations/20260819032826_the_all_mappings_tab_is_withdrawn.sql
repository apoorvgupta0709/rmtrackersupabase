-- "All mappings" goes away, now that its three tables are on Missing mappings.
--
-- The withdrawal half, and it runs only after the deploy that folded the masters into
-- `mappingView` is live on both hosts — Vercel and the container on the VPS. Reversing
-- that order would take the tab out of the nav while the tables it held were still only
-- on it, which is the same defect as 17 August with the sign the other way round: then
-- the row arrived before its code and production advertised a tab that 404ed.
--
-- The section grant is deleted first for the ordinary reason: a grant naming a view that
-- no longer exists is a row nothing will ever read again, and a reader would have to
-- work out which of the two facts was the stale one. `megh_length_bucketing` keeps its
-- grant to `mappingView`, made in the migration before this one.
--
-- Closing the gap in `sort_order` is not cosmetic tidying. The 17 August migration
-- shifted every tab from 5 down by one to make room for this one; leaving the hole would
-- leave the numbering carrying a fact about a tab that no longer exists, and the next
-- person to insert a tab reading a gap where none is intended.

delete from public.section_views where view_key = 'mappingsView';
delete from public.dashboard_views where key = 'mappingsView';

update public.dashboard_views set sort_order = sort_order - 1 where sort_order > 5;
