-- Megh Steel's own quarterly working, and the Megh code nobody had told the dashboard
-- about.
--
-- Two small changes with one cause: Megh converts for four OEMs, not three.
--
-- `MEGHRECO` is Megh's price-difference working, a drill-down for the same reason the
-- ancillaries' is — a quarter is thousands of billing lines and a tab fetches a section
-- whole. It is granted to the Megh tab, which is where the rest of Megh lives. That
-- grant is deliberately narrow: the working carries what Tata charged Megh per kilogram,
-- which is Megh's buying price and is not the ancillaries' business.
insert into public.detail_prefix_views (prefix, view_key) values ('MEGHRECO', 'meghView')
  on conflict do nothing;

-- Nothing else here: `943213` is a pipeline constant rather than a row, because it is a
-- fact about how the business is arranged and not something anyone should be able to
-- change without the pipeline's tests running. It is recorded in
-- `config/pipeline.json` beside the other three and asserted equal to the code.
