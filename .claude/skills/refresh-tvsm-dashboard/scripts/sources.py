"""Where the pipeline's input frames come from.

`refresh_dashboard.py` used to read its inputs with twenty-one `pd.read_excel` calls
scattered through `main()`, each carrying its own sheet name, header row, `usecols`
window and dtype override. That was fine while `dumps/` was the only source. It stops
being fine the moment the same frames have to come out of Postgres instead, because
those twenty-one specs would then exist twice and drift apart — and a drifted spec here
does not raise, it silently changes a number on the page.

So the specs move into one registry, `SLOTS`, and the pipeline asks a `Sources` object
for a frame by slot name. `ExcelSources` reads `dumps/` exactly as before; a future
`PostgresSources` will serve the same slots from the tables the web uploader writes.
Nothing downstream of the read changes, because both return the same DataFrames.

The registry is deliberately declarative. Adding an input is a row here, not a call site
somewhere in five thousand lines.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import time
from dataclasses import dataclass, replace
from pathlib import Path

import pandas as pd


# The schedule workbook fills a month-neutral slot. `july0626_rm_tracker_v1.xlsx` is the
# name it used to have and is still accepted, because a workbook already archived under
# that name must keep loading.
MODEL_FILES = ("rm_tracker_model.xlsx", "july0626_rm_tracker_v1.xlsx")

# The sheet a slot reads is usually fixed. The schedule's is not: it is named for the
# month being published and resolved against the workbook at run time, so its spec says
# "the caller will name it" rather than naming one that would go stale every month.
CALLER_NAMES_THE_SHEET = object()


class SheetMissing(LookupError):
    """The file is present but does not carry the sheet asked for.

    Separate from a missing file because the two mean different things: a missing
    optional file is a dump that was not sent, while a missing sheet in a file that did
    arrive is a workbook that changed shape. `signoff.xlsx` is the one input where a
    missing sheet is routine — its three plants do not all report every week.
    """


class SupabaseRowCountMismatch(RuntimeError):
    """A stored dump came back with fewer rows than it was written with.

    Worth its own error because the failure it guards against is silent. PostgREST caps
    a response at 1,000 rows and says nothing about it, so a sheet reads short, the
    pipeline computes over the part that arrived, and the only symptom is a number that
    looks plausible. Every batch records the row count it was written with; a read that
    does not match it stops the refresh rather than publishing a partial one.
    """


@dataclass(frozen=True)
class ReadSpec:
    """One `pd.read_excel` call, stated rather than performed."""

    files: tuple[str, ...]
    sheet: object = 0
    header: int | None = 0
    usecols: str | None = None
    dtype: dict | None = None
    optional: bool = False
    # The column that says what a row is about — the material code, the size key, the
    # invoice. Shown first in the uploader's preview, because it is the one a reader
    # checks to know the right file arrived.
    key_column: str | None = None
    # The columns the pipeline reads off this sheet, exactly as the file writes them —
    # double spaces, trailing spaces, non-breaking spaces and all.
    #
    # This exists for the uploader, not for the read: a workbook whose headers have moved
    # is accepted today and fails hours later, mid-pipeline, as a `KeyError` naming one
    # column. Declared here, the browser can say which columns it found and which it did
    # not before anything is stored. It is deliberately **not** exhaustive — a column not
    # listed is simply not checked, which weakens the check without breaking an upload —
    # and a test asserts every name listed really is in the corresponding file in `dumps/`,
    # so a typo here cannot turn into a good file being refused.
    required: tuple[str, ...] = ()


# What every sales extract has to carry. The three quantity columns are all needed and
# all easy to confuse: `qty in no` is pieces, `Domain for z_qty_meter` is metres, and
# `Quantity` is kilograms whatever the sales unit says.
SALES_COLUMNS = (
    "CUSTOMER  CD", "CUSTOMER  NAME", "MATERAIL NUMBER", "Material   Description",
    "Length for TATA Tubes Material", "MATERIAL GROUP", "BILLING  DATE",
    "qty in no", "Quantity", "Domain for z_qty_meter",
    "RATE/UNIT", "SALES  UNIT", "Billing  Document Number", "Billing Item",
    "DESP P LANT", "SHIP TO PARTY C", "SHIPTO PARTY DISC",
)


# The invoice line's identity, and the slots that carry one.
#
# Sales is the one input that accumulates rather than being superseded: a billed line is
# a fact with a date on it, and the daily dump holds only the current month. So every
# sales extract — the daily dump and every archive — pours into one ledger keyed on the
# line, and `Sources.sales_ledger()` is what the pipeline reads instead of the slots
# individually.
#
# Order is precedence, first occurrence winning: the daily dump is the freshest statement
# of a line, then the archives newest first. It mirrors the month-precedence rule this
# replaces, but resolves at line level rather than by whole month.
BILLING_DOCUMENT_COLUMN = "Billing  Document Number"
BILLING_ITEM_COLUMN = "Billing Item"
SALES_LEDGER_SLOTS = ("sales", "sales_jul", "sales_q1", "sales_q4", "sales_history")


def whole_number_text(value) -> str | None:
    """An identifier that arrived as a number, back as the text it is.

    `Billing  Document Number` and `Billing Item` are integers in SAP and floats out of
    pandas, so an invoice reaches a customer's reconciliation as `4731002954.0` and
    matches nothing. A value that is not a whole number is left as written.

    It lives here rather than in the pipeline because it is now part of the read: it is
    what makes the ledger's key stable across extracts. Whether a sales file reads as
    float or int is decided by something as incidental as whether it carries a grand
    total row — the daily dumps do and the quarterly archives do not — so the same
    invoice would key two ways and be stored twice.
    """
    if pd.isna(value):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    return str(value).strip() or None


def plant_code(value) -> str | None:
    """A plant code as one canonical string, whatever shape it arrived in.

    The dumps disagree with each other and with themselves. `stock` writes `0788` on one
    row and `789` on the next; `zmat` writes `788` and `789`; the sales extract writes
    `056` and `0788`; the transfer dump writes them as floats, `788.0`. Every one of
    those is the same plant, and any join made on the raw value matches a subset and
    reports the rest as absent — which on a stock-transfer plan reads as "this code is
    not extended at 8406" rather than as a formatting difference.

    Canonical is the digits without leading zeros. The as-sent value is stored beside it
    wherever this is used, because which padding a file chose is evidence about the file.
    """
    text = whole_number_text(value)
    if text is None:
        return None
    text = text.strip()
    if not text:
        return None
    # Only a plant written as digits is renormalised. Anything else is left exactly as
    # it came: a code this function does not recognise is not a code it should rewrite.
    return (text.lstrip("0") or "0") if text.isdigit() else text


def material_code(value) -> str | None:
    """A material code as one canonical string, whatever shape it arrived in.

    SAP holds a material number zero-padded to eighteen characters and shows it unpadded,
    and which of the two reaches a dump is decided per extract. Measured on what is
    stored: the transfer dump is padded on all 1,088 lines and WIP on all 693, stock and
    the bucketing master on none — and the sales ledger on 6,539 of 22,419, because the
    daily dump and the quarterly archives disagree with each other.

    So the same material is `000000000003501105` in one table and `3501105` in the next,
    and a join between them matches nothing at all: 0 of 1,088 transfer lines reached a
    bucket before this existed, and 837 after. Like `plant_code`, the value as sent is
    kept beside the canonical one wherever this is used.
    """
    text = whole_number_text(value)
    if text is None:
        return None
    text = text.strip()
    if not text:
        return None
    # Only a code written as digits is renormalised, and a code that is all zeros keeps
    # one. Anything else is left exactly as it came.
    return (text.lstrip("0") or "0") if text.isdigit() else text


def sales_line_keys(frame: pd.DataFrame) -> pd.DataFrame:
    """A sales frame with its line key attached, and the sheet's own total row dropped.

    Every daily dump ends with a grand total: no customer, no date, no material and no
    billing document, but `Quantity` holding the sum of the column — 968,438 kg against a
    month's real 786 lines on the 7 August file. Deduplicating on a blank key would keep
    one of them; the key has to be *required*, so the row is dropped for having none.
    """
    if frame.empty:
        return frame.assign(billing_document=None, billing_item=None)
    keyed = frame.assign(
        billing_document=[whole_number_text(v) for v in frame[BILLING_DOCUMENT_COLUMN]],
        billing_item=[whole_number_text(v) for v in frame[BILLING_ITEM_COLUMN]],
    )
    return keyed[keyed["billing_document"].notna() & keyed["billing_item"].notna()]


def _storable(value):
    """One cell, as something `json.dumps` will take and pandas will give back.

    A date has to survive as text a later `pd.to_datetime` reads identically, and NaN has
    to become null rather than a bare `NaN` no JSON parser accepts — the same rule the
    payload writer applies on the way out of the pipeline.
    """
    if value is None:
        return None
    if isinstance(value, (pd.Timestamp, )):
        return None if pd.isna(value) else value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    if isinstance(value, (str, bool)):
        return value
    # numpy scalars answer to .item(); this is also what turns np.int64 into int.
    if hasattr(value, "item") and not isinstance(value, (list, tuple, dict)):
        try:
            value = value.item()
        except (ValueError, AttributeError):
            return str(value)
    if isinstance(value, float) and (pd.isna(value) or value != value):
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, (int, float, str, bool)):
        return value
    return str(value)


def sales_ledger_records(frame: pd.DataFrame, batch_id=None) -> list[dict]:
    """A keyed sales frame as ledger rows.

    The whole named line goes into `row`; the six fields beside it are lifted out because
    they are what every reader slices on, and a JSONB expression index on each would cost
    more than the columns do.
    """
    if frame.empty:
        return []
    columns = [c for c in frame.columns if c not in ("billing_document", "billing_item")]
    records = []
    for line in frame.to_dict("records"):
        billing_date = pd.to_datetime(line.get("BILLING  DATE"), errors="coerce")
        records.append({
            "billing_document": line["billing_document"],
            "billing_item": line["billing_item"],
            "row": {c: _storable(line.get(c)) for c in columns},
            "billing_date": None if pd.isna(billing_date) else billing_date.date().isoformat(),
            "billing_month": None if pd.isna(billing_date) else billing_date.strftime("%Y-%m"),
            "despatch_plant": plant_code(line.get("DESP P LANT")),
            "despatch_plant_raw": _storable(line.get("DESP P LANT")),
            # Canonical, with the file's own spelling beside it. The daily dump and the
            # quarterly archives disagree about zero-padding, so 6,539 of the 22,419 lines
            # held key one way and the rest the other — and neither joins to stock.
            "material_number": material_code(line.get("MATERAIL NUMBER")),
            "material_number_raw": _storable(line.get("MATERAIL NUMBER")),
            "customer_code": _storable(line.get("CUSTOMER  CD")),
            "source_batch": batch_id,
        })
    return records


def bucketing_keys(frame: pd.DataFrame) -> pd.DataFrame:
    """A `Bucketting` frame keyed on the material code, padding dropped.

    **Not on `Bucket`**, which is what the slot's `key_column` names and what a reader
    would reach for first. `Bucket` is the size family a code belongs to and is shared:
    167 distinct buckets over 1,538 rows, `12.7-0-1.6-ERW 1-PE` alone covering 27 codes.
    Keyed on it, the master would collapse to 167 rows and quietly lose nine tenths of
    the mapping. `Material Codes` is unique across all 1,538, measured.

    The sheet is read through a column window and ends with 212 rows that are empty in the
    file too. They carry no code, so they go the way every other keyless row goes.
    """
    if frame.empty:
        return frame.assign(material_code=None)
    keyed = frame.assign(
        # Read as float64 — `2426342.0` — because the column has blanks in it. Stored raw
        # it joins to the material code on the sales, stock and zmat side not at all.
        material_code=[whole_number_text(v) for v in frame["Material Codes"]],
    )
    return keyed[keyed["material_code"].notna()]


def oem_key_keys(frame: pd.DataFrame) -> pd.DataFrame:
    """An `OEM_key_1_rev codes` frame keyed on the customer, as the sheet spells it.

    `Customer ` really does end in a space; that is the header, and the read is by name.
    Unique across all 174 rows as written. Deliberately *not* normalised for case or
    whitespace on the way in: two of the 174 collide once upper-cased, and the OEM key is
    the one place the exact spelling is the point — `Rane` and `RANE` would otherwise
    become one OEM in some summaries and two in others.
    """
    if frame.empty:
        return frame.assign(customer=None)
    keyed = frame.assign(
        customer=[None if pd.isna(v) else str(v) for v in frame["Customer "]],
    )
    return keyed[keyed["customer"].notna()]


def _master_records(frame, batch_id, key_columns, lift):
    """A keyed master frame as table rows: the named row, plus the columns readers slice on."""
    if frame.empty:
        return []
    columns = [c for c in frame.columns if c not in key_columns]
    records = []
    for line in frame.to_dict("records"):
        record = {column: line[column] for column in key_columns}
        record["row"] = {c: _storable(line.get(c)) for c in columns}
        record.update({name: get(line) for name, get in lift.items()})
        record["source_batch"] = batch_id
        records.append(record)
    return records


def bucketing_records(frame: pd.DataFrame, batch_id=None) -> list[dict]:
    """A keyed bucketing frame as rows of `dump_bucketing`."""
    return _master_records(frame, batch_id, ("material_code",), {
        "bucket": lambda line: _storable(line.get("Bucket")),
        "ctl_bucket": lambda line: _storable(line.get("CTL Bucket")),
        "ll_or_ctl": lambda line: _storable(line.get("LL or CTL")),
        "grade": lambda line: _storable(line.get("Grade")),
        "fc_pe": lambda line: _storable(line.get("FC/PE")),
        "annealed": lambda line: _storable(line.get("Annealed")),
        "od": lambda line: _storable(line.get("OD")),
        "inner_diameter": lambda line: _storable(line.get("ID")),
        "thickness": lambda line: _storable(line.get("Thickness")),
        "length": lambda line: _storable(line.get("Length")),
    })


def oem_key_records(frame: pd.DataFrame, batch_id=None) -> list[dict]:
    """A keyed OEM frame as rows of `dump_oem_key`."""
    return _master_records(frame, batch_id, ("customer",), {
        "oem": lambda line: _storable(line.get("OEM")),
        "cam": lambda line: _storable(line.get("CAM")),
    })


def zmat_keys(frame: pd.DataFrame) -> pd.DataFrame:
    """A zmat frame keyed on material code and plant, deduplicated in frame order.

    zmat is a material × plant extract — the same code appears once per plant it is
    extended at, otherwise identical — and the plant is the point: the stock-transfer plan
    for 8406 asks whether a code is extended at both the sending and the receiving plant,
    which is a question only this pair can answer. `Column1` alone is 57,478 distinct
    values over 65,178 rows and would throw the answer away.

    The pair is not unique either, and no combination of these 24 columns is: 480 rows are
    byte-identical repeats of another row, and `(Column1, PLANT)` still leaves 1,104 over
    — pairs differing only in noise, `PE`/`AW` swapped between end finish and surface
    finish, a specification written `10` on one row and `010` on the next.

    So the duplicates are dropped **here, deterministically, in frame order**, rather than
    left to `resolution=ignore-duplicates`. PostgREST resolves a conflict against whatever
    happens to be in the same 2,000-row chunk, so which of two near-identical rows
    survived would depend on where the chunk boundary fell — stable within a run, and
    liable to change the moment the file gains a row above them.
    """
    if frame.empty:
        return frame.assign(material_code=None, plant=None)
    keyed = frame.assign(
        material_code=[material_code(v) for v in frame["Column1"]],
        plant=[plant_code(v) for v in frame["PLANT"]],
        plant_raw=[_storable(v) for v in frame["PLANT"]],
    )
    keyed = keyed[keyed["material_code"].notna() & keyed["plant"].notna()]
    return keyed.drop_duplicates(subset=["material_code", "plant"], keep="first")


# One zmat column, as the table spells it and how it is to be read. Typed columns rather
# than a `row` JSONB, and this is the one place that trade is worth making: 65,178 rows of
# 24 columns whose *names* are longer than most of their values — stored as named objects
# they cost about 59 MB against 15, on a database with 105 MB of headroom. It is safe here
# and would not be for the sales dump, because SAP's material master does not gain a
# column every few weeks; if it ever does, that is a migration rather than a silent loss.
ZMAT_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("material_description", "MATERIAL DESCRIPTION", "text"),
    ("material_type", "MATERIAL TYPE", "text"),
    ("material_group", "MATERIAL GROUP", "text"),
    ("old_material_number", "OLD MATERIAL NUMBER", "text"),
    ("base_unit_of_measure", "BASE UNIT OF MEASURE", "text"),
    ("division", "DIVISION", "text"),
    ("material_grade", "MATERIAL GRADE", "text"),
    ("outer_diameter", "OUTER DIAMETER OF MATERIAL", "numeric"),
    ("inner_diameter", "INNER DIAMETER OF MATERIAL", "numeric"),
    ("thickness", "THICKNESS FOR TATA TUBES MATERIAL", "numeric"),
    # The header really is cut off mid-word in the file — `(WITH 4 D` — and the read is
    # by name, so it is spelled here exactly as the sheet spells it.
    ("length", "LENGTH FOR TATA TUBES MATERIAL (WITH 4 D", "numeric"),
    ("weight_per_metre", "WEIGHT/METRE OF MATERIAL", "numeric"),
    ("weight_per_metre_2", "WEIGHT/METRE OF MATERIAL2", "numeric"),
    ("weight_per_number", "WEIGHT/NUMBER OF MATERIAL", "numeric"),
    ("weight_per_number_2", "WEIGHT/NUMBER OF MATERIAL2", "numeric"),
    ("item_type", "ITEM TYPE (FOR MATERIALS)", "text"),
    ("material_draw_type", "MATERIAL DRAW TYPE", "text"),
    ("material_category", "MATERIAL CATEGORY", "text"),
    ("material_specification", "MATERIAL SPECIFICATION", "text"),
    ("material_end_finish", "MATERIAL END FINISH", "text"),
    ("material_surface_finish", "MATERIAL SURFACE FINISH", "text"),
    ("material_geometry", "MATERIAL GEOMETRY", "text"),
)


def zmat_records(frame: pd.DataFrame, batch_id=None) -> list[dict]:
    """A keyed zmat frame as rows of `dump_zmat`."""
    if frame.empty:
        return []
    records = []
    for line in frame.to_dict("records"):
        record = {
            "material_code": line["material_code"],
            "plant": line["plant"],
            "plant_raw": line.get("plant_raw"),
            "source_batch": batch_id,
        }
        for name, column, kind in ZMAT_COLUMNS:
            value = _storable(line.get(column))
            if kind == "text" and value is not None and not isinstance(value, str):
                # `DIVISION` is an int64 out of pandas and a code in SAP. Left a number it
                # would read `10` where the file says `010`, which is the same trap the
                # material codes were in.
                value = whole_number_text(value)
            elif kind == "numeric":
                value = _numeric_or_none(value)
            record[name] = value
        records.append(record)
    return records


def _numeric_or_none(value):
    """A numeric cell, or nothing where the sheet did not write a number.

    A typed column is the whole reason `dump_zmat` fits in the storage there is, and the
    price of one is that a single bad cell fails the insert for the 2,000 rows it travels
    with. `OUTER DIAMETER OF MATERIAL` is `o` on exactly one row of the 65,178 held — a
    typo for zero — and it stopped the whole absorption with `invalid input syntax for
    type numeric: "o"`.

    Coerced to null rather than widening the column to text, because a diameter you cannot
    filter on numerically is worth less than one missing value. Nothing is lost by it: the
    batch this came from is still in `raw_rows` exactly as uploaded, which is what that
    table is for.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return None if value != value else value        # NaN is not equal to itself
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


# What makes a line on the transfer dump a transfer. The pipeline holds the same constant
# for its own filtering; this one is the read's, applied before anything is stored.
TRANSFER_INVOICE_MARKER = "TRANSFER"


class DumpRefused(ValueError):
    """A stored batch that is not the dump its slot says it is.

    Distinct from a batch that is merely empty or short. Absorption skips one of these
    and carries on with the rest — one file sent to the wrong slot must not stop the
    others, and must certainly not stop the sales ledger the pipeline is about to read —
    so it has to be catchable as a class without also catching a genuine fault.
    """


class NotATransferExtract(DumpRefused):
    """A batch filed as `transfers` that holds no transfer line.

    The daily mail has more than once carried a copy of the sales dump under the transfer
    filename — the 27 July set arrived byte-identical to `sales.xlsx`, 3,990 rows and 234
    columns both. Under the old snapshot model the next upload cleared it. In a table
    that accumulates, those lines would be a permanent, unremovable population of sales
    invoices sitting in the transfer ledger, so the file has to be refused before a row
    of it is written rather than noted afterwards.

    The test is exact rather than a proportion, and can only fire on the real fault: a
    genuine extract is `Tax Inv Transfer` and `D.Challan Transfer` throughout — 844 of
    845 rows on the file held, the one exception being the sheet's own grand total — and
    a sales extract carries `Tax Inv Sale IGST`/`SGST` and matches nothing at all.
    """


def transfer_line_keys(frame: pd.DataFrame) -> pd.DataFrame:
    """A transfer frame with its line key attached, and everything that is not a transfer gone.

    The key is the invoice line, the same one sales uses and under the same column names
    — verified unique across all 844 lines of the file held, zero duplicate pairs. The
    grand-total row goes the way sales' does: `sales_line_keys` requires the key, and the
    total row carries none.
    """
    if frame.empty:
        return frame.assign(billing_document=None, billing_item=None)

    if "Invoice Type" not in frame.columns:
        raise NotATransferExtract(
            "the transfer dump has no `Invoice Type` column, so nothing in it can be "
            "shown to be a transfer. Nothing was stored."
        )
    invoice_type = frame["Invoice Type"].astype(str).str.upper()
    transfers = frame[invoice_type.str.contains(TRANSFER_INVOICE_MARKER, na=False)]
    if transfers.empty:
        raise NotATransferExtract(
            f"none of this dump's {len(frame)} rows carries a transfer invoice type, so "
            f"it is not a transfer extract — most likely the sales dump sent under the "
            f"transfer filename, which has happened before. Nothing was stored."
        )
    return sales_line_keys(transfers)


def transfer_ledger_records(frame: pd.DataFrame, batch_id=None) -> list[dict]:
    """A keyed transfer frame as ledger rows.

    Lifts what a transfer is asked about, which is not quite what a sale is asked about.
    `DESP P LANT` is the sending plant and `CUSTOMER  CD` the receiving one — on this
    dump the "customer" is a plant, 4731 and 8406 — so both go through `plant_code` and
    both keep the value as sent beside it. `GR DATE` is lifted because its *absence* is
    the in-transit flag: a line is in transit until the receiving plant posts a goods
    receipt, and 207 of 844 lines on the file held have none.
    """
    if frame.empty:
        return []
    columns = [c for c in frame.columns if c not in ("billing_document", "billing_item")]
    records = []
    for line in frame.to_dict("records"):
        billed = pd.to_datetime(line.get("BILLING  DATE"), errors="coerce")
        received = pd.to_datetime(line.get("GR DATE"), errors="coerce")
        records.append({
            "billing_document": line["billing_document"],
            "billing_item": line["billing_item"],
            "row": {c: _storable(line.get(c)) for c in columns},
            "billing_date": None if pd.isna(billed) else billed.date().isoformat(),
            "billing_month": None if pd.isna(billed) else billed.strftime("%Y-%m"),
            "gr_date": None if pd.isna(received) else received.date().isoformat(),
            "invoice_type": _storable(line.get("Invoice Type")),
            "source_plant": plant_code(line.get("DESP P LANT")),
            "source_plant_raw": _storable(line.get("DESP P LANT")),
            "receiving_plant": plant_code(line.get("CUSTOMER  CD")),
            "receiving_plant_raw": _storable(line.get("CUSTOMER  CD")),
            # This dump pads every material code to eighteen characters and the bucketing
            # master pads none, so before this was canonicalised **none** of the 1,088
            # transfer lines reached a bucket. 837 do.
            "material_number": material_code(line.get("MATERAIL NUMBER")),
            "material_number_raw": _storable(line.get("MATERAIL NUMBER")),
            "source_batch": batch_id,
        })
    return records


def sales_ledger_order(frame: pd.DataFrame) -> pd.DataFrame:
    """The ledger in one settled order: oldest invoice first.

    It has to be settled somewhere, and this is the only place both backends pass
    through. Several published fields are taken from whichever line of a group comes
    first — `trend_customer_skus` reads its length, bucket and segment off `group.iloc[0]`
    — so frame order decides them. Left alone, a file-backed run would order by which
    extracts happen to sit in `dumps/` and a Postgres run by the primary key, and the two
    would quietly disagree about the length shown against a long-length SKU.

    Chronological is the order to settle on, because it makes that representative mean
    something: the earliest line billed against the group, rather than the first one
    somebody happened to upload.
    """
    if frame.empty:
        return frame
    order = frame.assign(
        _billed=pd.to_datetime(frame["BILLING  DATE"], errors="coerce")
    ).sort_values(
        ["_billed", "billing_document", "billing_item"],
        kind="stable",
        na_position="last",
    )
    return order.drop(columns="_billed").reset_index(drop=True)


def _sales_ledger_dtypes(frame: pd.DataFrame) -> pd.DataFrame:
    """The two dtypes the JSONB round trip must not be allowed to lose.

    `MATERAIL NUMBER` is pinned to text on every sales read for a reason the data contract
    spells out — inferred as a float, pandas drops the last digit of a code stored as text,
    3907863 reading as 3907860 on 3,603 of 3,989 rows. It is stored as text and must come
    back as text. The billing date went out as ISO and comes back parsed, so that
    `billing_month` is derived from a date here exactly as it is from an Excel serial there.
    """
    if "MATERAIL NUMBER" in frame.columns:
        frame["MATERAIL NUMBER"] = frame["MATERAIL NUMBER"].astype("object")
    if "BILLING  DATE" in frame.columns:
        frame["BILLING  DATE"] = pd.to_datetime(frame["BILLING  DATE"], errors="coerce")
    return frame


def _sales_like(filename: str, *, optional: bool = False) -> ReadSpec:
    """A sales extract: `Sheet1` only, material number as text.

    Both rules are load-bearing. The other sheets in a quarterly extract are working
    copies of `Sheet1`, so reading them double-counts the quarter. And pandas infers a
    float dtype for material codes stored as text and drops their last digit — 3907863
    read as 3907860 on 3,603 of 3,989 rows — which is why `MATERAIL NUMBER` is pinned to
    `str` on every sales file rather than only on the daily dump.
    """
    return ReadSpec((filename,), "Sheet1", 0,
                    dtype={"MATERAIL NUMBER": str}, optional=optional,
                    key_column="MATERAIL NUMBER", required=SALES_COLUMNS)


SLOTS: dict[str, ReadSpec] = {
    # The governing mapping workbook. Three sheets, three different shapes.
    "bucketting": ReadSpec(
        MODEL_FILES, "Bucketting", 1, usecols="U:AF",
        key_column="Bucket",
        required=("Bucket", "CTL Bucket", "Material Codes", "Annealed"),
    ),
    "oem_key": ReadSpec(
        MODEL_FILES, "OEM_key_1_rev codes", 0, usecols="A:C",
        key_column="Customer ", required=("Customer ", "OEM"),
    ),
    "schedule": ReadSpec(
        MODEL_FILES, CALLER_NAMES_THE_SHEET, 2,
        key_column="Bucket",
        required=(
            "Bucket", "CTL Bucket", "MATERIAL NO", "MATERIAL DES", "Helper Customer",
            "CUSTOMER CODE", "CUSTOMER NAME", "ACTUAL OD", "TICKNESS", "LENGTH",
            "UoM", "SCHEDULE IN MT", "SCHEDULE in nos",
            # The three value-add flags the pricing tab reads. `Chamferring ` really does
            # end in a space, and dropping it silently prices every SKU without it.
            "FC/NFC", "Chamferring ", "Angle Cut",
        ),
    ),
    "schedule_supplement": ReadSpec(("schedule_supplement.xlsx",), optional=True),

    "sales": _sales_like("sales.xlsx"),
    # An optional longer sales window for the code repository. The daily dump is the
    # current month only, too short to see every code a customer has been billed under.
    "sales_history": ReadSpec(("sales_history.xlsx",), 0, 0,
                              dtype={"MATERAIL NUMBER": str}, optional=True,
                              key_column="MATERAIL NUMBER", required=SALES_COLUMNS),
    # Archived sales driving the past-sales trend. Each closed month is archived this
    # way; the trend takes each month from exactly one source, daily dump winning.
    "sales_q4": _sales_like("sales_q4.xlsx", optional=True),
    "sales_q1": _sales_like("sales_q1.xlsx", optional=True),
    "sales_jul": _sales_like("sales_jul.xlsx", optional=True),

    # `TRANSIT STOCK` is never read off this file — the transit figure comes from the
    # transfer dump, and reading both counts it twice.
    "stock": ReadSpec(
        ("stock.xlsx",), "PLANT STOCKS", 1,
        key_column="Material",
        required=(
            "Plant", "Material", "Material Description", "CUSTOMER NAME",
            "CTL/LL", "LENGTH", "Ageing days", "KG", "MT", "NOS",
        ),
    ),
    # The header carries a non-breaking space in `Material No`; the caller replaces it
    # after the read, so the dtype key must carry it too or the pin misses.
    # Two of this sheet's headers carry a non-breaking space, and both are load-bearing:
    # the caller replaces them after the read, so a dtype pin or a check written with an
    # ordinary space simply misses.
    "wip": ReadSpec(("wip.xlsx",), 0, 0, dtype={"Material\xa0No": str},
                    key_column="Material\xa0No",
                    required=("Material\xa0No", "Material Description",
                              "Total\xa0Stock")),
    "rfd": ReadSpec(("rfd_4731.xlsx", "rfd.xlsx"), "Sheet5", 1,
                    key_column="CTL Code",
                    required=("CTL Code", "CTL ", "RFD Qty.", "WEIGHT")),
    "zmat": ReadSpec(("zmat.xlsx",), "Sheet1", 0,
                     key_column="Column1",
                     required=("Column1", "MATERIAL DESCRIPTION", "MATERIAL TYPE")),

    "vsm_tvsm": ReadSpec(("rm_tracker_tvsm.xlsx",), "TVSM", 2,
                         key_column="key",
                         required=("key", "VSM Requirement", "VSM Sales", "VSM Stock")),
    # `length key` is the plan's own statement of the length-specific key Megh SKUs join
    # on. It is required rather than optional: the pipeline used to derive that key from
    # the row's dimensions and cut type, and where the plan and Bucketting disagreed on
    # end condition the derived key missed and the tonnage fell out of the tab entirely.
    # A tracker without the column should stop the run, not quietly resurrect the guess.
    "vsm_stock": ReadSpec(
        ("rm_tracker_tvsm.xlsx",), "vsm stock", 2,
        key_column="key",
        required=("key", "length key", "O D", "Thk.", "Length", "Grade", "FC/NFC",
                  "Schedule", "Stock"),
    ),

    "receivables": ReadSpec(
        ("yf65.xlsx",), "Sheet1", 0, optional=True,
        key_column="Billing Doc",
        required=("Billing Doc", "Customer Code", "Customer Name", "Doc Type",
                  "Document Date", "Nature", "Open Amount"),
    ),
    # The caller collapses runs of whitespace in these headers before reading them, so
    # the names here are the file's own — `CUSTOMER  CD` with two spaces, not one.
    "transfers": ReadSpec(("transfer.xlsx",), 0, 0,
                          dtype={"MATERAIL NUMBER": str}, optional=True,
                          key_column="MATERAIL NUMBER",
                          required=("MATERAIL NUMBER", "Material   Description",
                                    "DESP P LANT", "CUSTOMER  CD", "Invoice Type",
                                    "GR DATE", "Quantity", "qty in no")),
}

# Files whose sheets are enumerated by a spec dict in the pipeline rather than listed
# one by one here. Each becomes `family:sheet` slots when the Sources object is built,
# so `orders:jsr` and `signoff:hosur` are addressed exactly like any other slot.
SHEET_FAMILIES = {
    "orders": "orders.xlsx",
    "contract": "contract.xlsx",
    "signoff": "signoff.xlsx",
}


def slots_for_families(order_book_sheets, pricing_sheets, signoff_sheets):
    """Expand the three multi-sheet inputs into one slot per sheet.

    The specs live in `refresh_dashboard.py` because the rest of the pipeline reads them
    for their business columns, not just their sheet names. Passing them in keeps that
    single definition and avoids importing the pipeline from its own source layer.
    """
    slots: dict[str, ReadSpec] = {}

    for sheet, spec in order_book_sheets.items():
        # Every candidate code column is read as text, for the same reason sales is.
        # Naming a column the sheet does not have is harmless, which is what lets a
        # spec list alternatives.
        candidates = spec["code_column"]
        candidates = (candidates,) if isinstance(candidates, str) else (candidates or ())
        # Only the columns the sheet is read *through* are required. The code column is
        # deliberately left out: it is a list of alternatives and the pipeline already
        # resolves whichever of them is present, with a recorded fault where none is.
        required = tuple(
            column for column in (
                spec.get("quantity_column"), spec.get("remarks_column"),
            ) if column
        )
        slots[f"orders:{sheet}"] = ReadSpec(
            ("orders.xlsx",), sheet, spec["header"],
            dtype={column: str for column in candidates} or None, optional=True,
            # Only where the sheet names one column and not a list of alternatives: the
            # list exists because the three planning sheets disagree about the name, and
            # naming the first of them would name one this sheet does not have.
            key_column=candidates[0] if len(candidates) == 1 else None,
            required=required,
        )

    for route, spec in pricing_sheets.items():
        # Contract sheets are read positionally — the quarters are column offsets — so
        # they are read with no header at all, and there is nothing to check by name.
        slots[f"contract:{route}"] = ReadSpec(
            ("contract.xlsx",), spec["sheet"], None, optional=True,
        )

    for sheet, spec in signoff_sheets.items():
        required = tuple(
            column for column in (
                spec.get("code"), spec.get("quantity"),
                spec.get("flag"), spec.get("signed"), spec.get("unsigned"),
            ) if column
        )
        slots[f"signoff:{sheet}"] = ReadSpec(
            ("signoff.xlsx",), sheet, 0, optional=True,
            key_column=spec.get("code"), required=required,
        )

    return slots


@dataclass(frozen=True)
class TableSpec:
    """Where a slot's rows are kept once they have been read.

    Deliberately separate from `ReadSpec`, and not a set of extra fields on it, for two
    reasons. They answer different questions and change for different reasons — a
    corrected header row is a re-read, a new stored column is a migration. And
    `tools/generate_adapters.py` projects every `ReadSpec` field into `adapters.ts` for
    the browser, which absorbs nothing and must never learn a table name: the uploader
    writing a dump table directly is exactly the audit-trail bypass `raw_batches` exists
    to prevent.
    """

    table: str
    # "accumulating" — the table outlives the batch and is keyed on the row's own
    # identity, so a re-sent day adds nothing and a backfill adds only what was missing.
    # "snapshot" — the current batch is the whole truth and each upload replaces it.
    mode: str
    # Accumulating only: the table columns forming the natural key, in the order the
    # PostgREST `on_conflict` target must name them.
    key: tuple[str, ...] = ()
    # Accumulating only: frame -> frame with the key columns attached and any row that
    # cannot carry one dropped. `sales_line_keys` is the shape.
    key_from: Callable[[pd.DataFrame], pd.DataFrame] | None = None
    # frame, batch_id -> the rows to write.
    records: Callable[[pd.DataFrame, str], list[dict]] | None = None
    # "keep" leaves a row the table already holds exactly as it was; "replace" lets the
    # newer file win. The choice is per master and is a business rule, not a detail:
    # keep-first means a correction never lands, replace means a deletion never does.
    on_conflict: str = "keep"


# Every sales extract pours into one ledger keyed on the invoice line, so all five slots
# share a spec. See `SALES_LEDGER_SLOTS` for why, and the ledger migration for the
# evidence that the key really is unique across all four extracts held.
_SALES_TABLE = TableSpec(
    table="tsl_sales",
    mode="accumulating",
    key=("billing_document", "billing_item"),
    key_from=sales_line_keys,
    records=sales_ledger_records,
    on_conflict="keep",
)

# Transfers accumulate for the same reason sales does, and against the same key. The
# despatch of a line between two plants is a fact with a date on it, the dump carries
# only the current month, and superseding it therefore threw the closed months away.
#
# But unlike a sale, a transfer line is not finished when it is billed, and this is the
# one place the two ledgers must differ. A line stays *in transit* until the receiving
# plant posts a goods receipt, and `GR DATE` fills in on a later dump — 227 of the 1,088
# lines held did exactly that. Keep-first would freeze every one of them as in transit
# for good: the table reported 445 lines in transit against a true 218, and the error was
# permanent and invisible, because each line was individually plausible.
#
# So the newer dump wins. The key still does the job it was chosen for — a re-sent day
# cannot double count — and the fields that legitimately move are allowed to move.
_TRANSFER_TABLE = TableSpec(
    table="tsl_transfers",
    mode="accumulating",
    key=("billing_document", "billing_item"),
    key_from=transfer_line_keys,
    records=transfer_ledger_records,
    on_conflict="replace",
)

def _snapshot(slot: str) -> TableSpec:
    """A slot exposed as a view over its current batch, and absorbed nowhere.

    Every one of these is replaced whole on upload, which is what the owner wants of
    them: no history of yesterday's stock, only today's. A view over the current batch
    is precisely that and costs nothing — no second copy of the rows, no absorption to
    run or to fail, no window in which the table is half-emptied, and no path by which
    any of it could move a published number. Superseding the batch changes what the view
    returns, in the statement that made the upload current.

    The view's DDL is generated from this registry by `tools/generate_dump_views.py`,
    because a view has to name its columns and the stored grid is positional.
    """
    return TableSpec(table="dump_" + slot.replace(":", "_"), mode="snapshot")


# The two mapping masters out of the approved RM tracker workbook. Both accumulate, and
# both let the newer workbook win.
#
# Last-wins rather than keep-first, and that is the owner's call rather than a default:
# a code does get re-bucketed and an OEM's spelling does get corrected, and under
# keep-first neither would ever land — the workbook would stop being the thing that
# decides. What accumulating buys is the other direction: a code the newest workbook
# happens not to mention is not thereby deleted.
_BUCKETING_TABLE = TableSpec(
    table="dump_bucketing",
    mode="accumulating",
    key=("material_code",),
    key_from=bucketing_keys,
    records=bucketing_records,
    on_conflict="replace",
)

_OEM_KEY_TABLE = TableSpec(
    table="dump_oem_key",
    mode="accumulating",
    key=("customer",),
    key_from=oem_key_keys,
    records=oem_key_records,
    on_conflict="replace",
)

TABLES: dict[str, TableSpec] = {slot: _SALES_TABLE for slot in SALES_LEDGER_SLOTS}
TABLES["transfers"] = _TRANSFER_TABLE
TABLES["bucketting"] = _BUCKETING_TABLE
TABLES["oem_key"] = _OEM_KEY_TABLE

# The material master, keyed on the code *and the plant it is extended at*. Last-wins for
# the same reason the other two masters are: SAP is the authority on what a material is,
# and a corrected description should land. Accumulating means a code SAP stops extracting
# is not thereby forgotten.
TABLES["zmat"] = TableSpec(
    table="dump_zmat",
    mode="accumulating",
    key=("material_code", "plant"),
    key_from=zmat_keys,
    records=zmat_records,
    on_conflict="replace",
)
TABLES.update({slot: _snapshot(slot) for slot in (
    "stock", "wip", "rfd", "receivables", "vsm_stock", "vsm_tvsm",
    "schedule", "schedule_supplement",
    # The two multi-sheet planning families, by family: `orders:jsr` and `signoff:hosur`
    # resolve through `table_for`, and each sheet gets its own view.
    "orders", "signoff",
)})

# A slot that deliberately keeps no table of its own, and why. Explicit rather than
# implied by absence, so that adding a slot without deciding where its rows go fails a
# test instead of passing unnoticed — the same reason `pipeline.json` lists every input.
SLOTS_WITHOUT_A_TABLE: dict[str, str] = {
    # Read with `header=None`, because the quarters they hold are column offsets rather
    # than named fields. There are no column names to give a table or a view, so a stored
    # copy would be `{"0": ..., "1": ...}` — unreadable, unqueryable, and no better than
    # the grid it came from. This one keeps nothing on purpose.
    "contract": "read positionally with header=None — it has no column names to store",
}


def table_for(slot: str) -> TableSpec | None:
    """Where this slot's rows are kept, or None where it deliberately keeps none.

    Resolves `orders:jsr` through its family, since the family slots are built at run
    time from the pipeline's own sheet specs and cannot be listed here. An unknown slot
    raises rather than quietly storing nothing: silence is how a dump goes unstored for
    a fortnight and nobody notices until a month is short.
    """
    if slot in TABLES:
        return TABLES[slot]
    family = slot.split(":", 1)[0]
    if family in TABLES:
        # The family is registered once; each of its sheets gets its own view, because
        # `orders:jsr` and `orders:hk_so` are different sheets with different columns and
        # sharing one name would have three slots all pointing at `dump_orders`.
        return replace(TABLES[family], table=_snapshot(slot).table)
    if slot in SLOTS_WITHOUT_A_TABLE or family in SLOTS_WITHOUT_A_TABLE:
        return None
    raise KeyError(
        f"slot {slot!r} says nothing about where its rows are kept. Add it to TABLES or, "
        f"with a reason, to SLOTS_WITHOUT_A_TABLE."
    )


def slots_with_tables(mode: str) -> tuple[str, ...]:
    """The named slots whose rows are kept in a table of the given mode.

    Family slots are excluded: they are addressed as `family:sheet` and are resolved
    through `table_for`, so a query built from this list names only what it can name.
    """
    return tuple(sorted(
        slot for slot, spec in TABLES.items() if spec.mode == mode
    ))


class Sources:
    """The frames the pipeline reads, by slot name."""

    def __init__(self, extra_slots: dict[str, ReadSpec] | None = None):
        self.slots = dict(SLOTS)
        if extra_slots:
            self.slots.update(extra_slots)

    def spec(self, slot: str) -> ReadSpec:
        try:
            return self.slots[slot]
        except KeyError:
            raise KeyError(
                f"Unknown input slot {slot!r}. Known slots: {sorted(self.slots)}"
            ) from None

    def available(self, slot: str) -> bool:
        raise NotImplementedError

    def frame(self, slot: str, *, sheet: str | None = None) -> pd.DataFrame:
        raise NotImplementedError

    def sheet_names(self, slot: str) -> list[str]:
        raise NotImplementedError

    def frame_or_empty(self, slot: str, *, sheet: str | None = None) -> pd.DataFrame:
        """An optional input that was not sent reads as an empty frame.

        Several sections are written to cope with an absent dump and say so on the page;
        they test `.empty` rather than branching on a path. Keeping that here means the
        absence is handled the same way whichever backend is serving the slot.
        """
        if not self.available(slot):
            return pd.DataFrame()
        return self.frame(slot, sheet=sheet)

    def sales_ledger(self) -> pd.DataFrame:
        """Every TSL sales line this source can reach, each line once.

        The default builds the ledger from the sales slots on the fly, which is what the
        offline `dumps/` run and the cell-fidelity harness do. `PostgresSources` overrides
        it with the stored table, where the same lines have been accumulating across every
        upload rather than being rebuilt from whichever extracts happen to be present.

        Both must agree, and that is the point of assembling it the same way in both
        places: the key decides, and it is the same key.
        """
        parts = []
        for slot in SALES_LEDGER_SLOTS:
            if slot not in self.slots or not self.available(slot):
                continue
            frame = sales_line_keys(self.frame(slot))
            if not frame.empty:
                parts.append(frame)
        if not parts:
            return pd.DataFrame()
        ledger = pd.concat(parts, ignore_index=True)
        # First occurrence wins, and `SALES_LEDGER_SLOTS` is the precedence order.
        ledger = ledger.drop_duplicates(
            subset=["billing_document", "billing_item"], keep="first"
        )
        return sales_ledger_order(ledger)


class ExcelSources(Sources):
    """The dumps folder — what the pipeline has always read.

    Every call below is the same `pd.read_excel` the pipeline used to make inline, with
    the same arguments, so this backend is behaviour-neutral by construction. That is
    the point: it is the control against which the Postgres backend is measured.
    """

    def __init__(self, input_dir: Path, extra_slots=None):
        super().__init__(extra_slots)
        self.input_dir = Path(input_dir).resolve()
        self._sheet_name_cache: dict[str, list[str]] = {}

    def path(self, slot: str) -> Path:
        spec = self.spec(slot)
        for name in spec.files:
            candidate = self.input_dir / name
            if candidate.exists():
                return candidate
        if spec.optional:
            raise FileNotFoundError(slot)
        raise FileNotFoundError(
            f"Required input not found. Expected one of: {', '.join(spec.files)}"
        )

    def available(self, slot: str) -> bool:
        try:
            self.path(slot)
        except FileNotFoundError:
            return False
        return True

    def sheet_names(self, slot: str) -> list[str]:
        path = self.path(slot)
        key = str(path)
        if key not in self._sheet_name_cache:
            self._sheet_name_cache[key] = list(pd.ExcelFile(path).sheet_names)
        return self._sheet_name_cache[key]

    def frame(self, slot: str, *, sheet: str | None = None) -> pd.DataFrame:
        spec = self.spec(slot)
        if spec.sheet is CALLER_NAMES_THE_SHEET:
            if sheet is None:
                raise ValueError(f"Slot {slot!r} needs the sheet to be named.")
            spec = replace(spec, sheet=sheet)
        elif sheet is not None:
            spec = replace(spec, sheet=sheet)

        path = self.path(slot)
        try:
            return pd.read_excel(
                path,
                sheet_name=spec.sheet,
                header=spec.header,
                usecols=spec.usecols,
                dtype=spec.dtype,
            )
        except ValueError as exc:
            # pandas raises ValueError for a sheet the workbook does not carry. Naming
            # that case is what lets the caller tell it apart from a genuinely broken
            # read; checking the sheet list up front would mean opening every workbook
            # twice, and zmat alone is 6.9 MB.
            if "Worksheet" in str(exc) or "sheet" in str(exc).lower():
                raise SheetMissing(f"{path.name} has no sheet {spec.sheet!r}") from exc
            raise


def excel_column_range(usecols: str | None, width: int) -> list[int]:
    """The column positions a `usecols` window selects, e.g. "U:AF" -> 20..31.

    Only the letter-range form is supported, because it is the only form the pipeline
    uses. A name list would be a different thing and is deliberately not guessed at.
    """
    if usecols is None:
        return list(range(width))
    if not re.fullmatch(r"[A-Z]+:[A-Z]+", usecols):
        raise ValueError(f"Unsupported usecols spec {usecols!r}")

    def index_of(letters: str) -> int:
        n = 0
        for char in letters:
            n = n * 26 + (ord(char) - ord("A") + 1)
        return n - 1

    first, last = usecols.split(":")
    return list(range(index_of(first), index_of(last) + 1))


def name_columns(header_cells: list, count: int) -> list[str]:
    """Header names the way pandas makes them: blanks numbered, duplicates suffixed.

    Reproduced rather than approximated, because a column named differently here is a
    KeyError three thousand lines later — or worse, a silently absent column that a
    `.get` turns into an empty series.
    """
    names: list[str] = []
    for position in range(count):
        value = header_cells[position] if position < len(header_cells) else None
        if value is None or (isinstance(value, str) and value == ""):
            names.append(f"Unnamed: {position}")
        elif isinstance(value, float) and value.is_integer():
            # A header cell holding a number reads as the number, not as "3.0".
            names.append(str(int(value)))
        else:
            names.append(str(value))

    seen: dict[str, int] = {}
    mangled: list[str] = []
    for name in names:
        if name in seen:
            seen[name] += 1
            mangled.append(f"{name}.{seen[name]}")
        else:
            seen[name] = 0
            mangled.append(name)
    return mangled


class GridSources(Sources):
    """Frames rebuilt from a parsed cell grid rather than read from a workbook.

    This is the shape the uploaded dumps take: the browser parses the .xlsx and stores
    the sheet as cells, and the read spec — which row is the header, which column window,
    which columns are pinned to text — is applied here, at read time. Keeping the spec on
    this side means a corrected header row is a re-read, not a re-upload.

    It is also the thing under test. `tools/compare_cell_sources.py` asserts that every
    slot rebuilt this way equals the one `pd.read_excel` produces, which is the whole
    basis for trusting an uploaded dump as much as a mailed file.
    """

    def grid(self, slot: str) -> dict:
        """`{"sheet": str, "n_cols": int, "cells": [[...]]}` for a slot. Subclasses supply."""
        raise NotImplementedError

    def frame(self, slot: str, *, sheet: str | None = None) -> pd.DataFrame:
        spec = self.spec(slot)
        stored = self.grid(slot)
        if sheet is not None and stored["sheet"] != sheet:
            raise SheetMissing(f"stored cells for {slot!r} are sheet {stored['sheet']!r}")

        grid = [
            [self._decode(cell) for cell in row]
            for row in stored["cells"]
        ]

        # Bound the sheet on its content before anything else, because openpyxl does:
        # the declared range routinely runs past the last real row. Crucially this looks
        # at the whole row, not the column window — Bucketting is read as U:AF, and 211
        # of its rows are blank in that window while carrying data elsewhere. Trimming
        # after the window dropped all 211.
        last_row = None
        for index, row in enumerate(grid):
            if any(cell is not None for cell in row):
                last_row = index
        grid = grid[: 0 if last_row is None else last_row + 1]

        width = stored["n_cols"]
        keep = [c for c in excel_column_range(spec.usecols, width) if c < width]

        if spec.header is None:
            body = grid
            names = list(range(len(keep)))
        else:
            header_row = grid[spec.header] if spec.header < len(grid) else []
            names = name_columns([header_row[c] for c in keep], len(keep))
            body = grid[spec.header + 1:]

        rows = [[row[c] if c < len(row) else None for c in keep] for row in body]
        frame = pd.DataFrame(rows, columns=names)

        # A trailing column that is empty top to bottom, header included, is the same
        # artefact one axis over. Only unnamed ones go: a named column that happens to be
        # empty this week is part of the sheet's shape and pandas keeps it.
        if spec.header is not None:
            while len(frame.columns):
                last = frame.columns[-1]
                if str(last).startswith("Unnamed: ") and frame[last].isna().all():
                    frame = frame.iloc[:, :-1]
                else:
                    break

        for column in frame.columns:
            frame[column] = self._as_pandas_dtype(frame[column], column, spec)
        return frame.reset_index(drop=True)

    @staticmethod
    def _decode(cell):
        if isinstance(cell, dict):
            if "__excel_date" in cell:
                return pd.Timestamp(cell["__excel_date"]).tz_localize(None)
            if "__excel_time" in cell:
                return time.fromisoformat(cell["__excel_time"])
        return cell

    @staticmethod
    def _as_pandas_dtype(series: pd.Series, column, spec: ReadSpec) -> pd.Series:
        """Give a rebuilt column the dtype `read_excel` would have given it.

        A column built from a Python list is object dtype whatever it holds, so the
        numeric and datetime columns have to be recovered. The pinned text columns are
        left alone on purpose — pinning them is what stops a material code losing its
        last digit to a float.
        """
        if spec.dtype and column in spec.dtype:
            return series.astype(object).map(
                lambda v: None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v)
            )

        values = series.dropna()
        if values.empty:
            return series.astype(object)
        if all(isinstance(v, pd.Timestamp) for v in values):
            return pd.to_datetime(series)
        if all(isinstance(v, bool) for v in values):
            return series.astype(bool) if len(values) == len(series) else series
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values):
            numeric = pd.to_numeric(series, errors="coerce")
            # pandas keeps an all-integer column as int64 only when nothing is missing.
            if len(values) == len(series) and all(float(v).is_integer() for v in values):
                return numeric.astype("int64")
            return numeric.astype("float64")
        return series.astype(object)


class CellSources(GridSources):
    """Grids read from a directory of JSON files, as `tools/export_sheet_cells.mjs` writes.

    The comparison harness runs against this, so it is the backend the fidelity claim is
    actually about. It is also how a refresh can be reproduced offline from a saved
    export, with no database in the loop.
    """

    def __init__(self, cell_dir, extra_slots=None):
        super().__init__(extra_slots)
        self.cell_dir = Path(cell_dir)

    def _path(self, slot: str) -> Path:
        return self.cell_dir / f"{slot.replace(':', '__')}.json"

    def available(self, slot: str) -> bool:
        self.spec(slot)
        return self._path(slot).exists()

    def sheet_names(self, slot: str) -> list[str]:
        return sorted({
            json.loads(path.read_text())["sheet"]
            for path in self.cell_dir.glob(f"{slot.replace(':', '__')}*.json")
        })

    def grid(self, slot: str) -> dict:
        path = self._path(slot)
        if not path.exists():
            raise FileNotFoundError(f"No stored cells for slot {slot!r}")
        return json.loads(path.read_text())


class PostgresSources(GridSources):
    """Grids read from the uploads table — what the refresh runs on in production.

    Same rebuild as `CellSources`, because it is the same grid: the uploader stores
    exactly what the browser parsed, and the read spec is applied here rather than at
    upload time. So the fidelity proved for one holds for the other, and a corrected
    header row never means asking the owner to re-send a workbook.

    Reads go through PostgREST with the service-role key rather than a Postgres
    connection, which is what lets this run on a GitHub Actions runner with no database
    port open. See .env.local.example for why that is not merely a convenience here.
    """

    def __init__(self, client, extra_slots=None):
        super().__init__(extra_slots)
        self.client = client
        self._batches: dict[str, dict] | None = None
        self._grids: dict[str, dict] = {}

    @property
    def batches(self) -> dict[str, dict]:
        """The current batch per slot. One row each — superseding is what guarantees it."""
        if self._batches is None:
            rows = self.client.select(
                "raw_batches",
                "status=eq.current&select=id,slot,sheet,row_count,original_filename,content_sha256",
            )
            self._batches = {row["slot"]: row for row in rows}
        return self._batches

    def available(self, slot: str) -> bool:
        self.spec(slot)
        return slot in self.batches

    def sheet_names(self, slot: str) -> list[str]:
        # The schedule keeps one current batch per month sheet, so this is the list of
        # months held — the same question `pd.ExcelFile(...).sheet_names` answered.
        rows = self.client.select(
            "raw_batches", f"status=eq.current&slot=eq.{slot}&select=sheet"
        )
        return sorted({row["sheet"] for row in rows if row["sheet"]})

    def grid(self, slot: str) -> dict:
        if slot in self._grids:
            return self._grids[slot]
        batch = self.batches.get(slot)
        if batch is None:
            raise FileNotFoundError(f"No current upload for slot {slot!r}")

        cells: list[list] = []
        # Paged, because PostgREST caps a response at 1,000 rows and zmat is 65,178.
        # The cap is server-side and silent: asking for 5,000 returns 1,000 with no
        # error, so a loop that stops when it gets fewer rows than it asked for stops
        # after the first page and every sheet arrives truncated. It cost a refresh that
        # read 998 rows of Bucketting and failed the bucket-resolution floor — which is
        # the gate doing its job, but the cause was here. Page by what the server will
        # actually give, and stop only on a short page.
        page = 1000
        offset = 0
        while True:
            rows = self.client.select(
                "raw_rows",
                f"batch_id=eq.{batch['id']}&select=seq,row&order=seq.asc"
                f"&offset={offset}&limit={page}",
            )
            cells.extend(row["row"] for row in rows)
            if len(rows) < page:
                break
            offset += len(rows)

        if len(cells) != batch["row_count"]:
            raise SupabaseRowCountMismatch(
                f"slot {slot!r}: read {len(cells)} rows but the batch says "
                f"{batch['row_count']}. A partial read must never reach the pipeline."
            )

        grid = {
            "slot": slot,
            "sheet": batch["sheet"],
            "n_rows": len(cells),
            "n_cols": max((len(r) for r in cells), default=0),
            "cells": cells,
        }
        self._grids[slot] = grid
        return grid

    # ---- Absorption: a batch into the table its slot keeps ----------------

    def frame_for_batch(self, batch: dict) -> pd.DataFrame:
        """One named batch's frame, rather than its slot's current one.

        The two differ precisely in the case absorption exists for: `promote_upload`
        supersedes the previous batch the moment a second dump is uploaded, so a slot's
        *current* grid is not the batch being folded in. The swap is around `frame()`
        rather than inside it because everything else in this class — the pipeline
        included — wants the current batch and should keep getting it.
        """
        slot = batch["slot"]
        self._grids.pop(slot, None)
        held = self._batches
        self._batches = {slot: batch}
        try:
            return self.frame(slot)
        finally:
            self._batches = held
            self._grids.pop(slot, None)

    def unabsorbed_batches(self, mode: str) -> list[dict]:
        """Batches of that storage mode whose rows are not yet in their table, oldest first.

        Deliberately not "the current batch". `promote_upload` supersedes the previous
        one, so uploading two dumps between refreshes leaves the first superseded and
        unread — and for an accumulating slot its rows would be lost for good once
        pruning caught up with it. Absorbing by `absorbed_at is null` instead means a
        batch is folded in exactly once, whatever order uploads and refreshes interleave
        in.
        """
        slots = slots_with_tables(mode)
        if not slots:
            return []
        return self.client.select(
            "raw_batches",
            f"absorbed_at=is.null&slot=in.({','.join(slots)})"
            "&select=id,slot,sheet,row_count,original_filename&order=uploaded_at.asc",
        )

    def absorb(self, mode: str = "accumulating", log=print) -> dict[str, int]:
        """Fold every un-absorbed batch of that mode into the table its slot keeps.

        For an accumulating table the insert names both a conflict target and a
        resolution, and the two must be given together: PostgREST treats a resolution
        without a target as an ordinary insert and raises on the first duplicate key,
        which would turn a re-sent day into a failed refresh. `ignore-duplicates` is what
        makes a re-send, a re-upload and an overlapping backfill all converge on the same
        table; `merge-duplicates` is for the masters where the newer file is meant to win.

        The stamp is last and is the flip. Until it is written the batch is still
        un-absorbed and a crash mid-insert simply leaves it to be picked up again.

        Only an accumulating slot is absorbed at all. A snapshot slot is exposed as a
        view over its current batch and has nothing to fold in — writing a copy of it
        would be a second statement of the same rows, kept in step by hand.

        A batch the read refuses — a dump filed under the wrong slot — is skipped rather
        than raised past the other batches. One bad file must not stop the good ones, and
        it must certainly not stop the sales ledger the pipeline is about to read. It is
        left **un-absorbed**, which is what makes the refusal repeat on every refresh and
        keeps `prune_uploads` from deleting it: a complaint that stops being made is a
        complaint nobody acts on, and this one wants somebody to send the right file.
        """
        if mode != "accumulating":
            raise ValueError(
                f"nothing is absorbed for mode {mode!r}. A snapshot slot is a view over "
                f"its current batch; there is no second copy to fill."
            )
        absorbed: dict[str, int] = {}
        for batch in self.unabsorbed_batches(mode):
            spec = table_for(batch["slot"])
            if spec is None or spec.mode != mode:
                # `slot=in.(...)` named only the slots of this mode, so reaching here
                # means the registry and the query disagree. Skip rather than store a
                # row in a table that was not asked for.
                continue
            if spec.records is None:
                raise ValueError(
                    f"{spec.table} says it stores {batch['slot']!r} but names no way to "
                    f"turn a frame into rows. A TableSpec without `records` stores "
                    f"nothing and stamps the batch absorbed, which loses the dump."
                )

            try:
                frame = self.frame_for_batch(batch)
                if spec.key_from is not None:
                    frame = spec.key_from(frame)
            except DumpRefused as refusal:
                log(f"  REFUSED {batch['original_filename']} "
                    f"(slot {batch['slot']}, uploaded {batch.get('uploaded_at', '?')}): "
                    f"{refusal}")
                continue
            records = spec.records(frame, batch["id"])

            if records:
                resolution = ("ignore-duplicates" if spec.on_conflict == "keep"
                              else "merge-duplicates")
                self.client.insert(
                    spec.table,
                    records,
                    prefer=f"resolution={resolution},return=minimal",
                    on_conflict=",".join(spec.key),
                )
            self.client.update(
                "raw_batches", f"id=eq.{batch['id']}", {"absorbed_at": "now()"}
            )
            # Keyed on the batch, not on the filename it arrived under. Four transfer
            # dumps were absorbed in a row and three of them were called `transfer.XLSX`,
            # so a filename-keyed tally reported "1,829 rows from 2 batches" where the
            # truth was 3,613 from 4 — the caller's summary is built from `sum` and `len`
            # of this, and both were wrong. The name is in the log line, where it is
            # useful and where it is allowed to repeat.
            absorbed[batch["id"]] = len(records)
            log(f"  absorbed {len(records)} rows from {batch['original_filename']} "
                f"into {spec.table}")
        return absorbed

    def absorb_sales(self, log=print) -> dict[str, int]:
        """The accumulating absorption, under the name the refresh calls it by.

        Kept as its own name rather than inlined at the call site because the test that
        guards the call asserts on the source text of `refresh_from_supabase.py` — see
        `test_the_refresh_absorbs_before_it_reads_the_ledger`, and the defect it records.
        """
        return self.absorb(mode="accumulating", log=log)

    def sales_ledger(self) -> pd.DataFrame:
        """The stored ledger, rebuilt as the frame the pipeline expects.

        Every line ever uploaded, not merely the ones the extracts currently in `dumps/`
        happen to cover. The stored `row` is the named line exactly as the read produced
        it, so this reconstitutes the same frame the file-backed backend assembles.
        """
        rows: list[dict] = []
        page = 1000
        offset = 0
        while True:
            # Ordered by the key so paging is stable; PostgREST's cap is silent, so the
            # loop stops on a short page rather than on an empty one.
            got = self.client.select(
                "tsl_sales",
                "select=billing_document,billing_item,row"
                "&order=billing_document.asc,billing_item.asc"
                f"&offset={offset}&limit={page}",
            )
            rows.extend(got)
            if len(got) < page:
                break
            offset += len(got)

        if not rows:
            return pd.DataFrame()
        frame = pd.DataFrame([r["row"] for r in rows])
        frame["billing_document"] = [r["billing_document"] for r in rows]
        frame["billing_item"] = [r["billing_item"] for r in rows]
        # Sorted here rather than in the query, so both backends settle the order the
        # same way. The query orders by the key only to page a stable set.
        return sales_ledger_order(_sales_ledger_dtypes(frame))
