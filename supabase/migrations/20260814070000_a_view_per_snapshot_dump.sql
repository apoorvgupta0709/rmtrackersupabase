-- One named view per snapshot dump.
--
-- Applied to production in several parts on 14 August 2026, names beginning
-- `a_view_per_snapshot_dump`. Nothing in this repository applies a migration — there is
-- no `supabase db push` in either workflow — so read the applied list with
-- `list_migrations` rather than this directory.
--
-- The dumps split cleanly in two, and this is the half that does not accumulate. Stock,
-- WIP, receivables, the RFD extract, the order book, the sign-offs, the schedule and both
-- RM tracker sheets are each a fresh statement of what is true now: uploading a new one
-- replaces the last, and the owner does not want yesterday's kept. `raw_batches` already
-- does exactly that — `raw_batches_one_current_per_slot` is what enforces it — so a view
-- over the current batch *is* the replace-on-upload table, and copying the rows into one
-- would only add a second statement of them to keep in step by hand.
--
-- What that buys beyond the storage: no absorption step to run or to fail, no window in
-- which the table is half-emptied, and no path by which any of this could move a
-- published number. Superseding the batch changes what these views return, in the same
-- statement that made the upload current.
--
-- What a view cannot do is invent column names. The grid in `raw_rows` is positional
-- because that is what the parse stored, and read-time naming is what lets a corrected
-- header row be a re-read rather than a re-send. So the names are baked in here, and
-- `tools/generate_dump_views.py` is what bakes them: it reads each slot through its own
-- `ReadSpec` and writes the SQL that lifts the same positions back under the same names.
-- This whole file is generated. Regenerate it, do not edit it.
--
-- `security_invoker = on` on every view is load-bearing. A view runs as its *owner* by
-- default, which would hand a raw receivables or sales row to any authenticated reader
-- and quietly undo the row-level security the base tables carry.

-- ---- Helpers -----------------------------------------------------------------------
--
-- A stored cell is not simply text. The parse writes JSON nulls for empty cells, numbers
-- as numbers, and a date as `{"__excel_date": "2026-07-11T00:00:00.000Z"}` — because
-- Excel stores a clock time as a fraction of a day on an 1899 epoch, and a bare
-- timestamp would read as a century out. These unwrap all of that.

create or replace function public.dump_text(cell jsonb)
returns text language sql immutable as $$
  select case
    when cell is null or jsonb_typeof(cell) = 'null' then null
    -- A date or a time comes back as the ISO string it was stored as, rather than as the
    -- wrapper object, which is what somebody reading the column actually meant.
    when jsonb_typeof(cell) = 'object'
      then coalesce(cell ->> '__excel_date', cell ->> '__excel_time')
    -- `#>> '{}'` is how a scalar comes out unquoted; `->>` needs a key or an index.
    else cell #>> '{}'
  end;
$$;

create or replace function public.dump_numeric(cell jsonb)
returns numeric language sql immutable as $$
  select case
    when cell is null or jsonb_typeof(cell) = 'null' then null
    when jsonb_typeof(cell) = 'number' then (cell #>> '{}')::numeric
    -- A number that arrived as text is still a number. Anything else is left null rather
    -- than raised: one stray word in one cell must not make the whole view unreadable.
    when jsonb_typeof(cell) = 'string' and cell #>> '{}' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
      then btrim(cell #>> '{}')::numeric
  end;
$$;

create or replace function public.dump_date(cell jsonb)
returns date language sql stable as $$
  select case
    when cell is null or jsonb_typeof(cell) <> 'object' then null
    when cell ? '__excel_date'
      -- Pinned to UTC. The stored string carries an explicit `Z`, and letting the
      -- session's own time zone resolve it would move a July date to 30 June for anyone
      -- reading from behind Greenwich.
      then (((cell ->> '__excel_date')::timestamptz) at time zone 'UTC')::date
  end;
$$;

-- Is there anything at all in this row?
--
-- `Bucketting` ends with 212 rows that are empty in the file too, and counting them would
-- make every count wrong by a number that means nothing. A function rather than the
-- predicate inlined in all thirteen views, because it has already been wrong twice: once
-- written with `is null`, which never fires — an empty cell is a JSON null, and
-- `'[null]'::jsonb -> 0 is null` is false — and once written negated, which kept only the
-- blank rows. Each was a one-character fix in thirteen places. Here it is one in one.
create or replace function public.dump_row_has_data(row_cells jsonb)
returns boolean language sql immutable as $$
  select exists (
    select 1 from jsonb_array_elements(row_cells) cell
     where jsonb_typeof(cell) <> 'null'
  );
$$;

-- The SQL twin of `sources.plant_code`, and it must stay a twin: the transfer ledger
-- canonicalises its plants in Python on the way in, and these views canonicalise theirs
-- in SQL on the way out, and a join between the two is the whole point of having either.
create or replace function public.plant_code(value text)
returns text language sql immutable as $$
  select case
    when value is null or btrim(value) = '' then null
    -- `0788`, `788` and `788.0` are one plant. Only a code written as digits is
    -- rewritten; one this does not recognise is not one it should touch.
    when btrim(value) ~ '^[0-9]+$'
      then coalesce(nullif(ltrim(btrim(value), '0'), ''), '0')
    when btrim(value) ~ '^[0-9]+\.0+$'
      then coalesce(nullif(ltrim(split_part(btrim(value), '.', 1), '0'), ''), '0')
    else btrim(value)
  end;
$$;

grant execute on function public.dump_text(jsonb)         to authenticated;
grant execute on function public.dump_numeric(jsonb)      to authenticated;
grant execute on function public.dump_date(jsonb)         to authenticated;
grant execute on function public.dump_row_has_data(jsonb) to authenticated;
grant execute on function public.plant_code(text)         to authenticated;

-- ---- The views ---------------------------------------------------------------------

create or replace view public.dump_orders_hk_so with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_text(r.row -> 0)       as cam,
  public.dump_text(r.row -> 1)       as remarks,
  public.dump_text(r.row -> 2)       as zone,
  public.dump_text(r.row -> 3)       as pt_plant,
  public.dump_text(r.row -> 4)       as segment,
  public.dump_text(r.row -> 5)       as catg,
  public.plant_code(public.dump_text(r.row -> 6)) as plant,
  public.dump_text(r.row -> 6)       as plant_raw,
  public.dump_date(r.row -> 7)       as order_date,
  public.dump_date(r.row -> 8)       as po_date,
  public.dump_text(r.row -> 9)       as sales_doc_type,
  public.dump_numeric(r.row -> 10)   as ageing_days,
  public.dump_text(r.row -> 11)      as creator,
  public.dump_numeric(r.row -> 12)   as sales_order_no,
  public.dump_numeric(r.row -> 13)   as sales_document_item,
  public.dump_text(r.row -> 14)      as po_no,
  public.dump_text(r.row -> 15)      as city_code_description,
  public.dump_text(r.row -> 16)      as sales_office,
  public.dump_text(r.row -> 17)      as zone2,
  public.dump_numeric(r.row -> 18)   as ship_to_party,
  public.dump_text(r.row -> 19)      as sold_cust_name,
  public.dump_text(r.row -> 20)      as material_number,
  public.dump_text(r.row -> 21)      as material_desc,
  public.dump_numeric(r.row -> 22)   as bal_for_prod_roll_mt
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'orders:hk_so'
    and b.status = 'current'
    and r.seq > 1
    and public.dump_row_has_data(r.row);

create or replace view public.dump_orders_hk_str with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_text(r.row -> 0)       as cam,
  public.dump_text(r.row -> 1)       as remarks,
  public.dump_text(r.row -> 2)       as zone,
  public.dump_text(r.row -> 3)       as pt_plant,
  public.dump_date(r.row -> 4)       as str_date,
  public.dump_text(r.row -> 5)       as mrk_cust_name,
  public.dump_text(r.row -> 6)       as catg2,
  public.dump_text(r.row -> 7)       as material_description,
  public.dump_numeric(r.row -> 8)    as actual_btp_mt,
  public.dump_numeric(r.row -> 9)    as despatch_quantity,
  public.dump_numeric(r.row -> 10)   as bal_to_desp_str_qty_despatch_qty
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'orders:hk_str'
    and b.status = 'current'
    and r.seq > 0
    and public.dump_row_has_data(r.row);

create or replace view public.dump_orders_jsr with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_text(r.row -> 0)       as typ,
  public.dump_text(r.row -> 1)       as auart,
  public.dump_text(r.row -> 2)       as mrpi,
  public.dump_numeric(r.row -> 3)    as mfgpl,
  public.dump_text(r.row -> 4)       as creator,
  public.dump_numeric(r.row -> 5)    as custno,
  public.dump_text(r.row -> 6)       as zone,
  public.dump_text(r.row -> 7)       as customer,
  public.dump_text(r.row -> 8)       as destination,
  public.dump_numeric(r.row -> 9)    as shipto,
  public.dump_numeric(r.row -> 10)   as age,
  public.dump_text(r.row -> 11)      as dlvblk,
  public.dump_text(r.row -> 12)      as blgblk,
  public.dump_numeric(r.row -> 13)   as order_no,
  public.dump_numeric(r.row -> 14)   as item_no,
  public.dump_text(r.row -> 15)      as matl_no,
  public.dump_text(r.row -> 16)      as description,
  public.dump_text(r.row -> 17)      as cam,
  public.dump_text(r.row -> 18)      as remarks,
  public.dump_numeric(r.row -> 19)   as bal_to_desp
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'orders:jsr'
    and b.status = 'current'
    and r.seq > 0
    and public.dump_row_has_data(r.row);

create or replace view public.dump_receivables with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_numeric(r.row -> 0)    as customer_code,
  public.dump_text(r.row -> 1)       as customer_name,
  public.dump_text(r.row -> 2)       as customer_pan,
  public.dump_text(r.row -> 3)       as nature,
  public.dump_numeric(r.row -> 4)    as document_number,
  public.dump_text(r.row -> 5)       as reference,
  public.dump_date(r.row -> 6)       as posting_date,
  public.dump_date(r.row -> 7)       as document_date,
  public.dump_text(r.row -> 8)       as doc_type,
  public.dump_text(r.row -> 9)       as sp_gl_ind,
  public.dump_numeric(r.row -> 10)   as doc_amount,
  public.dump_numeric(r.row -> 11)   as cleared_amount,
  public.dump_numeric(r.row -> 12)   as open_amount,
  public.dump_text(r.row -> 13)      as due_status,
  public.dump_date(r.row -> 14)      as net_due_date,
  public.dump_numeric(r.row -> 15)   as credit_control_area,
  public.dump_numeric(r.row -> 16)   as business_area,
  public.dump_text(r.row -> 17)      as sales_office_branch,
  public.dump_text(r.row -> 18)      as payment_term,
  public.dump_text(r.row -> 19)      as header_text,
  public.dump_text(r.row -> 20)      as billing_doc,
  public.dump_numeric(r.row -> 21)   as clearning_doc,
  public.dump_numeric(r.row -> 22)   as clearning_date,
  public.dump_numeric(r.row -> 23)   as gl_account,
  public.dump_numeric(r.row -> 24)   as recon_gl,
  public.dump_numeric(r.row -> 25)   as offset_account,
  public.dump_text(r.row -> 26)      as item_text,
  public.dump_text(r.row -> 27)      as profit_center
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'receivables'
    and b.status = 'current'
    and r.seq > 0
    and public.dump_row_has_data(r.row);

create or replace view public.dump_rfd with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_numeric(r.row -> 0)    as sl_no,
  public.dump_text(r.row -> 1)       as customer,
  public.dump_text(r.row -> 2)       as material_quality,
  public.dump_text(r.row -> 3)       as sm,
  public.dump_text(r.row -> 4)       as ctl_code,
  public.dump_text(r.row -> 5)       as aging_days,
  public.dump_text(r.row -> 6)       as section,
  public.dump_numeric(r.row -> 7)    as od,
  public.dump_text(r.row -> 8)       as thickness,
  public.dump_text(r.row -> 9)       as ctl,
  public.dump_numeric(r.row -> 10)   as rfd_qty,
  public.dump_numeric(r.row -> 11)   as weight,
  public.dump_text(r.row -> 12)      as remarks_dispatch,
  public.dump_numeric(r.row -> 13)   as unnamed_13,
  public.dump_numeric(r.row -> 14)   as unnamed_14,
  public.dump_numeric(r.row -> 15)   as unnamed_15,
  public.dump_numeric(r.row -> 16)   as unnamed_16,
  public.dump_numeric(r.row -> 17)   as unnamed_17,
  public.dump_numeric(r.row -> 18)   as unnamed_18,
  public.dump_numeric(r.row -> 19)   as unnamed_19,
  public.dump_numeric(r.row -> 20)   as unnamed_20
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'rfd'
    and b.status = 'current'
    and r.seq > 1
    and public.dump_row_has_data(r.row);

create or replace view public.dump_schedule with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_numeric(r.row -> 0)    as sno,
  public.dump_text(r.row -> 1)       as rm_loaction,
  public.dump_text(r.row -> 2)       as customer_name,
  public.dump_text(r.row -> 3)       as helper_customer,
  public.dump_text(r.row -> 4)       as customer_code,
  public.dump_text(r.row -> 5)       as material_no,
  public.dump_text(r.row -> 6)       as key,
  public.dump_text(r.row -> 7)       as material_des,
  public.dump_text(r.row -> 8)       as grade,
  public.dump_text(r.row -> 9)       as h,
  public.dump_text(r.row -> 10)      as fc_nfc,
  public.dump_text(r.row -> 11)      as hr_cr,
  public.dump_text(r.row -> 12)      as hr_cr_check,
  public.dump_text(r.row -> 13)      as chamferring,
  public.dump_text(r.row -> 14)      as angle_cut,
  public.dump_text(r.row -> 15)      as surface_critical,
  public.dump_text(r.row -> 16)      as bucket,
  public.dump_text(r.row -> 17)      as ctl_bucket,
  public.dump_numeric(r.row -> 18)   as check_if_ctl_bucket_is_in_sales_sheet_or_not,
  public.plant_code(public.dump_text(r.row -> 19)) as plant,
  public.dump_text(r.row -> 19)      as plant_raw,
  public.dump_text(r.row -> 20)      as c_4731_ll_stock,
  public.dump_numeric(r.row -> 21)   as c_4318_8406_stock,
  public.dump_text(r.row -> 22)      as application,
  public.dump_numeric(r.row -> 23)   as actual_od,
  public.dump_numeric(r.row -> 24)   as od,
  public.dump_numeric(r.row -> 25)   as id,
  public.dump_numeric(r.row -> 26)   as tickness,
  public.dump_numeric(r.row -> 27)   as length,
  public.dump_text(r.row -> 28)      as uom,
  public.dump_text(r.row -> 29)      as source_plant,
  public.dump_numeric(r.row -> 30)   as commitment_date,
  public.dump_numeric(r.row -> 31)   as schedule_in_nos,
  public.dump_text(r.row -> 32)      as customer_remarks,
  public.dump_numeric(r.row -> 33)   as dispatch,
  public.dump_numeric(r.row -> 34)   as bal_in_nos,
  public.dump_numeric(r.row -> 35)   as schedule_in_mt,
  public.dump_numeric(r.row -> 36)   as dispatch_mt,
  public.dump_numeric(r.row -> 37)   as balance_for_disp,
  public.dump_numeric(r.row -> 38)   as ctl_stock_in_nos,
  public.dump_numeric(r.row -> 39)   as ctl_stock,
  public.dump_numeric(r.row -> 40)   as total_long_stock_in_mt,
  public.dump_numeric(r.row -> 41)   as ll_stock,
  public.dump_numeric(r.row -> 42)   as wip,
  public.dump_text(r.row -> 43)      as balance_required_in_mt,
  public.dump_numeric(r.row -> 44)   as comp,
  public.dump_numeric(r.row -> 45)   as so
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'schedule'
    and b.status = 'current'
    and r.seq > 2
    and public.dump_row_has_data(r.row);

create or replace view public.dump_signoff_hosur with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_numeric(r.row -> 0)    as sales_order_no,
  public.dump_numeric(r.row -> 1)    as sales_document_item,
  public.dump_text(r.row -> 2)       as sold_cust_name,
  public.dump_text(r.row -> 3)       as material,
  public.dump_text(r.row -> 4)       as material_desc,
  public.dump_text(r.row -> 5)       as grade,
  public.dump_text(r.row -> 6)       as rm_grade,
  public.dump_numeric(r.row -> 7)    as order_qty_in_mt,
  public.dump_numeric(r.row -> 8)    as basic_price,
  public.dump_numeric(r.row -> 9)    as round_od,
  public.dump_numeric(r.row -> 10)   as od,
  public.dump_numeric(r.row -> 11)   as id,
  public.dump_numeric(r.row -> 12)   as thickness,
  public.dump_numeric(r.row -> 13)   as length,
  public.dump_numeric(r.row -> 14)   as column1,
  public.dump_text(r.row -> 15)      as column2,
  public.dump_numeric(r.row -> 16)   as order_qty_in_mt3,
  public.dump_numeric(r.row -> 17)   as wip,
  public.dump_numeric(r.row -> 18)   as fg,
  public.dump_numeric(r.row -> 19)   as btr,
  public.dump_numeric(r.row -> 20)   as sign_off,
  public.dump_text(r.row -> 21)      as mill,
  public.dump_numeric(r.row -> 22)   as order_qty_sales_unit
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'signoff:hosur'
    and b.status = 'current'
    and r.seq > 0
    and public.dump_row_has_data(r.row);

create or replace view public.dump_signoff_jsr with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_text(r.row -> 0)       as typ,
  public.dump_text(r.row -> 1)       as zone,
  public.dump_text(r.row -> 2)       as key,
  public.dump_text(r.row -> 3)       as sign_off,
  public.dump_numeric(r.row -> 4)    as sign_off_qty,
  public.dump_text(r.row -> 5)       as customer,
  public.dump_text(r.row -> 6)       as destination,
  public.dump_text(r.row -> 7)       as auart,
  public.dump_numeric(r.row -> 8)    as intpo,
  public.dump_text(r.row -> 9)       as cdrw,
  public.dump_numeric(r.row -> 10)   as bal_to_desp,
  public.dump_numeric(r.row -> 11)   as bal_desp_nos,
  public.dump_numeric(r.row -> 12)   as ordtons,
  public.dump_numeric(r.row -> 13)   as bal_to_roll,
  public.dump_numeric(r.row -> 14)   as fg_wip_available,
  public.dump_numeric(r.row -> 15)   as specifi,
  public.dump_numeric(r.row -> 16)   as fini_od,
  public.dump_numeric(r.row -> 17)   as fini_thick,
  public.dump_numeric(r.row -> 18)   as divn,
  public.dump_text(r.row -> 19)      as mstae,
  public.dump_text(r.row -> 20)      as sts,
  public.dump_text(r.row -> 21)      as bfrsts,
  public.dump_numeric(r.row -> 22)   as po_type,
  public.dump_text(r.row -> 23)      as mrpi,
  public.dump_numeric(r.row -> 24)   as mfgpl,
  public.dump_text(r.row -> 25)      as creator,
  public.dump_numeric(r.row -> 26)   as custno,
  public.dump_numeric(r.row -> 27)   as shipto,
  public.dump_numeric(r.row -> 28)   as dlvblk,
  public.dump_numeric(r.row -> 29)   as blgblk,
  public.dump_numeric(r.row -> 30)   as order_no,
  public.dump_numeric(r.row -> 31)   as item_no,
  public.dump_text(r.row -> 32)      as matl_no,
  public.dump_text(r.row -> 33)      as description,
  public.dump_numeric(r.row -> 34)   as nrm_po,
  public.dump_numeric(r.row -> 35)   as cld_po,
  public.dump_numeric(r.row -> 36)   as finpo,
  public.dump_numeric(r.row -> 37)   as plan_mill,
  public.dump_numeric(r.row -> 38)   as process_grp,
  public.dump_text(r.row -> 39)      as ctg,
  public.dump_numeric(r.row -> 40)   as spec,
  public.dump_text(r.row -> 41)      as sfin,
  public.dump_numeric(r.row -> 42)   as od,
  public.dump_numeric(r.row -> 43)   as thk,
  public.dump_text(r.row -> 44)      as class,
  public.dump_text(r.row -> 45)      as geometry,
  public.dump_numeric(r.row -> 46)   as in_dia,
  public.dump_numeric(r.row -> 47)   as ordq,
  public.dump_text(r.row -> 48)      as ordum,
  public.dump_numeric(r.row -> 49)   as ordnos,
  public.dump_numeric(r.row -> 50)   as millnos,
  public.dump_numeric(r.row -> 51)   as milltons,
  public.dump_numeric(r.row -> 52)   as nrmlnos,
  public.dump_numeric(r.row -> 53)   as nrmltons,
  public.dump_numeric(r.row -> 54)   as inspnos,
  public.dump_numeric(r.row -> 55)   as insptons,
  public.dump_numeric(r.row -> 56)   as trfrnos,
  public.dump_numeric(r.row -> 57)   as trfrtons,
  public.dump_numeric(r.row -> 58)   as bal_transfer,
  public.dump_numeric(r.row -> 59)   as bal_trnsf_tonnes,
  public.dump_numeric(r.row -> 60)   as despnos,
  public.dump_numeric(r.row -> 61)   as desptons,
  public.dump_numeric(r.row -> 62)   as stock,
  public.dump_numeric(r.row -> 63)   as wrksq,
  public.dump_numeric(r.row -> 64)   as wrksq_so,
  public.dump_numeric(r.row -> 65)   as brchq,
  public.dump_numeric(r.row -> 66)   as fg_sheet_stock,
  public.dump_numeric(r.row -> 67)   as stodonos,
  public.dump_numeric(r.row -> 68)   as stodotons,
  public.dump_numeric(r.row -> 69)   as cdespnos,
  public.dump_numeric(r.row -> 70)   as cdesptons,
  public.dump_numeric(r.row -> 71)   as balnos,
  public.dump_numeric(r.row -> 72)   as bal_d_o_tonns,
  public.dump_numeric(r.row -> 73)   as baltons,
  public.dump_numeric(r.row -> 74)   as frtind,
  public.dump_numeric(r.row -> 75)   as do_to_be_indented,
  public.dump_text(r.row -> 76)      as age_b,
  public.dump_text(r.row -> 77)      as f_ctg
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'signoff:jsr'
    and b.status = 'current'
    and r.seq > 0
    and public.dump_row_has_data(r.row);

create or replace view public.dump_signoff_khopoli with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_text(r.row -> 0)       as feasible,
  public.dump_numeric(r.row -> 1)    as month,
  public.dump_numeric(r.row -> 2)    as updated_on,
  public.dump_numeric(r.row -> 3)    as sl_no,
  public.dump_text(r.row -> 4)       as zone,
  public.dump_text(r.row -> 5)       as branch,
  public.dump_text(r.row -> 6)       as order_key,
  public.dump_text(r.row -> 7)       as desp_mode,
  public.dump_text(r.row -> 8)       as t_type,
  public.dump_text(r.row -> 9)       as segment,
  public.dump_text(r.row -> 10)      as receiving_plant_city,
  public.dump_text(r.row -> 11)      as mat_group,
  public.dump_numeric(r.row -> 12)   as order_age,
  public.dump_text(r.row -> 13)      as order_age_range,
  public.plant_code(public.dump_text(r.row -> 14)) as plant,
  public.dump_text(r.row -> 14)      as plant_raw,
  public.dump_numeric(r.row -> 15)   as order_date,
  public.dump_text(r.row -> 16)      as sales_doc_type,
  public.dump_numeric(r.row -> 17)   as sales_order_no,
  public.dump_numeric(r.row -> 18)   as sales_document_item,
  public.dump_text(r.row -> 19)      as po_no,
  public.dump_text(r.row -> 20)      as sales_office,
  public.dump_text(r.row -> 21)      as sold_cust_name,
  public.dump_text(r.row -> 22)      as oem,
  public.dump_text(r.row -> 23)      as material,
  public.dump_text(r.row -> 24)      as material_desc,
  public.dump_numeric(r.row -> 25)   as width_od,
  public.dump_numeric(r.row -> 26)   as id,
  public.dump_numeric(r.row -> 27)   as thickness,
  public.dump_numeric(r.row -> 28)   as length,
  public.dump_text(r.row -> 29)      as grade,
  public.dump_numeric(r.row -> 30)   as order_qty_in_mt,
  public.dump_numeric(r.row -> 31)   as finish_prod,
  public.dump_numeric(r.row -> 32)   as stock_mt,
  public.dump_numeric(r.row -> 33)   as bal_for_prod_roll_mt,
  public.dump_numeric(r.row -> 34)   as actual_btp,
  public.dump_numeric(r.row -> 35)   as despatch_mt,
  public.dump_numeric(r.row -> 36)   as pending_for_despatch_mt,
  public.dump_numeric(r.row -> 37)   as rolled_qty,
  public.dump_text(r.row -> 38)      as sales_unit,
  public.dump_text(r.row -> 39)      as end_finish,
  public.dump_text(r.row -> 40)      as geometry,
  public.dump_numeric(r.row -> 41)   as division,
  public.dump_text(r.row -> 42)      as mat_group2,
  public.dump_text(r.row -> 43)      as status_01,
  public.dump_text(r.row -> 44)      as status_02,
  public.dump_text(r.row -> 45)      as ref_standard,
  public.dump_numeric(r.row -> 46)   as wip_qty,
  public.dump_numeric(r.row -> 47)   as order_qty_sales_unit,
  public.dump_numeric(r.row -> 48)   as despatch_qty_sale_unit,
  public.dump_numeric(r.row -> 49)   as pending_for_despatch_sales_unit,
  public.dump_text(r.row -> 50)      as creator,
  public.dump_numeric(r.row -> 51)   as order_age3,
  public.dump_numeric(r.row -> 52)   as ageing_days,
  public.dump_text(r.row -> 53)      as ship_cust_city,
  public.dump_text(r.row -> 54)      as ship_cust_name,
  public.dump_text(r.row -> 55)      as incot,
  public.dump_numeric(r.row -> 56)   as aug_26_sales_plan,
  public.dump_numeric(r.row -> 57)   as cam_indicated,
  public.dump_numeric(r.row -> 58)   as mes_btp_01_08_26,
  public.dump_text(r.row -> 59)      as btp_range,
  public.dump_numeric(r.row -> 60)   as bal_to_desp_01_08_26,
  public.dump_numeric(r.row -> 61)   as stock_as_on_01_08_26,
  public.dump_text(r.row -> 62)      as size,
  public.dump_text(r.row -> 63)      as f_grade,
  public.dump_text(r.row -> 64)      as m_type,
  public.dump_text(r.row -> 65)      as p_code,
  public.dump_text(r.row -> 66)      as fin_type,
  public.dump_text(r.row -> 67)      as size_range,
  public.dump_numeric(r.row -> 68)   as round_od,
  public.dump_text(r.row -> 69)      as p_od,
  public.dump_numeric(r.row -> 70)   as p_thk,
  public.dump_numeric(r.row -> 71)   as hr_thk,
  public.dump_text(r.row -> 72)      as mill_no,
  public.dump_text(r.row -> 73)      as cew_pass,
  public.dump_text(r.row -> 74)      as cew_indication,
  public.dump_text(r.row -> 75)      as remarks,
  public.dump_text(r.row -> 76)      as top_100,
  public.dump_numeric(r.row -> 77)   as yield_lose,
  public.dump_numeric(r.row -> 78)   as wip_wrt_order,
  public.dump_numeric(r.row -> 79)   as wip_covered_wrt_order,
  public.dump_numeric(r.row -> 80)   as wip_uncovered,
  public.dump_numeric(r.row -> 81)   as yield_loss,
  public.dump_numeric(r.row -> 82)   as act_btr,
  public.dump_numeric(r.row -> 83)   as btr_with_yield,
  public.dump_numeric(r.row -> 84)   as bal_to_produce,
  public.dump_numeric(r.row -> 85)   as sign_off,
  public.dump_numeric(r.row -> 86)   as non_sign_off,
  public.dump_numeric(r.row -> 87)   as desp_plan,
  public.dump_text(r.row -> 88)      as prod_wk,
  public.dump_numeric(r.row -> 89)   as w1,
  public.dump_numeric(r.row -> 90)   as w2,
  public.dump_numeric(r.row -> 91)   as w3,
  public.dump_numeric(r.row -> 92)   as w4,
  public.dump_numeric(r.row -> 93)   as total_plan,
  public.dump_numeric(r.row -> 94)   as w1_sign_off2,
  public.dump_numeric(r.row -> 95)   as w2_sign_off2,
  public.dump_numeric(r.row -> 96)   as w3_sign_off2,
  public.dump_numeric(r.row -> 97)   as w4_sign_off2,
  public.dump_numeric(r.row -> 98)   as total_sign_off2
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'signoff:khopoli'
    and b.status = 'current'
    and r.seq > 0
    and public.dump_row_has_data(r.row);

create or replace view public.dump_stock with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_text(r.row -> 0)       as material,
  public.dump_text(r.row -> 1)       as material_description,
  public.dump_numeric(r.row -> 2)    as length,
  public.dump_text(r.row -> 3)       as ctl_ll,
  public.dump_text(r.row -> 4)       as batch,
  public.dump_numeric(r.row -> 5)    as nos,
  public.dump_numeric(r.row -> 6)    as kg,
  public.dump_numeric(r.row -> 7)    as mt,
  public.dump_text(r.row -> 8)       as base_unit_of_measure,
  public.dump_text(r.row -> 9)       as storage_location,
  public.plant_code(public.dump_text(r.row -> 10)) as plant,
  public.dump_text(r.row -> 10)      as plant_raw,
  public.dump_numeric(r.row -> 11)   as t_pkd_tube,
  public.dump_numeric(r.row -> 12)   as tube_qty_mtr,
  public.dump_text(r.row -> 13)      as special_stock_number,
  public.dump_numeric(r.row -> 14)   as item_sd,
  public.dump_text(r.row -> 15)      as customer_name,
  public.dump_numeric(r.row -> 16)   as ageing_days,
  public.dump_text(r.row -> 17)      as age_wise
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'stock'
    and b.status = 'current'
    and r.seq > 1
    and public.dump_row_has_data(r.row);

create or replace view public.dump_vsm_stock with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_numeric(r.row -> 0)    as s_no,
  public.dump_text(r.row -> 1)       as section,
  public.dump_numeric(r.row -> 2)    as column1,
  public.dump_numeric(r.row -> 3)    as o_d,
  public.dump_numeric(r.row -> 4)    as id,
  public.dump_numeric(r.row -> 5)    as thk,
  public.dump_numeric(r.row -> 6)    as length,
  public.dump_text(r.row -> 7)       as wt_len,
  public.dump_text(r.row -> 8)       as key,
  public.dump_text(r.row -> 9)       as grade,
  public.dump_text(r.row -> 10)      as fc_nfc,
  public.dump_text(r.row -> 11)      as hr_cr,
  public.dump_numeric(r.row -> 12)   as nos,
  public.dump_text(r.row -> 13)      as c_056,
  public.dump_numeric(r.row -> 14)   as c_0789,
  public.dump_numeric(r.row -> 15)   as c_0788,
  public.dump_numeric(r.row -> 16)   as schedule,
  public.dump_numeric(r.row -> 17)   as stock,
  public.dump_numeric(r.row -> 18)   as in_transit,
  public.dump_numeric(r.row -> 19)   as column2,
  public.dump_numeric(r.row -> 20)   as coverage,
  public.dump_numeric(r.row -> 21)   as c_056_order,
  public.dump_numeric(r.row -> 22)   as c_0789_order,
  public.dump_numeric(r.row -> 23)   as c_0788_order,
  public.dump_numeric(r.row -> 24)   as c_789_order,
  public.dump_numeric(r.row -> 25)   as order_qty_to_be_logged,
  public.dump_numeric(r.row -> 26)   as coverage_post_order,
  public.dump_text(r.row -> 27)      as remark,
  public.dump_text(r.row -> 28)      as unnamed_28
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'vsm_stock'
    and b.status = 'current'
    and r.seq > 2
    and public.dump_row_has_data(r.row);

create or replace view public.dump_vsm_tvsm with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.dump_text(r.row -> 0)       as s_no,
  public.dump_text(r.row -> 1)       as section,
  public.dump_text(r.row -> 2)       as column1,
  public.dump_text(r.row -> 3)       as o_d,
  public.dump_text(r.row -> 4)       as thk,
  public.dump_text(r.row -> 5)       as wt_len,
  public.dump_text(r.row -> 6)       as key,
  public.dump_text(r.row -> 7)       as grade,
  public.dump_text(r.row -> 8)       as fc_nfc,
  public.dump_text(r.row -> 9)       as vsm_requirement,
  public.dump_numeric(r.row -> 10)   as vsm_sales,
  public.dump_numeric(r.row -> 11)   as vsm_stock,
  public.dump_text(r.row -> 12)      as rucha,
  public.dump_text(r.row -> 13)      as metalman,
  public.dump_text(r.row -> 14)      as marathwada,
  public.dump_text(r.row -> 15)      as rajsriya_tvs,
  public.dump_text(r.row -> 16)      as supangita,
  public.dump_text(r.row -> 17)      as pams_eng,
  public.dump_text(r.row -> 18)      as column_col,
  public.dump_text(r.row -> 19)      as c_2,
  public.dump_text(r.row -> 20)      as unnamed_20
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'vsm_tvsm'
    and b.status = 'current'
    and r.seq > 2
    and public.dump_row_has_data(r.row);

create or replace view public.dump_wip with (security_invoker = on) as
select
  b.id                               as source_batch,
  b.uploaded_at                      as uploaded_at,
  b.original_filename                as original_filename,
  b.sheet                            as sheet,
  r.seq                              as seq,
  public.plant_code(public.dump_text(r.row -> 0)) as plant,
  public.dump_text(r.row -> 0)       as plant_raw,
  public.dump_text(r.row -> 1)       as staorage_location,
  public.dump_date(r.row -> 2)       as creation_date,
  public.dump_text(r.row -> 3)       as material_no,
  public.dump_text(r.row -> 4)       as batch,
  public.dump_text(r.row -> 5)       as material_description,
  public.dump_numeric(r.row -> 6)    as total_stock,
  public.dump_numeric(r.row -> 7)    as upto_30_days,
  public.dump_numeric(r.row -> 8)    as c_31_to_90_days,
  public.dump_numeric(r.row -> 9)    as c_91_to_180_days,
  public.dump_text(r.row -> 10)      as material_group,
  public.dump_numeric(r.row -> 11)   as stock_in_transit
from public.raw_batches b
join public.raw_rows r on r.batch_id = b.id
where b.slot = 'wip'
    and b.status = 'current'
    and r.seq > 0
    and public.dump_row_has_data(r.row);
