-- The customer tracker carries the selected customer's sales history, so a grant on that
-- tab has to reach the section it is built from.
--
-- `trend_customer_sku_history` was mapped to the trend tab alone, which is where it is
-- read whole. On the customer tab it is read one customer at a time, beside that
-- customer's schedule lines — the question a buying meeting asks after "what is due this
-- month": is that normal, and what has quietly stopped being ordered. Without this row a
-- reader granted only the customer tab sees an empty history and no reason for it, which
-- is the failure mode this table exists to prevent: an ungranted section returns no rows,
-- and a page cannot tell that apart from a customer that has never bought anything.
--
-- It grants nothing new to anyone: the rows are the same rows, and a reader with neither
-- tab still reaches none of them.

insert into public.section_views (section, view_key) values
  ('trend_customer_sku_history', 'customerView')
on conflict (section, view_key) do nothing;
