"""Emit one named, typed view per snapshot dump, from the slot registry.

A snapshot dump is replaced whole on every upload — that is what
`raw_batches_one_current_per_slot` enforces, and it is what the owner wants: no history
of yesterday's stock, just today's. A view over the current batch is exactly that, for
nothing: no second copy of the rows, no absorption step to run or to fail, no window in
which the table is half-emptied, and no way for any of it to move a published number.
Superseding the batch changes what the view returns, in the same statement that made the
upload current.

What a view cannot do is invent column names. The grid in `raw_rows` is positional —
`["3907863", "TUB-O-N…", 6.0]` — because that is what the parse stored and read-time
naming is what lets a corrected header row be a re-read rather than a re-send. So the
names have to be baked in when the view is written, and this is what bakes them: it reads
each slot through its own `ReadSpec`, takes the frame's column names and dtypes, and
writes the SQL that lifts the same positions back out under the same names.

    python3 tools/generate_dump_views.py --write    # rewrite the migration
    python3 tools/generate_dump_views.py            # print it instead
    python3 tools/generate_dump_views.py --check    # is a view missing for a slot?

`--check` asks two things, and the second one was learned the hard way.

The first is structural: every snapshot slot has a view and every view has a slot.

The second is positional, and it is the failure a generated view actually has. A column
added at the *end* of a sheet is harmless — the view simply does not expose it until
somebody regenerates, which is the ordinary event the whole JSONB design exists to
absorb. A column inserted in the *middle* is not harmless at all: every position after it
shifts by one, and the view goes on working perfectly while returning the wrong column
under each name. Nothing errors. Nothing is empty. `grade` just quietly holds what used
to be two columns further along.

That happened here, between one commit and the next: the `vsm stock` sheet gained a
`length key` column at position 9, and `dump_vsm_stock` began labelling ten columns
wrongly. So `--check` now re-reads each slot and compares the names at the positions the
migration baked in, and fails on a mismatch while staying quiet about additions past the
end.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = REPO_ROOT / ".claude" / "skills" / "refresh-tvsm-dashboard" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import sources  # noqa: E402


MIGRATION = REPO_ROOT / "supabase" / "migrations" / "20260814070000_a_view_per_snapshot_dump.sql"

# What the refresh reads a view back through. The views name their columns in snake case
# because an Excel header is not an identifier — `CUSTOMER  CD`, `Material\xa0No`,
# `Chamferring ` — and the pipeline addresses every column by the header the file wrote.
# Somebody has to hold the mapping between the two, and it cannot be derived at refresh
# time: the cloud run has no `dumps/` folder to read the headers off. So it is generated
# here, beside the SQL that made the names, and committed.
MANIFEST = REPO_ROOT / ".claude" / "skills" / "refresh-tvsm-dashboard" / "config" / "dump_columns.json"

# The whole migration is emitted from here, header included, so that the committed file
# is reproducible from the repository rather than from whatever was pasted in front of
# the generated part once.
HEADER = '''-- One named view per snapshot dump.
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
--
-- One thing to know before applying this against a database that already has these views:
-- **a view column cannot change type in place.** Replacing one refuses with `42P16` the
-- moment a column goes from numeric to text, which is exactly what retyping an identifier
-- column does — so that is a `drop` and a fresh definition, one view per statement. The
-- grants come back on their own from the schema's default privileges. Against a new
-- project the file below runs exactly as written.

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
    when jsonb_typeof(cell) = 'string' and cell #>> '{}' ~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$'
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
    when btrim(value) ~ '^[0-9]+\\.0+$'
      then coalesce(nullif(ltrim(split_part(btrim(value), '.', 1), '0'), ''), '0')
    else btrim(value)
  end;
$$;

-- The SQL twin of `sources.material_code`, and the same argument as `plant_code`.
--
-- SAP holds a material number zero-padded to eighteen characters and shows it unpadded,
-- and which reaches a dump is decided per extract: the transfer dump pads all 1,088 of
-- its lines and WIP all 693, stock and the bucketing master pad none, and the sales
-- ledger pads 6,539 of 22,419 because the daily dump and the quarterly archives disagree.
-- Joined raw, 0 of 1,088 transfer lines reached a bucket. Joined on this, 837 do.
create or replace function public.material_code(value text)
returns text language sql immutable as $$
  select case
    when value is null or btrim(value) = '' then null
    when btrim(value) ~ '^[0-9]+$'
      then coalesce(nullif(ltrim(btrim(value), '0'), ''), '0')
    when btrim(value) ~ '^[0-9]+\\.0+$'
      then coalesce(nullif(ltrim(split_part(btrim(value), '.', 1), '0'), ''), '0')
    else btrim(value)
  end;
$$;

grant execute on function public.material_code(text)      to authenticated;
grant execute on function public.dump_text(jsonb)         to authenticated;
grant execute on function public.dump_numeric(jsonb)      to authenticated;
grant execute on function public.dump_date(jsonb)         to authenticated;
grant execute on function public.dump_row_has_data(jsonb) to authenticated;
grant execute on function public.plant_code(text)         to authenticated;

-- ---- The views ---------------------------------------------------------------------

'''

# Postgres words that cannot be a bare column name. Not the whole reserved list — only
# what a spreadsheet header plausibly folds down to, which is how this came up: the RM
# tracker's `TVSM` sheet has a column called, exactly, `Column`. Quoting the identifier
# instead would work and would push a pair of double quotes onto every query anyone ever
# writes against these views, so the name gets a suffix and stays typeable.
RESERVED = {
    "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "authorization",
    "between", "both", "case", "cast", "check", "collate", "column", "constraint",
    "create", "cross", "current_date", "current_time", "current_timestamp",
    "current_user", "default", "deferrable", "desc", "distinct", "do", "else", "end",
    "except", "false", "for", "foreign", "from", "grant", "group", "having", "in",
    "initially", "inner", "intersect", "into", "is", "join", "leading", "left", "like",
    "limit", "localtime", "localtimestamp", "natural", "not", "null", "offset", "on",
    "only", "or", "order", "outer", "overlaps", "placing", "primary", "references",
    "returning", "right", "select", "session_user", "similar", "some", "table", "then",
    "to", "trailing", "true", "union", "unique", "user", "using", "variadic", "verbose",
    "when", "where", "window", "with",
}


def sql_name(column: object, taken: set[str]) -> str:
    """An Excel header as a column name somebody can type.

    These headers are not identifiers and were never meant to be: `CUSTOMER  CD` with two
    spaces, `Material\xa0No` with a non-breaking one, `Chamferring ` with a trailing
    space, `Tube Qty.(Mtr)`, `LENGTH FOR TATA TUBES MATERIAL (WITH 4 D` truncated
    mid-word. Quoting them in the view would push all of that onto whoever writes the
    query. So they are folded down to snake case here, and the header exactly as the file
    wrote it stays available in `raw_rows` for anyone who needs to check.
    """
    text = str(column).replace("\xa0", " ")
    text = re.sub(r"[^0-9a-zA-Z]+", "_", text).strip("_").lower()
    text = text or "column"
    if text[0].isdigit():
        # `31 to 90 days` is a real WIP column, and a bare digit cannot start an
        # identifier without quoting the whole thing.
        text = f"c_{text}"
    if text in RESERVED:
        text = f"{text}_col"
    candidate, n = text, 2
    while candidate in taken:
        # pandas has already made duplicate headers unique with `.1` suffixes, which
        # snake-case then flattens back together. Two columns that differ only there are
        # rare and are not worth losing.
        candidate, n = f"{text}_{n}", n + 1
    taken.add(candidate)
    return candidate


def cell_sql(position: int, kind: str) -> str:
    """One positional cell, lifted out as the type the read gives it."""
    cell = f"r.row -> {position}"
    return {
        "date": f"public.dump_date({cell})",
        "numeric": f"public.dump_numeric({cell})",
        "text": f"public.dump_text({cell})",
    }[kind]


# Columns that are identifiers whatever they look like, declared by name because the
# files cannot be trusted to declare them.
#
# This exists because of a defect that only shows up across two days' extracts, and shows
# up silently. A column is typed here from one file in `dumps/`, and `yf65.xlsx` there
# writes the accounting document number as a *number* — so the view was written
# `dump_numeric`, which is correct for that file and destroys the padding on the next one.
# The uploaded `yf65.XLSX` writes the very same column as zero-padded text, `0071029066`,
# and 2,008 of its 3,368 rows lost their leading zeros on the way through the view. It
# reached the page: the overdue drill-down showed `DP 36388067` where the invoice is
# `DP 0036388067`, in a document people paste into a mail.
#
# None of this is recoverable on the read side — the padding is gone in SQL — so the type
# has to be right in the DDL. An account number, a document number and a customer number
# are never added up, so nothing is lost by holding them as text and a great deal is lost
# by not. `tools/compare_table_sources.py --drift` is what finds the next one.
TEXT_COLUMNS = {
    "customer_code", "document_number", "gl_account", "recon_gl", "offset_account",
    # No padding on these two today, so nothing is being lost yet. They are here for the
    # same reason as the others — a credit control area and a business area are SAP
    # organisational codes, and the only thing standing between them and the defect above
    # is that this month's extract happens to write them without a leading zero.
    "credit_control_area", "business_area",
    # The order book and the sign-off sheets, found by `--drift` once it was written.
    # Every one of these is padded in the file uploaded today and was being unpadded by
    # the view: `000000000110102155` read as 110102155, `00001` as 1, `056` as 56. None of
    # them is read by the pipeline yet, which is why nothing on the page moved — but a
    # table that quietly mangles a material number is a table nobody can join to later.
    "ship_to_party", "mfgpl", "custno", "shipto", "item_no", "column1",
    "nrm_po", "cld_po", "finpo", "spec",
}


def kind_of(column: object, dtype, spec, name: str | None = None) -> str:
    """Which of the three shapes this column comes back as.

    A code stays text however numeric it looks. `Material` is an int64 out of pandas and
    joins to a text material code everywhere else; handed back as a number it would join
    to nothing, which is the same defect `whole_number_text` exists for on the sales key.
    So the slot's own key column, anything it pinned to `str` and anything named as an
    identifier are text by declaration, and only what is left is typed by dtype.
    """
    pinned = set((spec.dtype or {}).keys())
    if column == spec.key_column or column in pinned or name in TEXT_COLUMNS:
        return "text"
    name = str(dtype)
    if name.startswith("datetime"):
        return "date"
    if name.startswith(("int", "float", "uint")):
        return "numeric"
    return "text"


def column_plan(spec, frame) -> list[dict]:
    """One entry per column of the read, naming what the view calls it.

    Computed once and used twice, which is the point of it being its own function. The
    view needs it to write the SQL; the refresh needs it to read the view *back* as the
    frame the pipeline expects, because the pipeline addresses its columns by the file's
    own header — `CUSTOMER  CD` with two spaces, `Material\xa0No` with a non-breaking one,
    `Chamferring ` with a trailing space — and none of those survives `sql_name`.

    `column` is the view column that carries the value **as the file wrote it**, which for
    a material or plant column is the `_raw` one rather than the canonical. That is not a
    preference, it is the fidelity requirement: the pipeline does its own canonicalising
    downstream, and handing it an already-canonical code would change what it computes
    while every column name still looked right.
    """
    taken = {"source_batch", "uploaded_at", "original_filename", "sheet", "seq"}
    plan: list[dict] = []
    for position, column in enumerate(frame.columns):
        name = sql_name(column, taken)
        kind = kind_of(column, frame[column].dtype, spec, name)
        # The two columns worth having twice, and the canonical one takes the plain name
        # because it is the one a join should use. Every dump writes a plant differently —
        # `0788` and `789` in the same stock column, `788` in zmat, `788.0` on the transfer
        # dump — and all of those are one plant, so a join on what the file wrote matches a
        # subset and calls the rest absent. Material numbers are the same story: SAP pads to
        # eighteen characters or does not, per extract, and the transfer dump matched 0 of
        # 1,088 bucketing rows before this existed.
        canonicaliser = ("plant_code" if name == "plant"
                         else "material_code" if name in MATERIAL_COLUMNS else None)
        entry = {
            "header": str(column),
            "position": position,
            "column": name,
            "kind": kind,
            # What pandas made of it on the way in, so the read back can restore it. A
            # dtype is not recoverable from the values alone: an all-integer column reads
            # int64 when nothing is missing and float64 when something is.
            "dtype": str(frame[column].dtype),
        }
        if canonicaliser:
            # Left as the dtype suggests, a plant would come back a *number*, which joins
            # to the text plant on every other table not at all. So the raw column is
            # projected as text whatever the column really holds — and `kind` above stays
            # what the column really holds, because that difference is exactly what the
            # read back needs to know. Everywhere else, text in the view means the sheet
            # held text; here it means the view was made to say so.
            entry["sql_kind"] = "text"
            entry["column"] = f"{name}_raw"
            entry["canonical_column"] = name
            entry["canonicaliser"] = canonicaliser
            taken.add(entry["column"])
        plan.append(entry)
    return plan


def plan_sql(plan: list[dict]) -> list[str]:
    """The projected columns of a view, from its plan."""
    columns = []
    for entry in plan:
        position = entry["position"]
        if "canonicaliser" in entry:
            canonical = f"public.{entry['canonicaliser']}({cell_sql(position, 'text')})"
            columns.append(f"  {canonical:<34} as {entry['canonical_column']}")
            columns.append(f"  {cell_sql(position, 'text'):<34} as {entry['column']}")
        else:
            columns.append(
                f"  {cell_sql(position, entry.get('sql_kind', entry['kind'])):<34} "
                f"as {entry['column']}"
            )
    return columns


def view_sql(slot: str, spec, frame) -> str:
    """The `create view` for one slot."""
    view = view_name(slot)
    columns = plan_sql(column_plan(spec, frame))

    # The header rows, and only those: `header=1` means row 1 of the grid carries the
    # names, so the data starts at 2. A slot read with no header keeps every row.
    skip = "" if spec.header is None else f"\n    and r.seq > {spec.header}"
    # A row with nothing in it at all is padding, not data: `Bucketting` ends with 212 of
    # them, and counting them would make every count wrong by a number that means nothing.
    #
    # A named function rather than the predicate inlined thirteen times, and the reason is
    # the two bugs it already had. Spelled out per column it used `is null`, which is the
    # wrong test — an empty cell is a JSON null and `'[null]'::jsonb -> 0 is null` is
    # false, so it compiled, read correctly, and never fired. Rewritten as one expression
    # it came out negated, and kept only the blank rows. Both were one edit in thirteen
    # places; behind a function each would have been one edit in one.
    keep = "public.dump_row_has_data(r.row)"

    return (
        f"create or replace view public.{view} with (security_invoker = on) as\n"
        f"select\n"
        f"  b.id                               as source_batch,\n"
        f"  b.uploaded_at                      as uploaded_at,\n"
        f"  b.original_filename                as original_filename,\n"
        f"  b.sheet                            as sheet,\n"
        f"  r.seq                              as seq,\n"
        + ",\n".join(columns) + "\n"
        f"from public.raw_batches b\n"
        f"join public.raw_rows r on r.batch_id = b.id\n"
        f"where b.slot = '{slot}'\n"
        f"    and b.status = 'current'{skip}\n"
        f"    and {keep};\n"
    )


def every_slot():
    """Every declared read, the three multi-sheet families expanded.

    `orders`, `contract` and `signoff` list their sheets in the pipeline rather than in
    the registry, because the rest of the pipeline reads those specs for their business
    columns too. A generator that iterated only the registry would silently write no view
    for `orders:jsr`, which is the sort of gap this whole exercise is about closing.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "refresh_dashboard", SCRIPTS / "refresh_dashboard.py"
    )
    pipeline = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pipeline)

    slots = dict(sources.SLOTS)
    slots.update(sources.slots_for_families(
        pipeline.ORDER_BOOK_SHEETS, pipeline.PRICING_SHEETS, pipeline.SIGNOFF_SHEETS,
    ))
    return slots


def snapshot_slots() -> list[str]:
    """Every slot the registry says is exposed as a view, in a settled order."""
    return sorted(
        slot for slot in every_slot()
        if (spec := sources.table_for(slot)) and spec.mode == "snapshot"
    )


def accumulating_slots() -> list[str]:
    """Every slot whose rows are kept in a table that outlives the batch.

    The sales slots are excluded, and deliberately: all five pour into one ledger keyed on
    the invoice line, so no individual slot can be read back out of it — `sales_q1` and
    the daily dump are the same rows there, which is the point. `Sources.sales_ledger()`
    is how the ledger is read, and it already reads the table.
    """
    return sorted(
        slot for slot in every_slot()
        if slot not in sources.SALES_LEDGER_SLOTS
        and (spec := sources.table_for(slot)) and spec.mode == "accumulating"
    )


def storage_of(slot: str) -> str:
    """How a slot's rows sit in its table, which decides how they are read back.

    Three shapes, and the read differs for each. A snapshot slot is a `view` whose columns
    were named by `sql_name`. `transfers`, `bucketting` and `oem_key` keep the whole named
    line in a `row` JSONB, so their headers survive as written and only the *order* is
    lost — jsonb sorts its keys. `zmat` is the one stored as `typed` columns, because 24
    columns whose names are longer than their values cost 59 MB as named objects and 15
    as columns.
    """
    if slot == "zmat":
        return "typed"
    spec = sources.table_for(slot)
    return "view" if spec.mode == "snapshot" else "row_json"


def accumulating_manifest(src, slot: str) -> dict | None:
    """How to read one accumulating slot back as the frame the pipeline expects.

    No column *names* to record for the JSONB ones — the stored line keeps the file's own
    headers — but the order and the dtypes are lost all the same, and both are read. Order
    because jsonb sorts its keys, so a frame rebuilt from one comes out alphabetical-ish
    rather than in the sheet's order; dtypes because JSON has one number type and pandas
    has several.
    """
    try:
        frame = src.frame(slot)
    except (FileNotFoundError, sources.SheetMissing):
        return None
    storage = storage_of(slot)
    spec = src.spec(slot)
    if storage == "typed":
        # zmat alone, and its mapping is the constant the absorber writes through, so the
        # two cannot disagree about which column is which.
        stored = {column: name for name, column, _ in sources.ZMAT_COLUMNS}
        stored["Column1"] = "material_code"
        stored["PLANT"] = "plant_raw"
        columns = [
            {"header": str(column), "column": stored[str(column)],
             "dtype": str(frame[column].dtype)}
            for column in frame.columns if str(column) in stored
        ]
    else:
        columns = [
            {"header": str(column), "dtype": str(frame[column].dtype)}
            for column in frame.columns
        ]
    return {
        "table": sources.table_for(slot).table,
        "storage": storage,
        "columns": columns,
        # What the pipeline pinned to text on the way in has to stay text on the way back.
        "text_columns": sorted(str(c) for c in (spec.dtype or {})),
    }


def generate() -> tuple[str, list[str], list[str], dict]:
    """The DDL, the view names it wrote, the slots it could not read, and the manifest."""
    src = sources.ExcelSources(REPO_ROOT / "dumps", extra_slots=every_slot())
    body, written, missing = [], [], []
    manifest: dict[str, dict] = {}
    for slot in accumulating_slots():
        entry = accumulating_manifest(src, slot)
        if entry is None:
            missing.append(slot)
        else:
            manifest[slot] = entry
    for slot in snapshot_slots():
        spec = src.spec(slot)
        sheet = None
        if spec.sheet is sources.CALLER_NAMES_THE_SHEET:
            # The schedule's sheet is named for its month, and any month gives the same
            # column layout, which is all this needs. But "starts with Schedule" is not
            # the test: the master also carries `Schedule Pivot`, `Schedule for Printing`
            # and `Schedule Ampere`, and the first of those is a two-column pivot table.
            # Taken as the schedule it produced a two-column view of nothing. This is the
            # same rule `lib/dumps/recognise.ts` applies for the same reason.
            months = [s for s in src.sheet_names(slot) if is_month_sheet(s)]
            sheet = months[0] if months else None
            if sheet is None:
                missing.append(slot)
                continue
        try:
            frame = src.frame(slot, sheet=sheet) if sheet else src.frame(slot)
        except (FileNotFoundError, sources.SheetMissing):
            missing.append(slot)
            continue
        plan = column_plan(spec, frame)
        body.append(view_sql(slot, spec, frame))
        written.append(view_name(slot))
        manifest[slot] = {
            "table": view_name(slot),
            "storage": "view",
            "columns": plan,
            "text_columns": sorted(str(c) for c in (spec.dtype or {})),
        }
    return HEADER + "\n".join(body), written, missing, manifest


def view_name(slot: str) -> str:
    return "dump_" + re.sub(r"[^0-9a-z]+", "_", slot.lower()).strip("_")


def manifest_json(manifest: dict) -> str:
    """The manifest as the committed file, byte for byte.

    One function rather than a `json.dumps` at each call site, because `--check` compares
    the text: a difference in indent or key order would read as a stale manifest and fail
    a green tree. `ensure_ascii` is off so a non-breaking space in a header stays the
    character it is rather than becoming `\\u00a0` — these strings are read by people.
    """
    return json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


MONTHS = ("January February March April May June July August September October "
          "November December").split()

# Column names that hold an SAP material number. Every one of these is canonicalised and
# kept raw beside it, whatever the file did, so that a join across two dumps works without
# the person writing it having to know which of them pads.
MATERIAL_COLUMNS = {
    "material", "material_no", "material_number", "material_codes", "matl_no",
}


def is_month_sheet(name: str) -> bool:
    """`Schedule August`, and not `Schedule Pivot`."""
    return name.startswith("Schedule ") and name[len("Schedule "):] in MONTHS


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="fail if a snapshot slot has no view, or a view no slot")
    parser.add_argument("--write", action="store_true",
                        help="rewrite the migration file in place")
    args = parser.parse_args()

    ddl, wanted, missing, manifest = generate()
    for slot in missing:
        # An optional dump nobody has sent has no columns to name, so it gets no view.
        # Reported rather than silently skipped, and not a failure: `signoff.xlsx` is the
        # one input where a missing sheet is routine, and the schedule supplement is
        # retired outright.
        print(f"-- no file in dumps/ for slot {slot!r}; no view written", file=sys.stderr)

    if args.write:
        MIGRATION.write_text(ddl, encoding="utf-8")
        MANIFEST.write_text(manifest_json(manifest), encoding="utf-8")
        print(f"wrote {len(wanted)} views to {MIGRATION.name} "
              f"and {len(manifest)} slots to {MANIFEST.name}")
        return 0

    if not args.check:
        print(ddl)
        return 0

    if not MIGRATION.exists():
        print(f"{MIGRATION.name} is missing; run this without --check and commit it",
              file=sys.stderr)
        return 1

    # The manifest is what the refresh reads these views *back* through, so a stale one is
    # not a documentation problem: a column whose header has moved would be read under the
    # wrong name, or not found at all, hours later and mid-pipeline.
    if not MANIFEST.exists():
        print(f"{MANIFEST.name} is missing; run with --write and commit it",
              file=sys.stderr)
        return 1
    if MANIFEST.read_text(encoding="utf-8") != manifest_json(manifest):
        print(f"{MANIFEST.name} no longer matches the files in dumps/; run with --write",
              file=sys.stderr)
        return 1
    written = MIGRATION.read_text(encoding="utf-8")
    declared = set(re.findall(r"create or replace view public\.(dump_\w+)", written))
    if declared != set(wanted):
        print(f"missing a view: {sorted(set(wanted) - declared)}", file=sys.stderr)
        print(f"view for no slot: {sorted(declared - set(wanted))}", file=sys.stderr)
        return 1

    # Positional drift. Regenerating from today's files and diffing the *bodies* answers
    # it exactly: a column inserted mid-sheet changes every `r.row -> N` after it, and a
    # column added at the end changes nothing that is already written.
    stale = []
    for block_old, block_new in zip(written.split("create or replace view ")[1:],
                                    ddl.split("create or replace view ")[1:]):
        name = block_old.split()[0]
        if positions(block_old) != positions(block_new):
            stale.append(name)
    if stale:
        print(f"column positions have moved under: {sorted(stale)}", file=sys.stderr)
        print("a column inserted mid-sheet shifts every one after it, and the view goes "
              "on working while returning the wrong column under each name.", file=sys.stderr)
        print("run with --write, then re-apply those views.", file=sys.stderr)
        return 1

    print(f"{len(declared)} views, one per snapshot slot that has a file to read; "
          f"column positions unmoved")
    return 0


def positions(view_body: str) -> list[tuple[str, str]]:
    """The (column name, cell expression) pairs a view body projects, in order."""
    return re.findall(r"(r\.row -> \d+)\).*?as (\w+),?\n", view_body)


if __name__ == "__main__":
    raise SystemExit(main())
