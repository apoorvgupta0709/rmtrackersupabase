-- Which tab each section and each drill-down prefix belongs to.
--
-- This is where "mes may see the Megh tab and nothing else" actually becomes true. Under
-- access.json it was a hidden button over a payload that held everything; here an
-- ungranted section returns no rows. A section absent from this table is readable by
-- nobody but an admin, which is the right way round: a new section ships invisible until
-- somebody says who it is for.

insert into public.section_views (section, view_key) values
  ('customer_lines',            'customerView'),
  ('customer_summary',          'customerView'),

  ('megh_tracker',              'meghView'),
  ('megh_bop_added',            'meghView'),
  ('megh_length_bucketing',     'meghView'),

  ('ll_tracker',                'llView'),

  -- The mapping queues are one tab, fed by seven separate sources.
  ('missing_mappings',          'mappingView'),
  ('megh_unmapped',             'mappingView'),
  ('stock_unmapped',            'mappingView'),
  ('rfd_unmapped',              'mappingView'),
  ('wip_unmapped',              'mappingView'),
  ('orders_unmapped',           'mappingView'),
  ('signoff_unmapped',          'mappingView'),

  ('sales_summary',             'salesView'),

  ('trend_buckets',             'trendView'),
  ('trend_customer_skus',       'trendView'),
  ('trend_customer_sku_history','trendView'),
  ('trend_plants',              'trendView'),
  ('trend_months',              'trendView'),

  ('sku_pricing',               'pricingView'),
  ('sku_pricing_unpriced',      'pricingView'),
  ('code_repository',           'pricingView'),

  ('stock_analysis_ctl',        'stockView'),
  ('stock_analysis_ll',         'stockView'),
  ('stock_source_coverage',     'stockView'),

  ('str_plan',                  'strView'),
  ('transfers',                 'transferView'),
  ('overdue_analysis',          'overdueView'),

  -- The order book and sign-off feed columns on two trackers, so either grant reads them.
  ('orders',                    'llView'),
  ('orders',                    'meghView'),
  ('signoff',                   'llView'),
  ('signoff',                   'meghView');

insert into public.detail_prefix_views (prefix, view_key) values
  -- Stock breakups open from the customer tracker's CTL and LL cells as well as from
  -- the stock tab, so both grants reach them.
  ('STOCKCTL', 'customerView'), ('STOCKCTL', 'stockView'),
  ('STOCKLL',  'customerView'), ('STOCKLL',  'stockView'), ('STOCKLL', 'llView'),
  ('SRCGAP',   'stockView'),
  ('CTL',      'customerView'), ('LL',       'customerView'),
  ('SCHEDULE', 'customerView'), ('BALANCE',  'customerView'),
  ('SKUHISTORY', 'customerView'), ('SKUHISTORY', 'trendView'),

  ('LLALL', 'llView'), ('LLSCHEDULE', 'llView'), ('LLSALES', 'llView'),
  ('LLCOVERAGE', 'llView'), ('LLGAP', 'llView'), ('LLGAP45', 'llView'),
  ('LLHISTORY', 'llView'), ('SIGNOFF', 'llView'),
  ('ORDERS', 'llView'), ('ORDERS', 'meghView'),

  ('MEGHSTOCK', 'meghView'), ('MEGHSCHEDULE', 'meghView'), ('MEGHSALES', 'meghView'),
  ('MEGHORDERS', 'meghView'), ('MEGHATLENGTH', 'meghView'),
  ('MEGHOTHERLENGTH', 'meghView'), ('MEGHSIGNOFF', 'meghView'),
  ('MEGHORDERPLAN', 'meghView'),

  ('TRENDBUCKET', 'trendView'), ('TRENDMONTH', 'trendView'),
  ('SALES', 'salesView'),
  -- The price build-up is the contract price broken down. It is the single most
  -- commercially sensitive thing on the dashboard and the reason mes is refused pricing.
  ('PRICEBUILD', 'pricingView'),
  ('STRDEST', 'strView'), ('STRSOURCE', 'strView'),
  ('TRANSFER', 'transferView'),
  ('OVERDUE', 'overdueView'), ('OFFSET', 'overdueView');
