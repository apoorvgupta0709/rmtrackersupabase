-- The three masters move onto the Missing mappings tab, and "All mappings" goes away.
--
-- Two tabs was the wrong shape and the owner said so: the masters are assignable in one
-- place, and that place is the tab you already have open when you are fixing a mapping.
-- A queue can only ever show what reached *no* mapping; a code mapped to the wrong bucket
-- is invisible to every queue there is, and the master beneath it is the only place that
-- can be found. Splitting them across two tabs meant the reader had to know which of the
-- two questions they were asking before they could pick a tab.
--
-- This is the additive half, and it is safe to apply before the code ships: it grants
-- `megh_length_bucketing` to `mappingView` as well as to `mappingsView`. Until the deploy
-- lands, `mappingView` simply does not ask for that section and the extra grant does
-- nothing; after it lands, the table has its rows. Withdrawing the old tab is a separate
-- migration that runs after the deploy, so there is no moment at which either tab is
-- pointing at something that is not there.
--
-- That ordering is the lesson from 17 August, when the `mappingsView` row was inserted
-- before its code shipped and production advertised a tab that 404ed. The rule that
-- follows from it is not "apply migrations after deploying" — it is that the additive
-- half goes first and the withdrawal last, whichever way round that puts them.

insert into public.section_views (section, view_key) values
  ('megh_length_bucketing', 'mappingView')
on conflict do nothing;
