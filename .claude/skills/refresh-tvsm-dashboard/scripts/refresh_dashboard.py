from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# The tests load this file by path with `spec_from_file_location`, which does not put its
# directory on the import path the way running it as a script does. Naming the directory
# here means the sibling module resolves under both.
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from sources import (  # noqa: E402
    ExcelSources,
    SheetMissing,
    Sources,
    slots_for_families,
)


SKILL_ROOT = Path(__file__).resolve().parents[1]
# What the owner has decided on the Missing mappings tab, as of the last run that could
# reach the database. Committed with the build it produced, which is what lets a clean
# clone with no credentials reproduce that build byte for byte.
ASSIGNMENTS_FILE = SKILL_ROOT / "config" / "bucket_assignments.json"
# The same arrangement for what the owner corrects on the SKU pricing tab: which
# value-added operations a SKU really carries, and what the customer's PO prices it at.
PRICING_OVERRIDES_FILE = SKILL_ROOT / "config" / "pricing_overrides.json"


def load_bucket_assignments(path: Path = ASSIGNMENTS_FILE, *, refresh: bool = True) -> dict:
    """The owner's material-code assignments, freshest first.

    The queue on the Missing mappings tab is answered in the browser and the answer is
    kept in `public.bucket_assignments`, which is not scoped to a build — the whole point
    is that it survives the refresh that replaces every row on the page. This reads it at
    the start of a run and writes what it read into the repository, so:

      - the daily run, which has credentials, picks up decisions made since yesterday and
        commits them alongside the build they produced;
      - a clean clone with no credentials reads the committed file and reproduces that
        build exactly, which is the check this project verifies sync claims with.

    A database that cannot be reached is not an error. It means today's run uses the
    decisions the file already holds, which is the same set the last published build used.
    """
    held = {}
    if path.exists():
        held = json.loads(path.read_text(encoding="utf-8")).get("assignments", {})

    if not refresh:
        return held

    try:
        from supabase_rest import SupabaseRest  # noqa: PLC0415 — optional at build time

        client = SupabaseRest(env_file=SKILL_ROOT.parents[2] / ".env.local")
        rows = client.select(
            "bucket_assignments",
            "select=scope,material_code,assigned_to&order=scope,material_code",
        )
    except Exception as error:  # noqa: BLE001 — any failure means "use what is committed"
        print(f"  assignments: keeping the committed set ({type(error).__name__})")
        return held

    fresh = {}
    for row in rows:
        if not row.get("assigned_to"):
            continue
        fresh.setdefault(row["scope"], {})[norm_code(row["material_code"])] = row["assigned_to"]

    if fresh != held:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"assignments": fresh}, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"  assignments: {sum(len(v) for v in fresh.values())} recorded, file updated")
    return fresh


def load_pricing_overrides(
    path: Path = PRICING_OVERRIDES_FILE, *, refresh: bool = True
) -> dict:
    """What the owner has corrected on the SKU pricing tab, freshest first.

    Same arrangement as `load_bucket_assignments`, and for the same reason: the decision
    is made in the browser, kept in a table that is not scoped to a build, read here at
    the start of a run, and written back into the repository so a clean clone with no
    credentials reproduces the same build.

    Two kinds, keyed the same way — `customer|bucket|material code|length in mm`, the same
    four parts the price build-up key is composed from:

      - `operations`: the set of value-added processes the SKU really carries, which
        **overrides** the schedule's flags rather than filling in for them. Every SKU
        where this view disagrees with a customer's own reconciliation is a case where the
        flags are wrong, so a fallback would correct none of them.
      - `po_prices`: what the customer's PO says, per quarter. It changes no calculated
        price; it is quoted as the PO rate in the quarterly CN/DN document.
    """
    held = {"operations": {}, "po_prices": {}}
    if path.exists():
        stored = json.loads(path.read_text(encoding="utf-8"))
        held = {kind: stored.get(kind, {}) for kind in held}

    if not refresh:
        return held

    try:
        from supabase_rest import SupabaseRest  # noqa: PLC0415 — optional at build time

        client = SupabaseRest(env_file=SKILL_ROOT.parents[2] / ".env.local")
        operation_rows = client.select(
            "sku_operations",
            "select=customer,bucket,material_code,length_mm,operations"
            "&order=customer,bucket,material_code,length_mm",
        )
        price_rows = client.select(
            "customer_po_prices",
            "select=customer,bucket,material_code,length_mm,quarter,price,unit"
            "&order=customer,bucket,material_code,length_mm,quarter",
        )
    except Exception as error:  # noqa: BLE001 — any failure means "use what is committed"
        print(f"  pricing overrides: keeping the committed set ({type(error).__name__})")
        return held

    fresh = {"operations": {}, "po_prices": {}}
    for row in operation_rows:
        fresh["operations"][pricing_override_key(row)] = sorted(row.get("operations") or [])
    for row in price_rows:
        if row.get("price") is None:
            continue
        key = f"{pricing_override_key(row)}|{row['quarter']}"
        fresh["po_prices"][key] = {
            "price": float(row["price"]),
            "unit": row.get("unit") or "",
        }

    if fresh != held:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(fresh, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(
            f"  pricing overrides: {len(fresh['operations'])} operation sets, "
            f"{len(fresh['po_prices'])} PO prices, file updated"
        )
    return fresh


def pricing_operation_override(overrides, customer, bucket, material_code, length_mm):
    """The corrected operation set for one priced SKU, or None where none is recorded.

    None and `[]` are different answers and must stay so: none means the schedule's flags
    govern, `[]` means somebody looked and said this SKU carries no value adds.
    """
    key = pricing_override_key({
        "customer": customer,
        "bucket": bucket,
        "material_code": None if material_code is None or pd.isna(material_code)
                         else str(material_code),
        "length_mm": length_mm,
    })
    return (overrides or {}).get("operations", {}).get(key)


def pricing_override_key(row) -> str:
    """`customer|material code|length in mm`, written the way the browser writes it.

    The length goes through `float` on both sides before it is printed, so `189` from a
    build and `189.0` from a Postgres `numeric` are the same key rather than two. An
    integral length prints without its decimal point, which is what JavaScript's
    `String(Number(x))` produces — the two must agree or no override ever matches.
    """
    length = float(row["length_mm"])
    written = f"{length:g}"
    return (
        f"{row['customer']}|{row['bucket']}|{row.get('material_code') or ''}|{written}"
    )


def _plain(value):
    """A pandas/numpy value as something `json.dumps` will take.

    Only ever reached from the `DUMP_*` blocks, which write the pipeline's internal maps
    out so the TypeScript port can be held to them key for key. None of those maps is
    published, so without this the only way to see one is through a figure already derived
    from it — by which point a disagreement has been folded into a tonnage.
    """
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, np.ndarray)):
        return [_plain(v) for v in value]
    if value is None or (isinstance(value, float)
                         and (math.isnan(value) or math.isinf(value))):
        return None
    if isinstance(value, (np.integer, np.floating, np.bool_)):
        return value.item()
    if isinstance(value, pd.Timestamp):
        return value.date().isoformat()
    return value


def none_if_nan(value):
    """A blank cell as `None`, so it crosses into JSON as null rather than the text "nan"."""
    return None if pd.isna(value) else value


def megh_ex_jsr_rate(realisation, carrying_days, is_long) -> float | None:
    """The ex-JSR rate at which Megh's landed cost equals what it can realise.

    The owner's workbook does this as a goal seek: it drives `Difference`, which is cost
    minus realisation, to zero by hand. The cost is linear in the rate being solved for,
    so there is a closed form and no iteration is needed —

        cost(r) = r + long_length_handling + levy_rate x (r - levy_threshold)
                    + fixed
                    + r x GST x interest x carrying_days / 365
                    + realisation x GST x interest x realisation_days / 365

    Setting `cost(r) = realisation` and gathering the terms in `r` gives the rate below.
    Verified against every one of the 1,211 TVS lines of the owner's Q1 FY27 workbook.
    """
    if realisation is None or not realisation:
        return None
    cost = MEGH_RECO_COST
    carried = cost["interest_rate"] * MEGH_RECO_GST_FACTOR
    in_rate = 1 + cost["levy_rate"] + carried * carrying_days / 365
    fixed = (
        (cost["long_length_handling"] if is_long else 0)
        + sum(cost["fixed"])
        - cost["levy_rate"] * cost["levy_threshold"]
        + realisation * carried * cost["realisation_days"] / 365
    )
    return (realisation - fixed) / in_rate


def whole_number_text(value) -> str | None:
    """An identifier that arrived as a number, back as the text it is.

    `Billing  Document Number` and `Billing Item` are integers in SAP and floats out of
    pandas, so an invoice reaches a customer's reconciliation as `4731002954.0` and
    matches nothing. A value that is not a whole number is left as written.
    """
    if pd.isna(value):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    return str(value).strip() or None


def financial_quarter(billing_month) -> str | None:
    """`2026-01` -> `Q4 FY26`. The financial year runs April to March.

    Written to match the contract sheet's own quarter labels exactly, because the pricing
    tab, the price build-up key and this all have to name the same quarter the same way.
    """
    if billing_month is None or pd.isna(billing_month):
        return None
    try:
        year, month = (int(part) for part in str(billing_month).split("-")[:2])
    except ValueError:
        return None
    if not 1 <= month <= 12:
        return None
    # April starts a new financial year, so January to March close the one already named.
    quarter = (month - 4) // 3 + 1 if month >= 4 else 4
    fy = year + 1 if month >= 4 else year
    return f"Q{quarter} FY{fy % 100:02d}"


def financial_quarter_order(label: str) -> tuple[int, int]:
    """`Q4 FY26` -> `(26, 4)`, so a list of quarters sorts into calendar order."""
    quarter, fy = label.split(" FY")
    return int(fy), int(quarter[1:])


def norm_code(value):
    if pd.isna(value):
        return None
    text = str(value).strip()
    if re.fullmatch(r"\d+(\.0+)?", text):
        return str(int(float(text)))
    return text.upper()


def norm_text(value):
    if pd.isna(value):
        return None
    text = re.sub(r"[^A-Z0-9]+", " ", str(value).upper()).strip()
    return re.sub(r"\s+", " ", text) or None


# A finished length at or above this many metres is a long length (LL); anything
# shorter is an exact-length CTL cut.
LONG_LENGTH_MIN_M = 3.5
# The vsm stock plan states most lengths in metres but a few in millimetres — 650, 780
# and 572.5 sit beside 5.84 and 6.0 in the same column. No tube in this business is
# 20 m, so a value above that is millimetres and is divided down. Left alone, a 650 mm
# cut piece keys as 650 m, classifies as long length and matches no stock at all.
VSM_LENGTH_MM_ABOVE_M = 20
# What a value the pipeline looked up and could not resolve reads as. An empty cell says
# "nothing to report" and gets skimmed past; this says the lookup failed and the row
# needs a mapping. Used on the exports and mirrored on the page.
LOOKUP_ERROR = "lookup error"

# Megh Steel runs a vendor service model: Tata Steel supplies it, and it supplies TVSM,
# Royal Enfield and HMSIL. The RM tracker's `vsm stock` plan covers all three, and marks
# the sizes destined for RE and HMSIL rather than TVSM with this prefix, written
# `Megh-OD-ID-thickness-length`. That has the same five parts as a governed TVS bucket
# and means something different in the last two, so the prefix is the only thing telling
# the two shapes apart — and it says which OEM the size is for, not that the size is
# ungoverned.
MEGH_KEY_PREFIX = "Megh"
# The end OEM a prefixed size actually goes to is read from which conversion-agent code
# has bought it, since the prefix does not distinguish RE from HMSIL.
MEGH_ONWARD_OEMS = ("RE", "HMSIL")
MEGH_ONWARD_UNKNOWN = "RE or HMSIL"
TVSM_END_OEM = "TVSM"

# Bought-out parts: the sizes Megh Steel buys finished rather than converting, from the
# list the owner supplied. Each entry is (dim1, dim2, thickness, length_mm, nos, plant)
# exactly as written — dim2 is 0 for a round tube and the second dimension for a
# rectangular section, which is how the governed bucket keys them too.
MEGH_BOP_ITEMS = (
    (12.70, 0, 1.2, 6000, 7, "0789"),
    (19.05, 0, 2.0, 5840, 40, "0789"),
    (22.20, 0, 1.6, 5670, 40, "056"),
    (22.20, 0, 2.0, 6000, 45, "056"),
    (22.20, 0, 2.0, 5950, 80, "0789"),
    (22.20, 0, 1.2, 5900, 12, "0789"),
    (22.20, 0, 1.6, 5270, 35, "056"),
    (38.10, 0, 2.5, 6190, 40, "056"),
    (38.10, 0, 1.6, 6190, 30, "056"),
    (38.10, 0, 2.0, 5650, 15, "0788"),
    (54.00, 0, 3.0, 5900, 20, "056"),
    (57.15, 0, 2.5, 6100, 70, "056"),
    (57.15, 0, 2.5, 5710, 70, "0789"),
    (40.00, 25, 1.6, 6010, 25, "056"),
    (25.40, 0, 2.5, 5530, 15, "0789"),
    (19.05, 0, 2.0, 6000, 10, "0788"),
    (60.30, 0, 2.0, 5900, 30, "0788"),
)
# The list states nominal lengths and the plan holds exact cut lengths, so a line is
# matched to the nearest plan length within this tolerance. The band is deliberately
# tight: at 200 mm it pulled 19.05 x 2.0 x 6000 onto the plan's 19.05-0-2-5.8 row, and
# 200 mm is a different size, not a rounding of the same one. A listed size that now
# matches nothing becomes its own row on the Megh tab instead — see MEGH_BOP_ADDED_NOTE.
MEGH_BOP_LENGTH_TOLERANCE_MM = 50
# What a BOP row carries when the plan has no line for it at all. Megh Steel buys the
# size whether or not `rmtracker` names it, so it is a line item on the tab with the
# figures the plan cannot supply left at zero — not a footnote under the table.
MEGH_BOP_ADDED_NOTE = "Not in the vsm stock plan — BOP list only"

# Past sales trend. The daily dump is the current month only, so the trend view reads
# the quarterly extracts beside it. Each arrives in the sales dump's own 225-column
# layout, so one parser serves all three. Only `Sheet1` carries data: the other sheets
# in those workbooks are working copies whose every row is already in Sheet1, and
# reading them would double count.
# Add a month here as it closes, by archiving that month's daily sales dump under a
# name of its own. The daily dump only ever covers the month in progress, so a month it
# has stopped covering exists nowhere else until it is archived — July vanished from the
# trend on 1 August exactly that way. A month held by both an archive and the daily dump
# is taken from the daily dump only, so archiving early is safe.
SALES_TREND_FILES = ("sales_q4.xlsx", "sales_q1.xlsx", "sales_jul.xlsx")
SALES_TREND_SHEET = "Sheet1"
# ---- Megh Steel's price-difference reconciliation ---------------------------------
#
# Megh's quarterly CN/DN working is not the ancillaries' working with different numbers
# in it; the arithmetic is a different shape, and it is worth stating why. An ancillary
# buys a tube and is billed for it, so the claim is the contract price against the billed
# price. Megh *converts*: it buys from Tata, processes, and sells on to TVS, Royal
# Enfield, HMSIL and Rane. What it should have been billed is therefore what it can sell
# at, less what conversion costs it — so the working solves for the ex-JSR rate at which
# Megh's landed cost equals its realisation, and compares that against what it was
# actually charged. Everything is per tonne, because Megh is billed per kilogram.
#
# Reverse-engineered from the owner's own Q4 FY26 and Q1 FY27 workbooks and verified
# against them line by line: the closing arithmetic reproduces all 3,175 lines of both
# quarters across all four OEMs, and this cost model reproduces the ex-JSR rate on all
# 1,211 TVS lines of Q1. Both are pinned by tests.
#
# The one thing the dashboard does not hold is Megh's **base price master**. Their
# workbook looks it up by material number in a separate file, and while it agrees with
# `contract.xlsx` on most sizes it does not on all: deriving the base from the contract
# instead reproduces 1,060 of 1,207 lines and overstates a Rs 1.76 crore quarter by
# Rs 5.05 lakh. So the published working states every line and its charged price, and
# leaves the claim columns blank rather than filling them with a figure that is right
# seven times in eight. A wrong claim looks exactly like a right one.
MEGH_RECO_GST_FACTOR = 1.18
# What conversion costs Megh, per tonne, on top of the ex-JSR rate it pays.
MEGH_RECO_COST = {
    "long_length_handling": 1720,   # a long length only
    "levy_rate": 0.02,              # on the ex-JSR rate above the threshold below
    "levy_threshold": 39240,
    "fixed": (625, 150, 450, 800),  # handling, and the three freight and service legs
    "interest_rate": 0.102,         # per annum, charged on the GST-inclusive value
    "realisation_days": 60,         # Megh's own credit against its onward sale
}
# How long Megh carries the stock before it sells on, by the plant that despatched it.
# Read off the owner's workbook: the long haul from Jamshedpur and Khopoli carries a
# month, the southern plants a week. Three lines at 8406 carry nothing at all and are
# hand adjustments rather than a rule, so they are not reproduced.
MEGH_RECO_CARRYING_DAYS = {"56": 30, "788": 30, "789": 7, "4731": 7, "8406": 7}
MEGH_RECO_DEFAULT_CARRYING_DAYS = 30

# The two parties the trend splits. Megh Steel converts for TVS under this code, which
# `OEM_key_1_rev codes` classifies as Direct, so it is named rather than inferred.
MEGH_TVS_CUSTOMER_CODE = "943209"
TREND_SEGMENT_DIRECT = "TVSM ancillaries"
TREND_SEGMENT_MEGH = "Megh Steel 943209"

# Megh Steels is a conversion agent. OEM_key_1_rev classifies every Megh code as
# Direct, but each code's name carries the end OEM it converts for, so route each
# code to that OEM and report no separate Direct group.
CONVERSION_AGENT_OEM_BY_CODE = {
    "943209": "TVS",    # MEGH STEELS PRIVATE LIMITED - TVS A
    "943210": "HMSIL",  # MEGH STEELS PRIVATE LIMITED - HMSIL
    "943211": "RE",     # MEGH STEELS PRIVATE LIMITED - RE
    # Megh converts for a fourth OEM and this map did not say so. The effect was
    # narrower than it looks, because `OEM_key_1_rev codes` already files this one
    # customer under `Rane` where it files the other three Megh codes under `Direct` —
    # so the sales summary was already right and only the **code repository** was
    # wrong, its scope being "OEM is TVS, or the code is a conversion agent". Three
    # bill-to/ship-to/plant combinations at 150.631 MT over the sales window sat
    # outside it and so could never appear in a price change request.
    #
    # Spelt `Rane`, exactly as the OEM key spells it. `RANE` would be a second name for
    # the same OEM, arriving on whichever rows this map labelled rather than the key,
    # and two spellings of one customer is how a summary grows a duplicate row.
    "943213": "Rane",   # MEGH STEELS PRIVATE LIMITED - RANE
}
TVS_PROXY_CUSTOMER_NAMES = {"MEGH STEELS PRIVATE LIMITED TVS A"}

# PLANT STOCKS marks pipeline stock with this customer name instead of an owner.
TRANSIT_CUSTOMER_NAME = "TRANSIT STOCK"

# Stock ageing beyond this many days, measured at month end, is high-age stock.
HIGH_AGE_DAYS = 60

# A receivable falls due this many days after the invoice (document) date. This
# governed term replaces the per-document Net Due Date in the source file.
RECEIVABLE_DUE_DAYS = 47

# Document types that represent a billing invoice. These are exactly the rows whose
# Nature is BILLING; everything else is a debit balance, credit note or collection.
BILLING_DOC_TYPES = {"RV", "RD"}

# What counts as an offset: a document that *reduces* what the ancillary owes. A debit
# balance does not — it adds to the exposure — so it is not an offset, and reporting one
# beside the credits made the figure a net of two unrelated things and its breakup a list
# to read past. Doc Type cannot decide this: AB carries both OTHER DEBIT BALANCE and
# OTHER CREDIT BALANCE rows. Nature can, so Nature is what governs.
#
# This is a whitelist, like BILLING_DOC_TYPES beside it, so a Nature nobody has seen is
# not quietly counted as an offset. What it excludes is tallied into the QC summary, so a
# new one is reported rather than dropped.
OFFSET_NATURES = {"CREDIT NOTE", "OTHER CREDIT BALANCE", "COLLECTION"}

# Stock transfer plan. Hosur EPA (8406) is the forward stocking point for the Hosur
# ancillary cluster; it is fed by stock transfer orders raised on the tube plants.
STR_DESTINATION_PLANT = "8406"
STR_SOURCE_PLANTS = ("789", "788", "4731")
# Days of forward cover the plan holds at the destination plant.
STR_TARGET_DAYS = 15
# The schedule sheet in the approved workbook, and the month it covers. A month's demand
# is only comparable with the same month's dispatch, so when the dumps roll into a new
# month before a new schedule workbook arrives, every balance on the page is the old
# month's demand minus the new month's sales. On 3 August that read as 4,200.991 MT
# open against 971.688 MT the week before — an artefact of the calendar, not a collapse
# in dispatch. `schedule_month_warning` turns that into a banner rather than leaving a
# reader to infer it. Update both when the owner sends the next month's workbook.
# The schedule sheet is named for the month it covers — `Schedule August` — and the
# owner renames it as the month rolls. It is resolved from the as-of date rather than
# hardcoded, with the previous naming kept as a fallback because one workbook shipped
# August demand on a sheet still called `Schedule July`.
MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]
# Order sign-off, one sheet per plant, each stating the split its own way. They agree on
# nothing except that a material code identifies the line, so each is read on its own
# terms and reduced to the same two numbers: tonnage signed off, and tonnage not.
SIGNOFF_FILE = "signoff.xlsx"
SIGNOFF_SHEETS = {
    # Jamshedpur marks sign-off with a Y/N flag, so the whole balance of a line falls to
    # one side or the other. Its separate `Sign Off Qty` column is deliberately unused:
    # it exceeds `Bal to Desp` on 9 of 27 rows, so it is measuring something else and
    # cannot be a part of this total.
    "jsr": {"code": "MATL_NO", "flag": "Sign Off", "signed_when": "Y",
            "quantity": "Bal to Desp", "signed": None, "unsigned": None},
    # Hosur states the signed tonnage against the order; the rest is unsigned.
    "hosur": {"code": "Material", "flag": None, "quantity": "Order Qty in MT",
              "signed": "SIGN OFF", "unsigned": None},
    # Khopoli states both halves outright. Its "Order Qty in MT" is pieces despite the
    # name, so it is not used as a total.
    "khopoli": {"code": "Material", "flag": None, "quantity": None,
                "signed": "Sign Off", "unsigned": "Non Sign Off"},
}
SCHEDULE_SHEET_PREFIX = "Schedule "
SCHEDULE_SHEET_FALLBACK = "Schedule July"
# Customers whose schedule the master workbook does not carry send it directly, each in
# its own layout — spreadsheets, a PDF, and two as tables in the mail body. Those lines
# are prepared into this optional file, which repeats the schedule sheet's own columns
# and is appended to it. The master's rows for those customers stay at zero and are
# dropped by the `schedule_qty > 0` filter, so a customer present in both is counted once.
SCHEDULE_SUPPLEMENT_FILE = "schedule_supplement.xlsx"

# Helper Customer names, as they appear in Schedule July, that the plan covers.
STR_CUSTOMERS = (
    "NMPL",
    "Rajsriya Automotive Hosur",
    "Rajsriya Automotive Mysore",
    "SANDHAR Hosur",
    "SANDHAR Mysore",
)
# A transfer line is still in transit until the receiving plant posts a goods receipt,
# so an empty GR DATE is the in-transit flag.
TRANSFER_INVOICE_MARKER = "TRANSFER"
# An STR can only be raised on a finished-goods code. Mother tubes standing in WIP
# carry a PTM- description; the finished goods that will be booked against them carry
# the same description under TUB-, so the FG code is recovered from zmat by swapping
# the prefix. HALB (semi-finished) codes are never orderable, so only FERT counts.
WIP_DESCRIPTION_PREFIX = "PTM"
FG_DESCRIPTION_PREFIX = "TUB"
FG_MATERIAL_TYPE = "FERT"

# Who sees which tab. The admin account sees everything including the admin tab; every
# other account sees what this grants it. It is published as its own small file so tab
# visibility can be changed by editing one list, without regenerating the dashboard,
# and an existing file is never overwritten by a refresh.
ADMIN_USER = "apoorv"
ACCESS_SALT = "tvsm-dashboard-2026"
ACCESS_DEFAULTS = {
    "admin": ADMIN_USER,
    "salt": ACCESS_SALT,
    # username -> sha256("username:salt:password"). Managed by scripts/manage_users.py;
    # never edited by a refresh, which only ever refreshes the grantable tab list.
    "accounts": {
        "apoorv": "daf2a19c4e93f27aac9ceb2cee9e2ace0d2af32217586f8103e0a0d34f059c8f",
        "mes": "a24047ee73ae673a5da593daa388a540505dc00e02d8c55a64f966f72f871d6c",
    },
    "tabs": [
        {"view": "customerView", "label": "Customer tracker"},
        {"view": "meghView", "label": "Megh Steel sales"},
        {"view": "llView", "label": "Long-length tracker"},
        {"view": "mappingView", "label": "Missing mappings"},
        {"view": "salesView", "label": "Sales summary"},
        {"view": "trendView", "label": "Past sales trend"},
        {"view": "pricingView", "label": "SKU pricing"},
        {"view": "stockView", "label": "Stock analysis"},
        {"view": "strView", "label": "STR to 8406"},
        {"view": "transferView", "label": "Transfers"},
        {"view": "overdueView", "label": "Ancillary overdue"},
    ],
    # mes sees the Megh Steel tracker and nothing else.
    "visible": {"mes": ["meghView"]},
}
ACCESS_DEFAULTS_JSON = json.dumps(ACCESS_DEFAULTS)

# Order book. One sheet per despatching origin, each naming its own open-quantity
# column, because the three plants report a different stage of the same commitment:
# Jamshedpur reports what is left to despatch, Hosur and Khopoli report what is left to
# produce on a sale, and the stock-yard transfers report what has actually been booked
# to production. Taking one column across all three would compare unlike things.
ORDER_BOOK_SHEETS = {
    "jsr": {
        "header": 0,
        "label": "Jamshedpur",
        "quantity_column": "Bal to Desp",
        "quantity_meaning": "balance to despatch",
        "code_column": "MATL_NO",
        "description_column": "DESCRIPTION",
        "customer_column": "CUSTOMER",
        "plant_column": "MFGPL",
        "order_column": "ORDER_NO",
        "remarks_column": "Remarks",
        # Jamshedpur states the age in days outright.
        "age_column": "AGE",
        "age_date_column": None,
        "kind": "Sale and STR",
    },
    "hk_so": {
        "header": 1,
        "label": "Hosur / Khopoli sales",
        "quantity_column": "BAL FOR PROD/ROLL(MT)",
        "quantity_meaning": "balance for production",
        "code_column": "Material Number",
        "description_column": "MATERIAL DESC.",
        "customer_column": "SOLD. CUST. NAME",
        "plant_column": "PLANT",
        "order_column": "SALES ORDER NO.",
        "remarks_column": "Remarks",
        # Hosur/Khopoli sales state it under a different name; same meaning.
        "age_column": "Ageing Days",
        "age_date_column": None,
        "kind": "Sale",
    },
    "hk_str": {
        "header": 0,
        "label": "Hosur / Khopoli stock transfers",
        "quantity_column": "Actual BTP (MT)",
        "quantity_meaning": "actual booked to production",
        # This sheet carries no material number today, only a description, so the code is
        # recovered from zmat. Name the columns it would arrive under so that when the
        # mapping is added to the sheet it is picked up without a code change; the
        # recovery stays as the fallback for whatever the sheet still leaves blank.
        "code_column": ("Material Number", "MATL_NO", "Material Code", "MATERIAL NO"),
        "description_column": "Material Description",
        "customer_column": "Mrk. Cust. Name",
        "plant_column": "PT-PLANT",
        "order_column": None,
        "remarks_column": "REMARKS",
        # The transfer sheet states no age, only the date the STR was raised, so the
        # age is the as-of date less that date.
        "age_column": None,
        "age_date_column": "STR Date",
        "kind": "STR",
    },
}
# A line the planners have marked `c` in the sheet's remarks column is not live demand
# and is kept out of both trackers. It is still reported, because 59% of the 31 July book
# carries the mark and a silently smaller order column would be read as a collapse in
# demand rather than as a filter.
ORDER_EXCLUDE_REMARK = "C"

# The planning sheets name a plant by its PT- code where the dumps use the SAP number.
ORDER_PLANT_CODES = {"PT-HOUS": "789", "PT-KHP": "788", "PT-JSR": "56"}

# Contract pricing. The base price sheet quotes every size per tonne and per metre for
# each quarter of the contract; the pricing view reads the three most recent quarters.
PRICING_QUARTERS = ("Q3 FY26", "Q4 FY26", "Q1 FY27")
# Value-added operations, in INR per tonne. Each becomes INR per metre through the
# tube's contract weight before it is added to the base price.
PRICING_OPERATION_RATES = {
    "Angle cut": 200,
    "Chamferring": 700,
    "Fin cut": 250,
    "Annealing ERW": 1000,
    "Annealing CEW": 1250,
}
# Layout of the contract workbook: one sheet per process route, the columns holding
# the size key and the tube weight, and the (base price/tonne, base price/m) column
# pair of each quarter the view reads.
PRICING_SHEETS = {
    "ERW": {
        "sheet": "Tata _ERW-Q4 FY26",
        "type_col": 0, "key_col": 6, "weight_col": 7,
        "quarters": {"Q3 FY26": (66, 67), "Q4 FY26": (69, 70), "Q1 FY27": (72, 73)},
    },
    "CEW": {
        "sheet": "Tata_CEW - Q1 FY27",
        "type_col": 1, "key_col": 8, "weight_col": 9,
        "quarters": {"Q3 FY26": (62, 63), "Q4 FY26": (65, 66), "Q1 FY27": (68, 69)},
    },
}
# A round tube's contract key carries no bore, but a drawn CEW bucket names its bore in
# the second position. Accept the round key when that second dimension really is the
# bore, within this tolerance in mm.
PRICING_BORE_TOLERANCE_MM = 0.6

# Drill-down column layouts. The modal falls back to the source/SKU/material/quantity
# layout when a detail key has no entry here.
STOCK_DETAIL_COLUMNS = [
    {"label": "Batch", "field": "batch"},
    {"label": "Plant", "field": "plant", "kind": "plant"},
    {"label": "Material code", "field": "material_code"},
    {"label": "Description", "field": "description"},
    {"label": "Held for", "field": "holder"},
    {"label": "Ageing date", "field": "ageing_date"},
    {"label": "Age (days)", "field": "age_days", "kind": "num"},
    {"label": "Age at month end", "field": "age_days_month_end", "kind": "num"},
    {"label": "Quantity", "field": "qty", "kind": "qty"},
]
OFFSET_DETAIL_COLUMNS = [
    {"label": "Document", "field": "document"},
    {"label": "Nature", "field": "nature"},
    {"label": "Posted on", "field": "posted_on"},
    {"label": "Reference", "field": "reference"},
    {"label": "Amount", "field": "qty", "kind": "qty"},
]
OVERDUE_DETAIL_COLUMNS = [
    {"label": "Invoice no", "field": "invoice_no"},
    {"label": "Document", "field": "document"},
    {"label": "Invoice date", "field": "invoice_date"},
    {"label": "Due date", "field": "due_date"},
    {"label": "Overdue age (days)", "field": "age_days", "kind": "num"},
    {"label": "Amount", "field": "qty", "kind": "qty"},
]
def megh_sales_detail_columns(months):
    """Sales to Megh: a material code per row, a month per column, a total at the end.

    Built per run rather than declared as a constant, because the months are whatever the
    ledger holds — a new month must not need a code change any more than it does for the
    month columns on the trend tab.

    Every month column says `add: True` outright. `kind: "mt"` is not summable on its own
    — it is also weight per metre and rupees per metre on the price build-up — so a layout
    that relied on it would render a footer of blanks under the one thing this table is
    read for.
    """
    return [
        {"label": "Material code", "field": "material_code"},
        {"label": "Description", "field": "sku"},
        *(
            {"label": month_label(month), "field": f"m_{month}",
             "kind": "mt", "add": True}
            for month in months
        ),
        {"label": "Total", "field": "qty", "kind": "qty"},
    ]


def month_label(month):
    """`2026-01` -> `Jan 26`, the way every other month column on the dashboard reads."""
    year, _, mm = str(month).partition("-")
    index = int(mm) - 1 if mm.isdigit() else -1
    return f"{MONTH_NAMES[index][:3]} {year[2:]}" if 0 <= index < 12 else str(month)


# Megh Steel's own quarterly working. Four OEMs in one document, the OEM first, which is
# how the owner's workbook divides it into sheets. The claim columns carry nothing until
# Megh's base-price master is a held input; the note beside `MEGH_RECO_COST` says why.
MEGH_RECO_DETAIL_COLUMNS = [
    {"label": "OEM", "field": "oem"},
    {"label": "Invoice", "field": "invoice_no"},
    {"label": "Item", "field": "billing_item"},
    {"label": "Plant", "field": "plant", "kind": "plant"},
    {"label": "Material code", "field": "material_code"},
    {"label": "Description", "field": "description"},
    {"label": "Sales unit", "field": "sales_unit"},
    {"label": "Qty nos", "field": "qty_nos", "kind": "num", "add": True},
    {"label": "Qty M", "field": "qty_m", "kind": "num", "add": True},
    {"label": "Qty KG", "field": "qty_kg", "kind": "num", "add": True},
    {"label": "Charged INR/kg", "field": "charged_rate_per_kg", "kind": "num"},
    {"label": "Contract key", "field": "contract_key"},
    {"label": "Contract INR/MT", "field": "contract_base_per_mt", "kind": "num"},
    {"label": "CN/DN", "field": "cn_dn"},
]

# The quarterly price-difference working, as the panel shows it. The three quantity
# columns are summed and the rate is not: a column of rates added together is a number
# that means nothing, and this document is copied into a claim.
RECO_DETAIL_COLUMNS = [
    {"label": "Invoice", "field": "invoice_no"},
    {"label": "Item", "field": "billing_item"},
    {"label": "Material code", "field": "material_code"},
    {"label": "Description", "field": "description"},
    {"label": "Sales unit", "field": "sales_unit"},
    {"label": "Qty nos", "field": "qty_nos", "kind": "num", "add": True},
    {"label": "Qty M", "field": "qty_m", "kind": "num", "add": True},
    {"label": "Qty KG", "field": "qty_kg", "kind": "num", "add": True},
    {"label": "Billing rate", "field": "billing_rate", "kind": "num"},
]
PRICE_BUILD_DETAIL_COLUMNS = [
    {"label": "Component", "field": "operation"},
    {"label": "INR / MT", "field": "inr_per_mt", "kind": "num"},
    {"label": "Weight kg/m", "field": "kg_per_m", "kind": "mt"},
    {"label": "INR / m", "field": "inr_per_m", "kind": "mt"},
    {"label": "Length m", "field": "length_m", "kind": "mt"},
    {"label": "INR / nos", "field": "qty", "kind": "qty"},
]
STR_SOURCE_DETAIL_COLUMNS = [
    {"label": "Plant", "field": "plant", "kind": "plant"},
    {"label": "FG material code", "field": "material_code"},
    {"label": "Description", "field": "description"},
    {"label": "Held for", "field": "holder"},
    {"label": "Source", "field": "source"},
    {"label": "Remark", "field": "remark"},
    {"label": "Suggested STR qty", "field": "str_qty", "kind": "mt"},
    {"label": "Available", "field": "qty", "kind": "qty"},
]
TREND_DETAIL_COLUMNS = [
    {"label": "Sold to", "field": "source"},
    {"label": "Bucket or month", "field": "sku"},
    {"label": "Customer", "field": "customer"},
    {"label": "Material codes", "field": "material_code"},
    # Both units on every trend card, so switching the tab between tonnes and pieces
    # never changes what a breakup says.
    {"label": "Pieces", "field": "nos", "kind": "num", "add": True},
    {"label": "Sales", "field": "qty", "kind": "qty"},
]
# One month of a customer's history for a single SKU, as the customer tracker's
# drill-down shows it. Deliberately month-first: the row is read down the months.
SKU_HISTORY_DETAIL_COLUMNS = [
    {"label": "Month", "field": "source"},
    {"label": "SKU", "field": "sku"},
    {"label": "Customer", "field": "customer"},
    {"label": "Material codes", "field": "material_code"},
    # A cut length is ordered in pieces and only weighed afterwards, so the tonnage alone
    # answers the wrong question: 12.197 MT of a 2.59 m piece is a number nobody schedules
    # against. Both are carried, and the pieces column is empty on a long-length row.
    {"label": "Pieces", "field": "nos", "kind": "num", "add": True},
    {"label": "Sales", "field": "qty", "kind": "qty"},
]
# Sign-off drill-down. Both halves on one line per plant, because the question the
# columns exist to answer — how much of this SKU's demand is firm — is read across them,
# not down one.
# A long-length bucket's billing history, month by month. Both parties are named rather
# than merged: an ancillary buying direct and Megh converting for TVS are different
# demands on the same size, and a month where one replaced the other is not a flat month.
LL_HISTORY_DETAIL_COLUMNS = [
    {"label": "Month", "field": "source"},
    {"label": "Bucket", "field": "sku"},
    # Both components total, and the two totals have to reconcile to the billed one.
    # `kind: "mt"` alone does not mean summable — it is also weight per metre and rupees
    # per metre, neither of which may be added — so summability is stated outright.
    {"label": "TVSM ancillaries", "field": "direct_mt", "kind": "mt", "add": True},
    {"label": "Megh Steel 943209", "field": "megh_mt", "kind": "mt", "add": True},
    {"label": "Billed", "field": "qty", "kind": "qty"},
]
SIGNOFF_DETAIL_COLUMNS = [
    {"label": "Plant", "field": "plant", "kind": "plant"},
    {"label": "Material code", "field": "material_code"},
    {"label": "Signed off", "field": "signed_mt", "kind": "qty"},
    {"label": "Not signed off", "field": "unsigned_mt", "kind": "qty"},
    {"label": "Order", "field": "qty", "kind": "qty"},
]
ORDER_DETAIL_COLUMNS = [
    {"label": "Plant", "field": "plant", "kind": "plant"},
    {"label": "Origin", "field": "origin"},
    {"label": "Type", "field": "kind"},
    {"label": "Order", "field": "order_no"},
    {"label": "Customer", "field": "customer"},
    {"label": "Material code", "field": "material_code"},
    {"label": "Code from", "field": "code_source"},
    {"label": "Description", "field": "description"},
    {"label": "Open basis", "field": "basis"},
    {"label": "Order age (days)", "field": "age_days", "kind": "num"},
    {"label": "Open quantity", "field": "qty", "kind": "qty"},
]
TRANSFER_DETAIL_COLUMNS = [
    {"label": "Batch", "field": "batch"},
    {"label": "From", "field": "source_plant_label"},
    {"label": "To", "field": "dest_plant_label"},
    {"label": "Invoice", "field": "document"},
    {"label": "Despatched", "field": "billing_date"},
    {"label": "GRN date", "field": "grn_date"},
    {"label": "Status", "field": "status"},
    {"label": "Marked for", "field": "mark_customer"},
    {"label": "Quantity", "field": "qty", "kind": "qty"},
]


def norm_desc(value):
    if pd.isna(value):
        return None
    return re.sub(r"\s+", " ", str(value).upper()).strip()


def norm_number(value, digits=4):
    if pd.isna(value):
        return None
    try:
        return f"{round(float(value), digits):g}"
    except (TypeError, ValueError):
        return norm_text(value)


THICKNESS_GROUPS = {
    1.00: 1.00, 1.01: 1.00, 1.02: 1.00,
    # 1.22 is a customer-written near-gauge, like 1.21 beside it: Bucketting governs 256
    # buckets at 1.20 and none at 1.21 or 1.22. Its absence meant Srikam, Rajsriya and
    # NMPL lines written at 1.22 met no bucket at all — 85,500 pieces on the August
    # schedule reaching no row rather than joining the 1.20 they are.
    1.20: 1.20, 1.21: 1.20, 1.22: 1.20,
    1.62: 1.60,   # Sandhar Technology writes 1.62; Bucketting governs only 1.6
    1.50: 1.60, 1.60: 1.60, 1.63: 1.60,
    1.90: 2.00, 1.95: 2.00, 2.00: 2.00, 2.03: 2.00,
    2.25: 2.25, 2.32: 2.25,
    2.30: 2.30, 2.34: 2.30,
    2.41: 2.50, 2.45: 2.50, 2.50: 2.50,
    2.60: 2.60, 2.65: 2.60,
    2.70: 2.80, 2.75: 2.80, 2.80: 2.80,
    3.00: 3.00, 3.02: 3.00,
    3.40: 3.50, 3.50: 3.50,
}


def norm_thickness(value):
    if pd.isna(value):
        return None
    try:
        rounded = round(float(value), 2)
        return norm_number(THICKNESS_GROUPS.get(rounded, rounded))
    except (TypeError, ValueError):
        return norm_text(value)


# Outside diameters customers write that name a diameter Bucketting governs under a
# different number. The same idea as THICKNESS_GROUPS and kept as a table for the same
# reason: the next one is a line, not a new branch. Both entries here are cases where
# Bucketting holds one value and nothing near it — 22.23 (never 22.2) and 41.28 (never
# 41.3) — so folding is recovering the size, not rounding it away.
OD_GROUPS = {
    22.20: 22.23, 22.23: 22.23,
    28.58: 28.58, 28.60: 28.58,
    37.90: 37.95, 37.95: 37.95,
    41.28: 41.28, 41.30: 41.28,
}


def norm_od(value):
    if pd.isna(value):
        return None
    try:
        rounded = round(float(value), 2)
        return norm_number(OD_GROUPS.get(rounded, rounded))
    except (TypeError, ValueError):
        return norm_text(value)


def norm_surface(value):
    text = norm_text(value)
    if text in {"AW", "AP", "HR"}:
        return "AW"
    if text in {"AN", "BH", "NR"}:
        return "AN"
    return text


def attr_key(od, inner_diameter, thickness, specification, end_finish, surface_finish):
    parts = [
        norm_od(od),
        norm_number(0 if pd.isna(inner_diameter) else inner_diameter),
        norm_thickness(thickness),
        norm_code(specification),
        norm_text(end_finish),
        norm_surface(surface_finish),
    ]
    if any(part is None for part in parts):
        return None
    return "|".join(parts)


def split_codes(value):
    if pd.isna(value):
        return []
    return [norm_code(part) for part in re.split(r"[|,/]", str(value)) if norm_code(part)]


def make_ctl_bucket(bucket, length_m):
    # A missing bucket arrives as NaN as often as it does as None, and `not nan` is
    # False, so testing truthiness alone builds the string "nan-0.46" — a CTL bucket
    # that passes validation, matches nothing, and takes its stock out of circulation
    # while every resolution count still reads 100%.
    if bucket is None or pd.isna(bucket) or not str(bucket).strip() or pd.isna(length_m):
        return None
    # A length that is present but not a number raised out of here, where a length that is
    # absent returns None one line above. Refusing both is the same decision: a CTL bucket
    # whose length cannot be read is the "nan-0.46" fault wearing different clothes — it
    # would pass validation, match nothing, and take its stock out of circulation.
    try:
        length = float(length_m)
    except (TypeError, ValueError):
        return None
    suffix = "1" if length >= 3.5 else norm_number(length, 4)
    return f"{bucket}-{suffix}"


def size_key(value):
    """Read OD, second dimension and thickness out of a bucket or contract key.

    Both are written `dim1-dim2-thickness…`, with the second dimension left empty or
    zero for a round tube. Returning it as `0.0` either way keeps the two sides of the
    join comparable, and the remaining parts come back so the caller can read the
    grade off a bucket or the variant suffix off a contract key.
    """
    parts = str(value or "").strip().split("-")
    if len(parts) < 3:
        return None
    # Buckets that carry a review note instead of a size ("check tdc for grade") reach
    # here too, so coerce rather than convert: a non-numeric part means no size.
    dim1, dim2, thickness = (
        pd.to_numeric(part.strip() or None, errors="coerce") for part in parts[:3]
    )
    if pd.isna(dim1) or pd.isna(thickness):
        return None
    return float(dim1), 0.0 if pd.isna(dim2) else float(dim2), float(thickness), parts


def fmt_nos(value):
    """Whole pieces, thousand-grouped, for text a planner reads on screen.

    `OverflowError` belongs in the guard beside the other two. An infinity passes
    `float()` and is then refused by `round()`, so a cell holding one raised out of a
    formatter whose whole job is to always produce something — and it raised in the
    middle of building a copy document, where the alternative to a number is not a
    traceback but the "0" this already returns for every other unusable cell.
    """
    try:
        return f"{round(float(value)):,}"
    except (TypeError, ValueError, OverflowError):
        return "0"


def norm_bucket(value):
    """A bucket as written on a sheet, reduced to the string everything else keys on.

    A single trailing space makes a bucket a different string that renders identically,
    so it silently becomes its own tracker row and its own pool. On the 30 July file the
    RM tracker's TVSM sheet wrote `25.4-0-2.5-ERW 1-FC ` on one row: 60.304 MT of TVSM
    sales sat on a phantom row of their own while the real bucket reported a 56 MT gap
    it had already dispatched. Non-breaking spaces arrive through the same cells and
    have to collapse the same way.

    Apply this wherever a bucket enters from a sheet, not only where one has been seen
    to be dirty — a bucket is a join key, and a join key that depends on typing is not
    a key at all.
    """
    if value is None or pd.isna(value):
        return None
    text = re.sub(r"\s+", " ", str(value).replace("\xa0", " ")).strip()
    return text or None


def bucket_vsm_key(bucket, length):
    """The Megh SKU key: a governed bucket with the finished length appended.

    This is the shape the `vsm stock` plan states in its own `length key` column, and
    every frame that joins to a Megh SKU has to build the same one. It replaces a key
    assembled as `OD-ID-thickness-length-grade-cuttype`, whose cut token was read off
    the bucket's end condition — so wherever the plan and Bucketting disagreed there,
    the key missed and the tonnage left the tab rather than landing on a SKU.
    """
    bucket = norm_bucket(bucket)
    if not bucket or pd.isna(length):
        return None
    rendered = norm_number(length, 4)
    if rendered is None:
        return None
    return f"{bucket}-{rendered}"


def norm_length_key(value):
    """The plan's own length key, corrected only where it could not otherwise join.

    The sheet stays as written; only the derived join key moves. Two corrections, both
    agreed with the owner:

    * whitespace collapses, so `25.4-0-2.5-ERW 1-FC -5.95` meets the key every other
      frame builds. A stray space makes a different string that renders identically —
      the same defect that once put 60.304 MT of sales on a phantom bucket row.
    * a trailing length above `VSM_LENGTH_MM_ABOVE_M` is millimetres. The plan writes
      572.5 beside 5.95 and 6.0, and stock, sales and WIP all normalise to metres, so
      as written such a row could never meet them.

    Anything whose last component is not a number comes back as written: a key that
    states no length is not one to invent a length for.
    """
    # `or ""` would not do: a float NaN is truthy, so an empty cell would come back as
    # the string "nan" and be published as though it were a key.
    if value is None or pd.isna(value):
        return None
    text = re.sub(r"\s+", " ", str(value).replace("\xa0", " ")).strip()
    if not text:
        return None
    text = re.sub(r"\s*-\s*", "-", text)
    head, _, tail = text.rpartition("-")
    if not head:
        return text
    length = pd.to_numeric(tail, errors="coerce")
    if pd.isna(length):
        return text
    if length > VSM_LENGTH_MM_ABOVE_M:
        length = length / 1000
    rendered = norm_number(length, 4)
    return f"{head}-{rendered}" if rendered is not None else text


def key_family(key):
    """The SKU key without its length component — §5e.1's key for "other length".

    Derived from the key itself rather than rebuilt from dimensions, so both sides of
    the join produce it the same way. For a governed size that is the bucket; for a
    `Megh-` size it is `Megh-OD-ID-thickness`, which is the honest answer — such a size
    has no governed bucket for other-length stock to be found under.
    """
    text = str(key or "")
    head, _, tail = text.rpartition("-")
    if head and pd.notna(pd.to_numeric(tail, errors="coerce")):
        return head
    return text or None


def sheet_total_rows(frame, key_column, value_columns, tolerance=0.001):
    """Index of a sheet's own grand-total rows.

    The RM tracker's `TVSM` sheet ends with one: no key, and `VSM Sales` and `VSM Stock`
    each repeating the whole column. Summing a column therefore counts everything twice
    — the sales-to-TVSM card read 1,981.672 MT where the truth is 990.836. Per-bucket
    figures were never affected, because those group on the key and the total row has
    none, which is exactly why it survived: only a whole-column sum sees it.

    Identified by what makes it a total rather than by where it sits: it carries no key
    and its value equals the sum of every other row in that column. The WIP dump's
    trailing subtotals are dropped on the same principle.
    """
    keyless = frame[key_column].map(norm_bucket).isna()
    found = pd.Series(False, index=frame.index)
    for column in value_columns:
        if column not in frame.columns:
            continue
        values = pd.to_numeric(frame[column], errors="coerce").fillna(0)
        rest = values.sum() - values
        found |= keyless & values.gt(0) & (values - rest).abs().le(tolerance)
    return frame.index[found]


def valid_bucket(value):
    if pd.isna(value):
        return False
    text = str(value).strip().upper()
    return (
        bool(text)
        and text not in {"NAN", "NONE", "NULL"}
        and "CHECK" not in text
        and "NO KEY" not in text
    )


DESCRIPTION_DIMENSIONS = re.compile(
    r"(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)(?:X(\d+(?:\.\d+)?))?\s*$"
)


def description_shape(description):
    """Read OD, ID and thickness out of a material description.

    Round sections read as OD x thickness x length, rectangular and square as
    width x height x thickness x length, so the token count decides the layout.
    """
    match = DESCRIPTION_DIMENSIONS.search(str(description or "").strip())
    if not match:
        return None
    first, second, third, fourth = match.groups()
    if fourth is None:
        return norm_od(first), norm_number(0), norm_thickness(second)
    return norm_od(first), norm_number(second), norm_thickness(third)


def shape_matches_bucket(description, bucket):
    """True when a description's dimensions agree with the bucket it was given.

    A material code whose governed bucket contradicts its own description cannot be
    trusted: the dump reuses one code across physically different materials.
    """
    shape = description_shape(description)
    parts = str(bucket or "").split("-")
    if shape is None or len(parts) < 3:
        return True
    return [str(v) for v in shape] == [parts[0], parts[1], parts[2]]


def blank_to_none(value):
    """A plan cell that says nothing, as None.

    Test every plan cell for NaN explicitly. NaN is truthy, so `if not sku` lets a row
    with no key through to become a dictionary key, and `vsm_bucket or None` keeps a NaN
    as the bucket — which then reads as governed and never reaches the assign-a-bucket
    queue. Same trap as the "nan-0.46" CTL buckets.

    Module level because the Megh tab's own rows need it too, and they are built before
    the length-bucketing block where it used to be a local.
    """
    return None if value is None or pd.isna(value) or not str(value).strip() else value


def first_unique(series):
    values = [v for v in series if pd.notna(v)]
    unique = list(dict.fromkeys(values))
    return unique[0] if len(unique) == 1 else None


def natural_bucket_key(value):
    parts = re.split(r"(\d+(?:\.\d+)?)", str(value or ""))
    return tuple(float(part) if re.fullmatch(r"\d+(?:\.\d+)?", part) else part.upper() for part in parts)


def sum_for_codes(grouped, codes, ctl_bucket, column):
    total = 0.0
    for code in codes:
        total += float(grouped.get((code, ctl_bucket), {}).get(column, 0) or 0)
    return total


def build_sources(input_dir: Path) -> Sources:
    """The dumps folder, with the three multi-sheet inputs expanded into slots."""
    return ExcelSources(
        input_dir,
        extra_slots=slots_for_families(ORDER_BOOK_SHEETS, PRICING_SHEETS, SIGNOFF_SHEETS),
    )


def main(input_dir: Path, output_dir: Path, as_of: str | None = None,
         sources: Sources | None = None, assignments: dict | None = None,
         pricing_overrides: dict | None = None):
    input_dir = input_dir.resolve()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    # Read before anything else is built, because it decides what a material code means
    # and every frame in this run joins on that. A caller may pass its own set — the
    # tests do — and then nothing is read and nothing is written.
    if assignments is None:
        assignments = load_bucket_assignments()
    if pricing_overrides is None:
        pricing_overrides = load_pricing_overrides()
    # Where the input frames come from. The dumps folder by default; `scripts/sources.py`
    # carries the read spec for every slot so that a second backend serves the same
    # frames without restating twenty-one sheet names and header rows.
    src = sources if sources is not None else build_sources(input_dir)
    # A month-neutral slot name. It used to be `july0626_rm_tracker_v1.xlsx`, which by
    # August held August demand on a sheet called Schedule August — a filename asserting
    # the wrong month, and one that could not be archived into a July folder without
    # taking the current month's workbook with it. Which file filled the slot is recorded
    # in dumps/README.md, not in the name.
    bucket_map = src.frame("bucketting")
    oem = src.frame("oem_key")
    # Pick the sheet for the month being published; fall back to whatever single
    # `Schedule <Month>` sheet the workbook has if that exact one is absent.
    as_of_month_name = (
        pd.Timestamp(as_of) if as_of else pd.Timestamp(datetime.now(timezone.utc).date())
    ).strftime("%B")
    available = src.sheet_names("schedule")
    wanted = f"{SCHEDULE_SHEET_PREFIX}{as_of_month_name}"
    month_sheets = [
        name for name in available
        if name.startswith(SCHEDULE_SHEET_PREFIX)
        and name[len(SCHEDULE_SHEET_PREFIX):] in MONTH_NAMES
    ]
    if wanted in available:
        schedule_sheet = wanted
    elif len(month_sheets) == 1:
        schedule_sheet = month_sheets[0]
    elif SCHEDULE_SHEET_FALLBACK in available:
        schedule_sheet = SCHEDULE_SHEET_FALLBACK
    else:
        raise SystemExit(
            f"No schedule sheet found. Wanted {wanted!r}; the workbook has {month_sheets}"
        )
    schedule = src.frame("schedule", sheet=schedule_sheet)
    # Every real row names a customer. Bounding on that rather than a row count means the
    # sheet can grow — it went from 742 rows to 748 between two workbooks, and a fixed
    # slice would have silently dropped the six new lines.
    schedule = schedule[schedule["Helper Customer"].notna()].copy()
    schedule_month = MONTH_NAMES.index(schedule_sheet[len(SCHEDULE_SHEET_PREFIX):]) + 1 \
        if schedule_sheet[len(SCHEDULE_SHEET_PREFIX):] in MONTH_NAMES else None
    schedule_supplement_rows = 0
    if src.available("schedule_supplement"):
        supplement = src.frame("schedule_supplement")
        missing_columns = set(schedule.columns) - set(supplement.columns)
        if missing_columns:
            raise SystemExit(
                f"{SCHEDULE_SUPPLEMENT_FILE} is missing schedule columns: "
                f"{sorted(missing_columns)}"
            )
        schedule_supplement_rows = int(len(supplement))
        schedule = pd.concat([schedule, supplement[schedule.columns]], ignore_index=True)
    # Every TSL sales line the source can reach, each line once, keyed on billing
    # document and item. One ledger rather than a daily dump plus three archives: a
    # billed line is a fact with a date on it, so sales accumulates where every other
    # dump supersedes. `Sources.sales_ledger` is where that is assembled and why.
    #
    # Material-code columns are read as text — the reason is on the `_sales_like` spec
    # in `scripts/sources.py`, beside the pin that enforces it.
    sales_ledger = src.sales_ledger()
    # An empty ledger is stopped here, where it can still be explained.
    #
    # Left to run, it surfaces 300 lines further on as `KeyError: 'CUSTOMER  CD'` — a
    # column present in every sales file, which was never the problem. The frame simply
    # had no columns at all. Same principle as `SupabaseRowCountMismatch`: a read that
    # came back wrong must not reach the pipeline, and must say which read it was.
    if sales_ledger.empty:
        raise SystemExit(
            "No sales lines. The ledger is empty, so every sales figure on every tab "
            "would read zero — this stops rather than publishing a dashboard of "
            "nothing. On the Postgres backend it means absorption has not run: "
            "`PostgresSources.absorb_sales()` is what fills `tsl_sales` from the "
            "uploaded batches, and `refresh_from_supabase.py` calls it before the "
            "pipeline. Reading `dumps/`, it means no sales extract was found."
        )
    # The month being published, taken out of the ledger rather than read from its own
    # file. It is the same set of lines the daily dump held — that dump covers exactly one
    # month — less the sheet's own grand total row, which has no billing document and so
    # never enters the ledger. Everything month-scoped downstream reads this.
    ledger_month = (
        pd.to_datetime(sales_ledger["BILLING  DATE"], errors="coerce")
        .dt.strftime("%Y-%m") if not sales_ledger.empty else pd.Series(dtype=str)
    )
    published_month = (
        pd.Timestamp(as_of) if as_of else pd.Timestamp(datetime.now(timezone.utc).date())
    ).strftime("%Y-%m")
    sales = sales_ledger[ledger_month.eq(published_month)].copy()
    # Kept unenriched for the code repository, which reads the raw invoice columns and
    # must not inherit the schedule-matching frame's later transformations.
    sales_raw = sales.copy()
    stock = src.frame("stock")
    wip = src.frame("wip")
    wip.columns = [str(c).replace("\xa0", " ") for c in wip.columns]
    rfd = src.frame("rfd")
    # ZMAT is the single material master. A material-mapping extract covering
    # descriptions it lacks is merged into this file by
    # `scripts/merge_material_mapping.py` and then discarded — never read here as a
    # second source, which would mean filtering and reasoning about two files on every
    # run to answer one question.
    zmat = src.frame("zmat")
    vsm = src.frame("vsm_tvsm")
    # Drop the sheet's own grand total before anything sums a column off it.
    vsm_total_rows = sheet_total_rows(
        vsm, "key", ("VSM Requirement", "VSM Sales", "VSM Stock")
    )
    vsm_totals_dropped = [
        {
            column: (
                None if pd.isna(vsm.at[i, column])
                else round(float(pd.to_numeric(vsm.at[i, column], errors="coerce") or 0), 3)
            )
            for column in ("VSM Requirement", "VSM Sales", "VSM Stock")
        }
        for i in vsm_total_rows
    ]
    vsm = vsm.drop(index=vsm_total_rows)
    receivables = src.frame_or_empty("receivables")
    # An optional longer sales window. The daily sales dump is the current month only,
    # which is too short to see every code a customer has been billed under, so the
    # code repository reads this file when it is supplied and the daily dump otherwise.
    sales_history = src.frame_or_empty("sales_history")
    # What the trend is built from, for the run summary. The frames themselves are no
    # longer read here: every one of them is already in the ledger, which is what the
    # trend now reads. The slots stay in the registry because they are still how an
    # archive is *uploaded*; this only reports which ones contributed.
    trend_sources = [
        {"file": filename, "rows": int(len(src.frame(Path(filename).stem)))}
        for filename in SALES_TREND_FILES
        if src.available(Path(filename).stem)
    ]
    # Order book from the sales-planning consolidation: three sheets, one per despatching
    # origin, each with its own quantity column. Optional, like the other planning files.
    # Each sheet of the order book and the contract is its own slot; the code columns
    # read as text for the same reason sales does, declared once on the slot.
    order_sheets = {
        sheet: src.frame(f"orders:{sheet}")
        for sheet in ORDER_BOOK_SHEETS
        if src.available(f"orders:{sheet}")
    }
    contract_sheets = {
        route: src.frame(f"contract:{route}")
        for route in PRICING_SHEETS
        if src.available(f"contract:{route}")
    }
    transfers_raw = src.frame_or_empty("transfers")

    # 1. Build the governed material dimension.
    bucket_map["material_key"] = bucket_map["Material Codes"].map(norm_code)
    bucket_map["Bucket"] = bucket_map["Bucket"].map(norm_bucket)
    bucket_map["CTL Bucket"] = bucket_map["CTL Bucket"].map(norm_bucket)
    bucket_map = bucket_map[bucket_map["Bucket"].map(valid_bucket)].copy()
    direct = (
        bucket_map.sort_values("material_key")
        .drop_duplicates("material_key")
        .set_index("material_key")[["Bucket", "LL or CTL", "CTL Bucket", "Length"]]
    )

    zmat["material_key"] = zmat["Column1"].map(norm_code)
    zmat["description_key"] = zmat["MATERIAL DESCRIPTION"].map(norm_desc)
    zmat["attr_key"] = zmat.apply(
        lambda r: attr_key(
            r["OUTER DIAMETER OF MATERIAL"],
            r["INNER DIAMETER OF MATERIAL"],
            r["THICKNESS FOR TATA TUBES MATERIAL"],
            r["MATERIAL SPECIFICATION"],
            r["MATERIAL END FINISH"],
            r["MATERIAL SURFACE FINISH"],
        ),
        axis=1,
    )
    zmat = zmat.drop_duplicates(
        subset=[
            "material_key", "description_key", "attr_key",
            "LENGTH FOR TATA TUBES MATERIAL (WITH 4 D",
        ]
    )

    trained = zmat[["material_key", "attr_key"]].merge(
        direct.reset_index()[["material_key", "Bucket"]],
        on="material_key",
        how="inner",
    )
    attr_candidates = trained.dropna(subset=["attr_key", "Bucket"]).groupby("attr_key")["Bucket"].agg(first_unique)
    attr_candidates = attr_candidates.dropna()

    zmat["inferred_bucket"] = zmat["attr_key"].map(attr_candidates)
    zmat["direct_bucket"] = zmat["material_key"].map(direct["Bucket"])
    zmat["resolved_bucket"] = zmat["direct_bucket"].fillna(zmat["inferred_bucket"])

    material_bucket = zmat.groupby("material_key")["resolved_bucket"].agg(first_unique).dropna()

    # The owner's own assignments, applied last so they win.
    #
    # This is the single place a material code becomes a bucket — every tracker, every
    # stock frame and every queue joins through this Series — so overriding it here is
    # what makes an answer given on the Missing mappings tab actually move tonnage onto a
    # tracker. It is deliberately an override rather than a fallback: a code the master
    # resolves *wrongly* is exactly the case somebody is correcting, and a fallback would
    # silently ignore them.
    owner_assignments = (assignments or {}).get("bucket", {})
    for code, bucket in owner_assignments.items():
        material_bucket.loc[code] = bucket
    if owner_assignments:
        print(f"  assignments: {len(owner_assignments)} material codes assigned by the owner")
    material_length = (
        zmat.groupby("material_key")["LENGTH FOR TATA TUBES MATERIAL (WITH 4 D"]
        .agg(first_unique)
        .dropna()
    )
    description_bucket = zmat.groupby("description_key")["resolved_bucket"].agg(first_unique).dropna()
    # Recovers a true material code from a description. The WIP dump zeroes the final
    # digit of every material number, the same defect the sales file has, so its codes
    # cannot be trusted or joined on directly.
    description_material = (
        zmat.groupby("description_key")["material_key"].agg(first_unique).dropna()
    )
    # Every code a description is extended under. Where there is more than one, no code
    # can be recovered — naming one arbitrarily could raise a transfer on the wrong
    # material — but the candidates are worth quoting rather than showing a blank.
    description_materials = (
        zmat.dropna(subset=["description_key", "material_key"])
        .groupby("description_key")["material_key"]
        .agg(lambda codes: sorted(set(codes)))
    )
    description_length = (
        zmat.groupby("description_key")["LENGTH FOR TATA TUBES MATERIAL (WITH 4 D"]
        .agg(first_unique)
        .dropna()
    )

    # Finished-goods codes indexed by description, and by description and plant. A
    # description is extended under several codes and only some of them exist at a
    # given plant, so the plant index is what turns a mother tube into a code the
    # despatching plant can actually raise an STR on.
    fg_zmat = zmat[
        zmat["MATERIAL TYPE"].astype(str).str.upper().eq(FG_MATERIAL_TYPE)
    ].copy()
    fg_zmat["plant_key"] = fg_zmat["PLANT"].map(norm_code)
    fg_codes_by_description = (
        fg_zmat.dropna(subset=["description_key", "material_key"])
        .groupby("description_key")["material_key"]
        .agg(lambda s: sorted(set(s)))
        .to_dict()
    )
    fg_codes_by_description_plant = (
        fg_zmat.dropna(subset=["description_key", "material_key", "plant_key"])
        .groupby(["description_key", "plant_key"])["material_key"]
        .agg(lambda s: sorted(set(s)))
        .to_dict()
    )

    # The material dimension, written out when asked for. Never on the build's path.
    #
    # These maps are where a material code becomes a bucket, and every tracker, stock frame
    # and queue joins through them — but none of them is published, so the only way to see
    # one is through a section built on top of it, by which point a disagreement has already
    # been folded into a tonnage. The TypeScript port needs to be held to them directly and
    # completely rather than inferred from downstream figures, and this is what lets a check
    # enumerate every key instead of sampling the ones a section happened to touch.
    if os.environ.get("DUMP_MATERIAL_DIMENSION"):
        Path(os.environ["DUMP_MATERIAL_DIMENSION"]).write_text(json.dumps({
            "material_bucket": _plain(material_bucket.to_dict()),
            "material_length": _plain(material_length.to_dict()),
            "description_bucket": _plain(description_bucket.to_dict()),
            "description_material": _plain(description_material.to_dict()),
            "description_materials": _plain(description_materials.to_dict()),
            "description_length": _plain(description_length.to_dict()),
            "fg_codes_by_description": _plain(fg_codes_by_description),
            # A tuple key cannot be JSON, so the pair is joined the way a detail key is.
            "fg_codes_by_description_plant": {
                f"{d}|{p}": _plain(codes)
                for (d, p), codes in fg_codes_by_description_plant.items()
            },
            "direct": _plain(direct.to_dict(orient="index")),
        }))
        print(f"  material dimension written to {os.environ['DUMP_MATERIAL_DIMENSION']}")

    def fg_code_for_mother_tube(description_key, plant, bucket):
        """Finished-goods code an STR can be raised on for a mother-tube description.

        Returns (code, fg_description). Both are None when the swapped description is
        not in zmat, which is how a mother tube with no finished equivalent is told
        apart from one that simply has no stock.
        """
        text = str(description_key or "")
        if not text.startswith(WIP_DESCRIPTION_PREFIX):
            return None, None
        fg_key = FG_DESCRIPTION_PREFIX + text[len(WIP_DESCRIPTION_PREFIX):]
        candidates = list(fg_codes_by_description_plant.get((fg_key, plant), []))
        if not candidates:
            candidates = list(fg_codes_by_description.get(fg_key, []))
        if not candidates:
            return None, None
        # Prefer a code whose governed bucket agrees with the mother tube's, then take
        # the lowest code so repeated runs pick the same one.
        governed = [code for code in candidates if material_bucket.get(code) == bucket]
        return sorted(governed or candidates, key=lambda c: (len(c), c))[0], fg_key

    # 2. Map sales. Material number is unusable as a primary key because every value
    # in this extract ends in zero; description/attribute mapping is therefore primary.
    oem["customer_name_key"] = oem["Customer "].map(norm_text)
    oem_map = dict(zip(oem["customer_name_key"], oem["OEM"]))

    # The owner's own OEM assignments, applied last so they win — the same arrangement as
    # the bucket assignments above, and load-bearing for the same reason. This dict is the
    # single place a customer name becomes an OEM: `derive_sales` reads it for every sales
    # line, the schedule reads it twice, stock, receivables, the code repository and the
    # trend all read it. So this is the one point at which an answer given on the Missing
    # mappings tab can reach the figures at all — without it the queue would accept a
    # customer's OEM, show it saved, and change nothing anywhere.
    #
    # Keyed through `norm_text` on both sides. The queue records the customer name exactly
    # as the dump spells it, and every consumer looks the name up normalised; assigning on
    # the raw spelling would file a decision under a key nothing ever asks for.
    owner_oem = (assignments or {}).get("oem", {})
    for customer, oem_name in owner_oem.items():
        key = norm_text(customer)
        if key and oem_name:
            oem_map[key] = oem_name
    if owner_oem:
        print(f"  assignments: {len(owner_oem)} customers assigned an OEM by the owner")

    def derive_sales(frame):
        """Every column the rest of the pipeline expects on a sales frame.

        The quarterly history arrives in the daily dump's own 225-column layout, so it
        is mapped by this same function rather than a parallel one. A trend that
        disagreed with the month it overlaps would be worse than no trend.
        """
        frame = frame.copy()
        frame["customer_key"] = frame["CUSTOMER  CD"].map(norm_code)
        frame["customer_name_key"] = frame["CUSTOMER  NAME"].map(norm_text)
        frame["description_key"] = frame["Material   Description"].map(norm_desc)
        frame["material_key"] = frame["MATERAIL NUMBER"].map(norm_code)
        frame["bucket"] = frame["description_key"].map(description_bucket)
        frame["bucket"] = frame["bucket"].fillna(
            frame["material_key"].map(material_bucket)
        )
        frame["length_m"] = frame["description_key"].map(description_length)
        frame["length_m"] = frame["length_m"].fillna(
            pd.to_numeric(frame["Length for TATA Tubes Material"], errors="coerce")
        )
        frame["ctl_bucket"] = [
            make_ctl_bucket(bucket, length)
            for bucket, length in zip(frame["bucket"], frame["length_m"])
        ]
        # Preserve the direct OEM-key result separately from later classification
        # overrides. Customer mapping exceptions must be based on whether the customer
        # exists in OEM_key_1_rev codes, not on a material-driven Boiler override.
        frame["oem_key_oem"] = frame["customer_name_key"].map(oem_map)
        frame["OEM"] = frame["oem_key_oem"]
        frame["material_group_key"] = (
            frame["MATERIAL GROUP"].astype(str).str.strip().str.upper()
        )
        boiler_material = frame["material_group_key"].str.contains(
            r"(?:BOT|COR|AHT)$", regex=True, na=False
        )
        frame.loc[boiler_material, "OEM"] = "Boiler"
        frame["sales_nos"] = pd.to_numeric(frame["qty in no"], errors="coerce").fillna(0)
        frame["sales_m"] = pd.to_numeric(
            frame["Domain for z_qty_meter"], errors="coerce"
        ).fillna(0)
        frame["sales_mt"] = (
            pd.to_numeric(frame["Quantity"], errors="coerce").fillna(0) / 1000
        )
        frame["billing_month"] = pd.to_datetime(
            frame["BILLING  DATE"], errors="coerce"
        ).dt.to_period("M").astype(str).replace("NaT", None)
        return frame

    # Derived once, over every line the ledger holds, and sliced afterwards. The whole
    # window and the published month must be mapped by the same function — a trend that
    # disagreed with the month it overlaps would be worse than no trend — and deriving
    # once is what makes that structural rather than a thing to remember.
    sales_all = derive_sales(sales_ledger)
    sales = sales_all[sales_all["billing_month"].eq(published_month)]

    sales_agg_df = (
        sales.dropna(subset=["customer_key", "ctl_bucket"])
        .groupby(["customer_key", "ctl_bucket"], as_index=False)
        .agg(
            sales_nos=("sales_nos", "sum"),
            sales_m=("sales_m", "sum"),
            sales_mt=("sales_mt", "sum"),
            sales_rows=("sales_mt", "size"),
        )
    )
    sales_lookup = {
        (r.customer_key, r.ctl_bucket): {
            "sales_nos": r.sales_nos,
            "sales_m": r.sales_m,
            "sales_mt": r.sales_mt,
            "sales_rows": r.sales_rows,
        }
        for r in sales_agg_df.itertuples()
    }
    # Which OEM a customer code belongs to, read across the whole sales history rather
    # than the current month. A code's OEM does not change from month to month, but the
    # daily dump only covers the month in progress — so on 3 August it held three days
    # and 125 lines, most schedule customers had not bought yet, and schedule OEM
    # resolution fell to 66.75% against a 99% publication gate. Nothing was wrong with
    # the data: the derivation assumed a populated month. The quarterly extracts already
    # in hand carry the same code/OEM pairs over six months, so read them too and the
    # mapping stops depending on where in the month the refresh runs. The ledger is that
    # whole window, so this is simply all of it. Order does not enter into it:
    # `first_unique` answers only where a code has exactly one OEM across every line, and
    # returns nothing on a genuine conflict, which is the point.
    code_oem = (
        sales_all
        .dropna(subset=["customer_key", "OEM"])
        .groupby("customer_key")["OEM"]
        .agg(first_unique)
        .dropna()
        .to_dict()
    )

    # Sales-order lookup for the dispatch plan. The sales material number cannot be
    # joined directly (its final digit is systematically zero), so match on the
    # governed CTL bucket instead, preferring the same customer's own earlier order.
    sales_orders = sales.copy()
    sales_orders["so_number"] = sales_orders["SO/STR No"].map(
        lambda v: None if pd.isna(v) else str(int(v))
    )
    sales_orders["supply_plant"] = sales_orders["Supply Plant."].map(norm_code)
    sales_orders["invoice_date"] = pd.to_datetime(
        sales_orders["BILLING  DATE"], errors="coerce"
    )
    # Last invoice wins — the loop below overwrites — so the sort decides which SO and
    # despatch plant a schedule line is offered. `kind="stable"` because the default is
    # quicksort, which is not: several invoices share a date, and their order among
    # themselves would then be decided by however the sales frame happened to be
    # assembled. That was invisible while sales came from one file in file order; the
    # ledger settles its own order, and this is what carries that through.
    sales_orders = (
        sales_orders.dropna(subset=["so_number", "ctl_bucket"])
        .sort_values("invoice_date", kind="stable")
    )
    so_by_customer_ctl, so_by_ctl_plant, so_by_ctl = {}, {}, {}
    so_by_customer_material, so_by_material = {}, {}
    for r in sales_orders.itertuples():
        value = (r.so_number, r.supply_plant, r.material_key)
        so_by_customer_ctl[(r.customer_key, r.ctl_bucket)] = value
        so_by_ctl_plant[(r.ctl_bucket, r.supply_plant)] = value
        so_by_ctl[r.ctl_bucket] = value
        if r.material_key:
            so_by_customer_material[(r.customer_key, r.material_key)] = value
            so_by_material[r.material_key] = value

    # The sales mapping, written out when asked for. Never on the build's path — the same
    # arrangement, and for the same reason, as the material dimension above: none of these
    # is published, so the only way to see one is through a figure already derived from it.
    if os.environ.get("DUMP_SALES_MAPS"):
        def _pair(mapping):
            """A tuple-keyed lookup as JSON, joined the way a detail key is."""
            return {
                "|".join("" if k is None or (isinstance(k, float) and pd.isna(k)) else str(k)
                         for k in key): _plain(value)
                for key, value in mapping.items()
            }

        Path(os.environ["DUMP_SALES_MAPS"]).write_text(json.dumps({
            "published_month": published_month,
            "ledger_rows": int(len(sales_all)),
            "published_rows": int(len(sales)),
            "sales_lookup": _pair(sales_lookup),
            "code_oem": _plain(code_oem),
            "so_by_customer_ctl": _pair(so_by_customer_ctl),
            "so_by_ctl_plant": _pair(so_by_ctl_plant),
            "so_by_ctl": _plain(so_by_ctl),
            "so_by_customer_material": _pair(so_by_customer_material),
            "so_by_material": _plain(so_by_material),
        }))
        print(f"  sales maps written to {os.environ['DUMP_SALES_MAPS']}")

    # 3. Create schedule-line facts and join sales by customer code + CTL bucket.
    schedule["schedule_qty"] = pd.to_numeric(schedule["SCHEDULE in nos"], errors="coerce").fillna(0)
    schedule = schedule[schedule["schedule_qty"] > 0].copy()
    schedule["schedule_mt"] = pd.to_numeric(schedule["SCHEDULE IN MT"], errors="coerce")
    schedule["schedule_mt"] = schedule["schedule_mt"].fillna(
        (
            math.pi
            * (
                pd.to_numeric(schedule["ACTUAL OD"], errors="coerce")
                - pd.to_numeric(schedule["TICKNESS"], errors="coerce")
            )
            * pd.to_numeric(schedule["TICKNESS"], errors="coerce")
            * pd.to_numeric(schedule["LENGTH"], errors="coerce")
            * 7.85
            / 1_000_000
            * schedule["schedule_qty"]
            / 1000
        )
    )
    schedule["customer_codes"] = schedule["CUSTOMER CODE"].map(split_codes)
    schedule["OEM"] = schedule["customer_codes"].map(
        lambda codes: first_unique(pd.Series([code_oem.get(code) for code in codes]))
    )
    schedule["helper_customer"] = schedule["Helper Customer"].astype(str).str.strip()
    schedule["OEM"] = schedule["OEM"].fillna(
        schedule["Helper Customer"].map(norm_text).map(oem_map)
    )
    schedule["OEM"] = schedule["OEM"].fillna(
        schedule["CUSTOMER NAME"].map(norm_text).map(oem_map)
    )
    schedule["uom"] = schedule["UoM"].astype(str).str.strip().str.upper()
    schedule["customer_display"] = schedule["helper_customer"]
    schedule["bucket"] = schedule["Bucket"].map(norm_bucket)
    schedule["ctl_bucket"] = schedule["CTL Bucket"].map(norm_bucket)
    schedule["material_key"] = schedule["MATERIAL NO"].map(norm_code)
    # Schedule July leaves some lines with no Bucket even though they name a material
    # code. Bucketting governs that code, so recover the bucket and its cut length from
    # there rather than dropping the demand. The sheet's own value always wins.
    recovered = schedule["material_key"].map(material_bucket)
    schedule["bucket"] = schedule["bucket"].where(
        schedule["bucket"].map(valid_bucket), recovered
    )
    recovered_ctl = schedule["material_key"].map(direct["CTL Bucket"])
    recovered_ctl = recovered_ctl.where(
        recovered_ctl.map(valid_bucket),
        [
            make_ctl_bucket(bucket, length)
            for bucket, length in zip(
                recovered, schedule["material_key"].map(material_length)
            )
        ],
    )
    schedule["ctl_bucket"] = schedule["ctl_bucket"].where(
        schedule["ctl_bucket"].map(valid_bucket), recovered_ctl
    )
    schedule["customer_codes_key"] = schedule["customer_codes"].map(lambda x: "|".join(x))

    group_cols = [
        "OEM", "customer_display", "customer_codes_key", "bucket",
        "ctl_bucket", "uom", "Plant",
    ]
    # Physical dimensions and the material number ride along for the dispatch plan.
    for source, target in (
        ("ACTUAL OD", "actual_od"), ("OD", "od"), ("ID", "inner_d"),
        ("TICKNESS", "thickness"), ("LENGTH", "ctl_length"),
    ):
        schedule[target] = pd.to_numeric(schedule[source], errors="coerce")
    schedule_group = (
        schedule.groupby(group_cols, dropna=False, as_index=False)
        .agg(
            schedule_qty=("schedule_qty", "sum"),
            schedule_mt=("schedule_mt", "sum"),
            actual_od=("actual_od", "max"),
            od=("od", "max"),
            inner_d=("inner_d", "max"),
            thickness=("thickness", "max"),
            ctl_length=("ctl_length", "max"),
            material_key=("material_key", first_unique),
        )
    )
    schedule_group["customer_codes"] = schedule_group["customer_codes_key"].map(
        lambda value: [code for code in str(value).split("|") if code]
    )
    schedule_group["sales_qty"] = schedule_group.apply(
        lambda r: sum_for_codes(
            sales_lookup,
            r["customer_codes"],
            r["ctl_bucket"],
            "sales_m" if r["uom"] == "M" else "sales_nos",
        ),
        axis=1,
    )
    schedule_group["sales_mt"] = schedule_group.apply(
        lambda r: sum_for_codes(sales_lookup, r["customer_codes"], r["ctl_bucket"], "sales_mt"),
        axis=1,
    )
    schedule_group["balance_qty"] = schedule_group["schedule_qty"] - schedule_group["sales_qty"]
    schedule_group["balance_mt"] = schedule_group["schedule_mt"] - schedule_group["sales_mt"]
    schedule_group["open_balance_mt"] = schedule_group["balance_mt"].clip(lower=0)
    schedule_group["over_dispatch_mt"] = (-schedule_group["balance_mt"]).clip(lower=0)

    # The grouped schedule, written out when asked for. Never on the build's path.
    if os.environ.get("DUMP_SCHEDULE_GROUP"):
        Path(os.environ["DUMP_SCHEDULE_GROUP"]).write_text(json.dumps({
            "rows": int(len(schedule_group)),
            "group": _plain(schedule_group.to_dict(orient="records")),
        }))
        print(f"  schedule group written to {os.environ['DUMP_SCHEDULE_GROUP']}")

    # 4. Map current stock.
    stock["material_key"] = stock["Material"].map(norm_code)
    stock["bucket"] = stock["material_key"].map(material_bucket)
    stock["description_key"] = stock["Material Description"].map(norm_desc)
    stock["bucket"] = stock["bucket"].fillna(stock["description_key"].map(description_bucket))
    stock["length_m"] = pd.to_numeric(stock["LENGTH"], errors="coerce")
    stock["ctl_bucket"] = [
        make_ctl_bucket(bucket, length)
        for bucket, length in zip(stock["bucket"], stock["length_m"])
    ]
    stock["stock_nos"] = pd.to_numeric(stock["NOS"], errors="coerce").fillna(0)
    # At 4731 and 8406 the NOS column repeats KG on every row — SAP holds those two
    # locations in weight only, so the "piece count" there is kilograms wearing the
    # wrong label. Flag it rather than publish a number that reads as pieces: 3910648
    # showed 6,123 "nos" against 3,000 real pieces in RFD.
    stock["nos_is_weight"] = (
        stock["stock_nos"].round(3)
        == pd.to_numeric(stock["KG"], errors="coerce").fillna(0).round(3)
    ) & (stock["stock_nos"] > 0)
    stock["stock_mt"] = pd.to_numeric(stock["MT"], errors="coerce").fillna(0)
    stock["Plant"] = stock["Plant"].map(norm_code)
    stock["customer_name_key"] = stock["CUSTOMER NAME"].map(norm_text)
    stock["OEM"] = stock["customer_name_key"].map(oem_map)
    # Stock held by the TVS proxy customer (943209, Megh Steels - TVS A) belongs to
    # the TVS pool even though the OEM key classifies that customer as Direct.
    # Pool attribution is kept separate from stock["OEM"] so the sales-by-OEM view
    # keeps reporting the OEM key result unchanged.
    stock["pool_oem"] = stock["OEM"].mask(
        stock["customer_name_key"].isin(TVS_PROXY_CUSTOMER_NAMES), "TVS"
    )
    # Transit rows carry no owning customer, so they form a shared bucket-level pool
    # rather than customer-owned stock. PLANT STOCKS is the only sheet used, so the
    # plant shown is the one the stock is booked against; PLANT STOCKS carries no
    # despatch-plant column (Storage location is uniformly R001 for these rows).
    stock["is_transit"] = stock["customer_name_key"].eq(TRANSIT_CUSTOMER_NAME)
    # High-age stock is judged at month end, so carry each row's ageing forward from
    # the as-of date to the last day of that month before applying the threshold.
    as_of_date = pd.Timestamp(as_of) if as_of else pd.Timestamp(datetime.now(timezone.utc).date())
    month_end = as_of_date + pd.offsets.MonthEnd(0)
    days_to_month_end = int((month_end - as_of_date).days)
    stock["ageing_days"] = pd.to_numeric(stock["Ageing days"], errors="coerce").fillna(0)
    stock["ageing_days_month_end"] = stock["ageing_days"] + days_to_month_end
    stock["is_high_age"] = stock["ageing_days_month_end"] > HIGH_AGE_DAYS
    # Filled in below, once the RFD material set is known.
    stock["rfd_status"] = None

    # A long length is defined by finished length at or above 3.5 m. The CTL/LL flag
    # implements that rule, but it is not sufficient on its own: rows carrying a
    # length range in the description leave the LENGTH column at 0 while correctly
    # flagged LL. Take the union so neither signal can strand stock, and require both
    # signals to agree before treating a row as an exact-length CTL cut.
    stock_flag = stock["CTL/LL"].astype(str).str.upper().str.strip()
    is_long = stock_flag.eq("LL") | stock["length_m"].ge(LONG_LENGTH_MIN_M)
    # Customer CTL inventory has only two approved sources:
    # - plant-stock CTL rows from 0789
    # - RFD quantity from rfd_4731 for plant 4731
    ctl_stock = stock[
        ~is_long
        & stock_flag.eq("CTL")
        & stock["ctl_bucket"].notna()
        & stock["Plant"].eq("789")
        & ~stock["is_transit"]
    ].copy()
    ll_stock = stock[is_long & stock["bucket"].notna() & ~stock["is_transit"]]
    transit_stock = stock[is_long & stock["bucket"].notna() & stock["is_transit"]].copy()
    ctl_pool_789_mt = ctl_stock.groupby(["pool_oem", "ctl_bucket"], dropna=False)["stock_mt"].sum()
    ctl_pool_789_nos = ctl_stock.groupby(["pool_oem", "ctl_bucket"], dropna=False)["stock_nos"].sum()
    ll_pool = ll_stock.groupby(["pool_oem", "bucket", "Plant"], dropna=False)["stock_mt"].sum()

    # `CTL Code` holds one code, several codes separated by slashes, or a note such as
    # `6 M CODE`. Split it, keep the codes Bucketting governs, and carry every listed
    # code so the reconciliation can back all of them.
    rfd["ctl_codes"] = rfd["CTL Code"].map(split_codes)
    rfd["ctl_codes"] = rfd["ctl_codes"].map(
        lambda codes: [c for c in codes if re.fullmatch(r"\d+", str(c))]
    )
    rfd["material_key"] = rfd["ctl_codes"].map(
        lambda codes: next(
            (c for c in codes if c in material_bucket.index or c in direct.index),
            codes[0] if codes else None,
        )
    )
    rfd["bucket"] = rfd["material_key"].map(direct["Bucket"])
    rfd["bucket"] = rfd["bucket"].fillna(rfd["material_key"].map(material_bucket))
    rfd["length_m"] = rfd["material_key"].map(direct["Length"])
    rfd["length_m"] = rfd["length_m"].fillna(rfd["material_key"].map(material_length))
    rfd_length = pd.to_numeric(rfd["CTL "], errors="coerce")
    rfd["length_m"] = rfd["length_m"].fillna(
        rfd_length.where(rfd_length <= 10, rfd_length / 1000)
    )
    rfd["ctl_bucket"] = rfd["material_key"].map(direct["CTL Bucket"])
    rfd["ctl_bucket"] = rfd["ctl_bucket"].where(
        rfd["ctl_bucket"].map(valid_bucket),
        [
            make_ctl_bucket(bucket, length)
            for bucket, length in zip(rfd["bucket"], rfd["length_m"])
        ],
    )
    # The owner's own CTL assignments, applied last so they win.
    #
    # RFD is the one queue that does not resolve through `material_bucket`: it reads the
    # material master's own `CTL Bucket` column, two lines up. So a bucket assigned on any
    # other tab cannot reach these rows however correct it is, and until this existed the
    # RFD queue was the one queue with no way to answer it.
    #
    # Keyed on the listed `CTL Code`, because that is the code the queue publishes and so
    # the code the browser recorded the decision against. **A row whose `CTL Code` is blank
    # therefore cannot be answered from the dashboard** — 15 of the 60 positive rows on the
    # 28 July file. That is not a gap this can close: such a row names no code to hold a
    # decision, and the fix is to give it one in `rfd_4731.xlsx`. The queue says so rather
    # than offering a box that saves against nothing.
    ctl_assignments = (assignments or {}).get("ctl_bucket", {})
    if ctl_assignments:
        listed = rfd["CTL Code"].map(
            lambda value: None if pd.isna(value) else norm_code(str(value).strip())
        )
        rfd["ctl_bucket"] = listed.map(ctl_assignments).fillna(rfd["ctl_bucket"])
        print(f"  assignments: {len(ctl_assignments)} CTL codes assigned by the owner")
    rfd["stock_nos"] = pd.to_numeric(rfd["RFD Qty."], errors="coerce").fillna(0)
    rfd["stock_mt"] = pd.to_numeric(rfd["WEIGHT"], errors="coerce").fillna(0)

    # `CTL Code` is blank on a quarter of the RFD rows that carry stock — 15 of the 60
    # positive rows, 32.293 MT, on the 28 July file. Keying the reconciliation on that
    # column alone makes those rows invisible, which both hides their stock and tells
    # the matching SAP material to write itself off. The row still names its own size,
    # so recover the material from the OD, thickness and cut length it does carry, by
    # matching it against the 4731 CTL materials SAP actually holds.
    sap_4731_ctl = stock[
        stock["Plant"].eq("4731")
        & stock["CTL/LL"].astype(str).str.strip().str.upper().eq("CTL")
        & stock["material_key"].notna()
    ].copy()
    sap_4731_ctl["shape"] = sap_4731_ctl["Material Description"].map(description_shape)
    dimension_materials = {}
    for _, s in sap_4731_ctl.iterrows():
        shape = s["shape"]
        if shape is None or pd.isna(s["length_m"]):
            continue
        key = (str(shape[0]), str(shape[1]), str(shape[2]), round(float(s["length_m"]), 3))
        dimension_materials.setdefault(key, set()).add(s["material_key"])

    def rfd_dimensions(row):
        """OD, ID and thickness of an RFD row.

        A rectangular row puts its two outer dimensions in `Section` (`40X30`) and
        leaves `OD` holding the equivalent round diameter, so `Section` is the only
        place the real size appears. A round row has no second dimension, which the
        rest of the pipeline writes as zero.
        """
        section = re.split(r"[X*x]", str(row["Section"] or "").strip())
        if len(section) == 2:
            dim1 = pd.to_numeric(section[0], errors="coerce")
            dim2 = pd.to_numeric(section[1], errors="coerce")
            if pd.notna(dim1) and pd.notna(dim2) and dim1 > 0 and dim2 > 0:
                return norm_od(dim1), norm_number(dim2), norm_thickness(row["Thickness"])
        return norm_od(row["OD"]), norm_number(0), norm_thickness(row["Thickness"])

    rfd["backed_materials"] = None
    rfd_recovered = []
    for i, row in rfd.iterrows():
        if row["stock_nos"] <= 0 or valid_bucket(row["ctl_bucket"]):
            continue
        length = row["length_m"]
        if pd.isna(length):
            continue
        outer, inner, thickness = rfd_dimensions(row)
        key = (str(outer), str(inner), str(thickness), round(float(length), 3))
        codes = dimension_materials.get(key)
        if not codes:
            continue
        # Several SAP codes can share a size. They are the same physical cut, so all of
        # them are backed; the pool takes the bucket only when they agree on one.
        recovered_buckets = {
            b for b in (material_bucket.get(code) for code in codes) if b is not None
        }
        if pd.isna(row["material_key"]):
            rfd.at[i, "material_key"] = sorted(codes)[0]
        rfd.at[i, "backed_materials"] = "|".join(sorted(codes))
        if len(recovered_buckets) == 1:
            rfd.at[i, "bucket"] = next(iter(recovered_buckets))
            rfd.at[i, "ctl_bucket"] = make_ctl_bucket(
                next(iter(recovered_buckets)), length
            )
        rfd_recovered.append(
            {
                "size": f"{outer}x{inner}x{thickness}x{round(float(length) * 1000)}",
                "listed_code": (
                    None if pd.isna(row["CTL Code"]) else str(row["CTL Code"]).strip()
                ),
                "length_m": round(float(length), 3),
                "stock_nos": float(row["stock_nos"]),
                "stock_mt": round(float(row["stock_mt"]), 3),
                "materials": sorted(codes),
                "bucket": (
                    next(iter(recovered_buckets)) if len(recovered_buckets) == 1 else None
                ),
            }
        )
    rfd_unrecovered = []
    for _, r in rfd[
        (rfd["stock_nos"] > 0) & ~rfd["ctl_bucket"].map(valid_bucket)
    ].iterrows():
        outer, inner, thickness = rfd_dimensions(r)
        rfd_unrecovered.append(
            {
                "size": (
                    f"{outer}x{inner}x{thickness}"
                    + ("" if pd.isna(r["length_m"]) else f"x{round(float(r['length_m']) * 1000)}")
                ),
                "listed_code": (
                    None if pd.isna(r["CTL Code"]) else str(r["CTL Code"]).strip()
                ),
                "matched_materials": (
                    None if pd.isna(r["backed_materials"])
                    else str(r["backed_materials"]).replace("|", ", ")
                ),
                "length_m": None if pd.isna(r["length_m"]) else round(float(r["length_m"]), 3),
                "stock_nos": float(r["stock_nos"]),
                "stock_mt": round(float(r["stock_mt"]), 3),
                "reason": (
                    "Matched a 4731 material by size, but no governed bucket agrees"
                    if pd.notna(r["backed_materials"])
                    else "No CTL Code and no 4731 cut-length material at this size"
                    if pd.isna(r["CTL Code"])
                    else "CTL Code reaches no governed bucket and no 4731 material matches this size"
                ),
            }
        )
    rfd_unrecovered.sort(key=lambda r: -r["stock_mt"])
    rfd_stock = rfd[(rfd["stock_nos"] > 0) & rfd["ctl_bucket"].notna()].copy()
    rfd_pool_nos = rfd_stock.groupby("ctl_bucket")["stock_nos"].sum()
    rfd_pool_mt = rfd_stock.groupby("ctl_bucket")["stock_mt"].sum()

    # RFD 4731 is the authoritative list of CTL stock physically available at plant
    # 4731. Any 4731 CTL material in SAP with no positive RFD quantity is not
    # physically there and has to be written off.
    rfd_backed_materials = set(
        rfd.loc[rfd["stock_nos"] > 0, "material_key"].dropna().unique()
    )
    # A size-recovered row can back several SAP codes at once, so add every code it
    # matched rather than only the one it was keyed to.
    for codes in rfd.loc[rfd["stock_nos"] > 0, "backed_materials"].dropna():
        rfd_backed_materials.update(str(codes).split("|"))

    plants = ["789", "788", "4731", "8406"]
    for plant in plants:
        schedule_group[f"ll_stock_{plant}_mt"] = schedule_group.apply(
            lambda r: float(ll_pool.get((r["OEM"], r["bucket"], plant), 0)),
            axis=1,
        )
    schedule_group["ctl_stock_789_nos"] = schedule_group.apply(
        lambda r: float(ctl_pool_789_nos.get((r["OEM"], r["ctl_bucket"]), 0)), axis=1
    )
    schedule_group["ctl_stock_789_mt"] = schedule_group.apply(
        lambda r: float(ctl_pool_789_mt.get((r["OEM"], r["ctl_bucket"]), 0)), axis=1
    )
    schedule_group["ctl_stock_4731_nos"] = schedule_group["ctl_bucket"].map(rfd_pool_nos).fillna(0)
    schedule_group["ctl_stock_4731_mt"] = schedule_group["ctl_bucket"].map(rfd_pool_mt).fillna(0)
    schedule_group["ctl_stock_pool_nos"] = (
        schedule_group["ctl_stock_789_nos"] + schedule_group["ctl_stock_4731_nos"]
    )
    schedule_group["ctl_stock_pool_mt"] = (
        schedule_group["ctl_stock_789_mt"] + schedule_group["ctl_stock_4731_mt"]
    )
    schedule_group["ll_stock_pool_mt"] = schedule_group[[f"ll_stock_{p}_mt" for p in plants]].sum(axis=1)
    schedule_group["ctl_stock_detail_key"] = schedule_group.apply(
        lambda r: f"CTL|{r['OEM']}|{r['ctl_bucket']}", axis=1
    )
    schedule_group["ll_stock_detail_key"] = schedule_group.apply(
        lambda r: f"LL|{r['OEM']}|{r['bucket']}", axis=1
    )

    # Stock detail is stored once and referenced by key from dashboard rows. This
    # avoids duplicating the same shared pool across every customer schedule line.
    stock_details = {}
    ctl_789_detail = (
        ctl_stock.groupby(
            ["pool_oem", "ctl_bucket", "Plant", "Material", "Material Description"],
            dropna=False,
            as_index=False,
        )
        .agg(qty=("stock_nos", "sum"))
    )
    for (oem_name, ctl_bucket), group in ctl_789_detail.groupby(["pool_oem", "ctl_bucket"], dropna=False):
        key = f"CTL|{oem_name}|{ctl_bucket}"
        stock_details[key] = [
            {
                "source": "Plant stock",
                "plant": norm_code(row["Plant"]),
                "sku": None if pd.isna(row["Material Description"]) else str(row["Material Description"]),
                "material_code": norm_code(row["Material"]),
                "qty": float(row["qty"]),
                "unit": "NOS",
            }
            for _, row in group.iterrows()
        ]
    material_description = (
        zmat.groupby("material_key")["MATERIAL DESCRIPTION"].agg(first_unique).dropna()
    )
    rfd_detail = (
        rfd_stock.groupby(
            ["ctl_bucket", "material_key", "CUSTOMER", "CTL "],
            dropna=False,
            as_index=False,
        )
        .agg(qty=("stock_nos", "sum"))
    )
    rfd_detail_by_bucket = {}
    for ctl_bucket, group in rfd_detail.groupby("ctl_bucket", dropna=False):
        rfd_detail_by_bucket[ctl_bucket] = [
            {
                "source": "RFD 4731",
                "plant": "4731",
                "sku": (
                    material_description.get(row["material_key"])
                    or f"{row['CUSTOMER'] or 'Unassigned'} · CTL {norm_number(row['CTL ']) or '–'}"
                ),
                "material_code": row["material_key"],
                "qty": float(row["qty"]),
                "unit": "NOS",
            }
            for _, row in group.iterrows()
        ]
    for row in schedule_group[["OEM", "ctl_bucket"]].drop_duplicates().itertuples(index=False):
        key = f"CTL|{row.OEM}|{row.ctl_bucket}"
        stock_details[key] = stock_details.get(key, []) + rfd_detail_by_bucket.get(
            row.ctl_bucket, []
        )

    ll_detail = (
        ll_stock.groupby(
            ["pool_oem", "bucket", "Plant", "Material", "Material Description"],
            dropna=False,
            as_index=False,
        )
        .agg(qty=("stock_mt", "sum"))
    )
    for (oem_name, bucket), group in ll_detail.groupby(["pool_oem", "bucket"], dropna=False):
        key = f"LL|{oem_name}|{bucket}"
        stock_details[key] = [
            {
                "source": "Plant stock",
                "plant": norm_code(row["Plant"]),
                "sku": None if pd.isna(row["Material Description"]) else str(row["Material Description"]),
                "material_code": norm_code(row["Material"]),
                "qty": float(row["qty"]),
                "unit": "MT",
            }
            for _, row in group.iterrows()
        ]

    # The stock pools and the RFD reconciliation, written out when asked for.
    if os.environ.get("DUMP_STOCK"):
        Path(os.environ["DUMP_STOCK"]).write_text(json.dumps({
            "group": _plain(schedule_group.to_dict(orient="records")),
            "details": _plain({k: v for k, v in stock_details.items()
                               if k.startswith("CTL|") or k.startswith("LL|")}),
            "rfd_recovered": _plain(rfd_recovered),
            "rfd_unrecovered": _plain(rfd_unrecovered),
            "rfd_backed_materials": sorted(str(c) for c in rfd_backed_materials),
        }))
        print(f"  stock written to {os.environ['DUMP_STOCK']}")

    # 5. WIP/ystockn is an approved shared LL stock source.
    # The dump ends with a plant subtotal and a grand total, both carrying no material
    # code and each repeating the file's entire tonnage. Drop them before anything else
    # or they treble the apparent WIP.
    wip = wip[wip["Material No"].notna()].copy()
    wip["material_key"] = wip["Material No"].map(norm_code)
    wip["description_key"] = wip["Material Description"].map(norm_desc)
    # Map the material code through Bucketting first, then fall back to the description.
    code_bucket = wip["material_key"].map(material_bucket)
    wip["bucket"] = code_bucket.fillna(wip["description_key"].map(description_bucket))
    # Fall back to the code only where it does not contradict the description.
    code_trusted = [
        shape_matches_bucket(description, bucket)
        for description, bucket in zip(wip["Material Description"], code_bucket)
    ]
    wip["code_bucket"] = code_bucket
    wip["code_trusted"] = pd.Series(code_trusted, index=wip.index)
    wip["bucket"] = wip["bucket"].fillna(code_bucket.where(wip["code_trusted"]))
    # Why each unresolved row failed, so the queue is actionable rather than a list.
    wip["unmapped_reason"] = np.where(
        wip["bucket"].notna(), None,
        np.where(
            wip["code_bucket"].notna() & ~wip["code_trusted"],
            "Code bucket contradicts the description",
            "No governed mapping for code or description",
        ),
    )
    wip["length_m"] = wip["description_key"].map(description_length)
    wip["length_m"] = wip["length_m"].fillna(wip["material_key"].map(material_length))
    wip["wip_mt"] = pd.to_numeric(wip["Total Stock"], errors="coerce").fillna(0) / 1000
    wip_unmapped = [
        {
            "material_code": r["material_key"],
            "description": (
                None if pd.isna(r["Material Description"])
                else str(r["Material Description"])
            ),
            "plant": norm_code(r["Plant"]),
            "wip_mt": round(float(r["wip_mt"]), 3),
            "batches": int(r["batches"]),
            "code_bucket": None if pd.isna(r["code_bucket"]) else str(r["code_bucket"]),
            "reason": r["unmapped_reason"],
        }
        for _, r in (
            wip[wip["bucket"].isna() & (wip["wip_mt"] > 0)]
            .groupby(
                ["material_key", "Material Description", "Plant",
                 "code_bucket", "unmapped_reason"],
                dropna=False, as_index=False,
            )
            .agg(wip_mt=("wip_mt", "sum"), batches=("Batch", "nunique"))
            .sort_values("wip_mt", ascending=False)
            .iterrows()
        )
    ]
    # Governed buckets available to assign against.
    governed_buckets = sorted(
        {str(b) for b in bucket_map["Bucket"].dropna().unique() if valid_bucket(b)},
        key=natural_bucket_key,
    )

    wip_bucket = wip.dropna(subset=["bucket"]).groupby("bucket")["wip_mt"].sum()
    schedule_group["shared_wip_mt"] = schedule_group["bucket"].map(wip_bucket).fillna(0)
    transit_bucket = transit_stock.groupby("bucket")["stock_mt"].sum()
    schedule_group["shared_transit_mt"] = (
        schedule_group["bucket"].map(transit_bucket).fillna(0)
    )
    schedule_group["ll_stock_pool_mt"] = (
        schedule_group["ll_stock_pool_mt"]
        + schedule_group["shared_wip_mt"]
        + schedule_group["shared_transit_mt"]
    )
    wip_detail = (
        wip[wip["bucket"].notna() & (wip["wip_mt"] > 0)]
        .groupby(
            ["bucket", "Plant", "material_key", "Material Description"],
            dropna=False,
            as_index=False,
        )
        .agg(qty=("wip_mt", "sum"))
    )
    wip_detail_by_bucket = {}
    for bucket, group in wip_detail.groupby("bucket", dropna=False):
        wip_detail_by_bucket[bucket] = [
            {
                "source": "WIP ystockn",
                "plant": norm_code(row["Plant"]),
                "sku": None if pd.isna(row["Material Description"]) else str(row["Material Description"]),
                "material_code": row["material_key"],
                "qty": float(row["qty"]),
                "unit": "MT",
            }
            for _, row in group.iterrows()
        ]
    transit_detail_by_bucket = {}
    for bucket, group in (
        transit_stock[transit_stock["stock_mt"] > 0]
        .groupby(
            ["bucket", "Plant", "material_key", "Material Description"],
            dropna=False,
            as_index=False,
        )
        .agg(qty=("stock_mt", "sum"))
        .groupby("bucket", dropna=False)
    ):
        transit_detail_by_bucket[bucket] = [
            {
                "source": "Transit",
                "plant": row["Plant"],
                "sku": None if pd.isna(row["Material Description"]) else str(row["Material Description"]),
                "material_code": row["material_key"],
                "qty": float(row["qty"]),
                "unit": "MT",
            }
            for _, row in group.iterrows()
        ]
    for row in schedule_group[["OEM", "bucket"]].drop_duplicates().itertuples(index=False):
        key = f"LL|{row.OEM}|{row.bucket}"
        stock_details[key] = (
            stock_details.get(key, [])
            + wip_detail_by_bucket.get(row.bucket, [])
            + transit_detail_by_bucket.get(row.bucket, [])
        )

    # Customer summary. Pool columns are intentionally not summed; they are shown as
    # "max visible pool" and require allocation before they become customer-owned stock.
    customer_summary = (
        schedule_group.groupby(["OEM", "customer_display"], dropna=False, as_index=False)
        .agg(
            schedule_mt=("schedule_mt", "sum"),
            sales_mt=("sales_mt", "sum"),
            balance_mt=("balance_mt", "sum"),
            open_balance_mt=("open_balance_mt", "sum"),
            over_dispatch_mt=("over_dispatch_mt", "sum"),
            ctl_stock_pool_nos_do_not_sum=("ctl_stock_pool_nos", "max"),
            ctl_stock_pool_mt_do_not_sum=("ctl_stock_pool_mt", "max"),
            ll_stock_pool_mt_do_not_sum=("ll_stock_pool_mt", "max"),
            shared_wip_mt_do_not_sum=("shared_wip_mt", "max"),
            shared_transit_mt_do_not_sum=("shared_transit_mt", "max"),
            schedule_lines=("ctl_bucket", "size"),
            unresolved_sales_lines=("sales_mt", lambda x: int((x == 0).sum())),
        )
    )

    # WIP, transit and the customer summary, written out when asked for.
    if os.environ.get("DUMP_WIP"):
        Path(os.environ["DUMP_WIP"]).write_text(json.dumps({
            "group": _plain(schedule_group.to_dict(orient="records")),
            "details": _plain({k: v for k, v in stock_details.items() if k.startswith("LL|")}),
            "wip_unmapped": _plain(wip_unmapped),
            "governed_buckets": _plain(governed_buckets),
            "customer_summary": _plain(customer_summary.to_dict(orient="records")),
        }))
        print(f"  wip written to {os.environ['DUMP_WIP']}")

    # 6. TVSM LL tracker at bucket level.
    tvs_schedule = schedule_group[schedule_group["OEM"].eq("TVS")]
    tsl_schedule = tvs_schedule.groupby("bucket")["schedule_mt"].sum()
    tsl_open = tvs_schedule.groupby("bucket")["open_balance_mt"].sum()
    tvs_sales = sales[sales["OEM"].eq("TVS") & sales["bucket"].notna()]
    tsl_sales = tvs_sales.groupby("bucket")["sales_mt"].sum()
    tvs_ll_stock = ll_stock[ll_stock["pool_oem"].eq("TVS")]
    tsl_ll_by_plant = tvs_ll_stock.groupby(["bucket", "Plant"])["stock_mt"].sum()

    vsm["bucket"] = vsm["key"].map(norm_bucket)
    vsm["vsm_schedule_mt"] = pd.to_numeric(vsm["VSM Requirement"], errors="coerce").fillna(0)
    vsm["vsm_sales_mt"] = pd.to_numeric(vsm["VSM Sales"], errors="coerce").fillna(0)
    vsm["vsm_stock_mt"] = pd.to_numeric(vsm["VSM Stock"], errors="coerce").fillna(0)
    vsm_bucket = (
        vsm.dropna(subset=["bucket"])
        .groupby("bucket")[["vsm_schedule_mt", "vsm_sales_mt", "vsm_stock_mt"]]
        .sum()
    )

    vsm_detail_rows = {}
    for bucket, group in vsm.dropna(subset=["bucket"]).groupby("bucket"):
        details = []
        for _, row in group.iterrows():
            qty = float(row.get("vsm_stock_mt", 0) or 0)
            if qty <= 0:
                continue
            material_code = norm_code(row.get("Column1"))
            sku = (
                f"{norm_number(row.get('O D')) or ''} x "
                f"{norm_thickness(row.get('Thk.')) or ''} "
                f"{norm_text(row.get('Grade')) or ''}"
            ).strip()
            details.append(
                {
                    "source": "RM Tracker TVSM",
                    "plant": "TVSM",
                    "sku": sku or bucket,
                    "material_code": material_code,
                    "qty": qty,
                    "unit": "MT",
                }
            )
        vsm_detail_rows[bucket] = details

    buckets = sorted(set(tsl_schedule.index) | set(vsm_bucket.index), key=natural_bucket_key)
    ll_rows = []
    for bucket in buckets:
        row = {
            "bucket": bucket,
            "tsl_schedule_mt": float(tsl_schedule.get(bucket, 0)),
            "tvsm_schedule_mt": float(vsm_bucket["vsm_schedule_mt"].get(bucket, 0)),
            "vsm_schedule_mt": float(vsm_bucket["vsm_schedule_mt"].get(bucket, 0)),
            "tsl_sales_mt": float(tsl_sales.get(bucket, 0)),
            "vsm_sales_mt": float(vsm_bucket["vsm_sales_mt"].get(bucket, 0)),
            "tsl_open_schedule_mt": float(tsl_open.get(bucket, 0)),
            "vsm_stock_mt": float(vsm_bucket["vsm_stock_mt"].get(bucket, 0)),
            "shared_wip_mt": float(wip_bucket.get(bucket, 0)),
            "transit_mt": float(transit_bucket.get(bucket, 0)),
        }
        for plant in plants:
            row[f"ll_stock_{plant}_mt"] = float(tsl_ll_by_plant.get((bucket, plant), 0))
        row["total_schedule_mt"] = row["tsl_schedule_mt"] + row["vsm_schedule_mt"]
        row["total_sales_mt"] = row["tsl_sales_mt"] + row["vsm_sales_mt"]
        row["remaining_schedule_mt"] = max(row["total_schedule_mt"] - row["total_sales_mt"], 0)
        # Demand gap: net each side against its own sales, then add. Flooring each
        # component at zero stops TVS over-dispatch from masking a real VSM gap.
        row["tvs_gap_mt"] = max(row["tsl_schedule_mt"] - row["tsl_sales_mt"], 0)
        row["vsm_gap_mt"] = max(row["vsm_schedule_mt"] - row["vsm_sales_mt"], 0)
        row["total_gap_mt"] = row["tvs_gap_mt"] + row["vsm_gap_mt"]
        row["tsl_ll_stock_mt"] = sum(row[f"ll_stock_{plant}_mt"] for plant in plants)
        row["available_ll_stock_mt"] = (
            row["tsl_ll_stock_mt"]
            + row["vsm_stock_mt"]
            + row["shared_wip_mt"]
            + row["transit_mt"]
        )
        row["stock_detail_key"] = f"LLALL|{bucket}"
        base_ll_details = stock_details.get(f"LL|TVS|{bucket}", [])
        if not any(detail.get("source") == "WIP ystockn" for detail in base_ll_details):
            base_ll_details = base_ll_details + wip_detail_by_bucket.get(bucket, [])
        if not any(detail.get("source") == "Transit" for detail in base_ll_details):
            base_ll_details = base_ll_details + transit_detail_by_bucket.get(bucket, [])
        stock_details[row["stock_detail_key"]] = (
            base_ll_details + vsm_detail_rows.get(bucket, [])
        )
        demand_base = row["total_schedule_mt"]
        row["coverage_days"] = (
            row["available_ll_stock_mt"] / demand_base * 30 if demand_base > 0 else None
        )
        row["coverage_days_excl_wip"] = row["coverage_days"]
        row["coverage_days_incl_wip"] = row["coverage_days"]
        row["current_month_shortage_mt"] = max(
            row["remaining_schedule_mt"] - row["available_ll_stock_mt"], 0
        )
        row["gap_to_30_days_mt"] = max(demand_base - row["available_ll_stock_mt"], 0)
        row["gap_to_45_days_mt"] = max(demand_base * 1.5 - row["available_ll_stock_mt"], 0)
        coverage = row["coverage_days"]
        if coverage is None:
            row["risk"] = "No demand"
        elif coverage < 15:
            row["risk"] = "Critical"
        elif coverage < 30:
            row["risk"] = "Low"
        elif coverage < 45:
            row["risk"] = "Watch"
        else:
            row["risk"] = "Adequate"
        ll_rows.append(row)
    ll_tracker = pd.DataFrame(ll_rows)

    # Every LL metric has a drill-down, using the same auditable card interaction
    # as stock. Coverage and gap cards expose their component values and formula.
    metric_details = {}
    for row in ll_rows:
        bucket = row["bucket"]
        details = {
            f"LLSCHEDULE|{bucket}": [
                {"source": "Schedule July", "plant": "TSL", "sku": bucket, "material_code": None,
                 "qty": row["tsl_schedule_mt"], "unit": "MT"},
                {"source": "RM Tracker TVSM", "plant": "TVSM", "sku": bucket, "material_code": None,
                 "qty": row["tvsm_schedule_mt"], "unit": "MT"},
            ],
            f"LLSALES|{bucket}": [
                {"source": "Sales dump", "plant": "TSL", "sku": bucket, "material_code": None,
                 "qty": row["tsl_sales_mt"], "unit": "MT"},
                {"source": "RM Tracker TVSM", "plant": "TVSM", "sku": bucket, "material_code": None,
                 "qty": row["vsm_sales_mt"], "unit": "MT"},
            ],
            f"LLCOVERAGE|{bucket}": [
                {"source": "Total stock", "plant": "Formula input", "sku": bucket,
                 "material_code": "stock ÷ schedule × 30", "qty": row["available_ll_stock_mt"], "unit": "MT"},
                {"source": "Total schedule", "plant": "Formula input", "sku": bucket,
                 "material_code": "stock ÷ schedule × 30", "qty": row["total_schedule_mt"], "unit": "MT"},
                {"source": "Coverage", "plant": "Calculated", "sku": bucket,
                 "material_code": "stock ÷ schedule × 30", "qty": row["coverage_days"], "unit": "DAYS"},
            ],
            f"LLGAP45|{bucket}": [
                {"source": "45-day requirement", "plant": "Calculated", "sku": bucket,
                 "material_code": "schedule × 1.5", "qty": row["total_schedule_mt"] * 1.5, "unit": "MT"},
                {"source": "Total stock", "plant": "Formula input", "sku": bucket,
                 "material_code": "max(requirement − stock, 0)", "qty": row["available_ll_stock_mt"], "unit": "MT"},
                {"source": "Gap to 45 days", "plant": "Calculated", "sku": bucket,
                 "material_code": "max(requirement − stock, 0)", "qty": row["gap_to_45_days_mt"], "unit": "MT"},
            ],
            f"LLGAP|{bucket}": [
                {"source": "TVS schedule", "plant": "TSL", "sku": bucket,
                 "material_code": "Schedule July, OEM TVS", "qty": row["tsl_schedule_mt"], "unit": "MT"},
                {"source": "TVS sales", "plant": "TSL", "sku": bucket,
                 "material_code": "less TVS dispatch", "qty": row["tsl_sales_mt"], "unit": "MT"},
                {"source": "TVS gap", "plant": "Calculated", "sku": bucket,
                 "material_code": "max(schedule − sales, 0)", "qty": row["tvs_gap_mt"], "unit": "MT"},
                {"source": "VSM requirement", "plant": "TVSM", "sku": bucket,
                 "material_code": "RM Tracker TVSM sheet", "qty": row["vsm_schedule_mt"], "unit": "MT"},
                {"source": "VSM sales", "plant": "TVSM", "sku": bucket,
                 "material_code": "less VSM dispatch", "qty": row["vsm_sales_mt"], "unit": "MT"},
                {"source": "VSM gap", "plant": "Calculated", "sku": bucket,
                 "material_code": "max(requirement − sales, 0)", "qty": row["vsm_gap_mt"], "unit": "MT"},
                {"source": "Total gap", "plant": "Calculated", "sku": bucket,
                 "material_code": "TVS gap + VSM gap", "qty": row["total_gap_mt"], "unit": "MT"},
            ],
        }
        metric_details.update(details)

    # The LL tracker, written out when asked for.
    if os.environ.get("DUMP_LL"):
        Path(os.environ["DUMP_LL"]).write_text(json.dumps({
            "ll_rows": _plain(ll_rows),
            "details": _plain({k: v for k, v in stock_details.items()
                               if k.startswith("LLALL|")}),
            "metric_details": _plain(metric_details),
        }))
        print(f"  ll tracker written to {os.environ['DUMP_LL']}")

    # 7. Sales summary classified through OEM_key_1_rev codes, with the governed
    # Boiler material-group override applied above.
    # Exclude workbook total/summary rows that have no customer code; otherwise the
    # sales summary double-counts the file grand total as an "Unmapped" transaction.
    sales_transactions = sales[sales["customer_key"].notna()].copy()
    # Route conversion-agent codes to the OEM they convert for. The Boiler
    # material-group override still takes precedence, matching the documented order.
    conversion_oem = sales_transactions["customer_key"].map(CONVERSION_AGENT_OEM_BY_CODE)
    sales_transactions["sales_oem"] = (
        sales_transactions["OEM"]
        .mask(
            conversion_oem.notna() & ~sales_transactions["OEM"].eq("Boiler"),
            conversion_oem,
        )
        .fillna("Unmapped")
    )
    sales_summary = (
        sales_transactions.groupby("sales_oem", as_index=False)
        .agg(
            sales_mt=("sales_mt", "sum"),
            sales_nos=("sales_nos", "sum"),
            sales_m=("sales_m", "sum"),
            customers=("customer_key", "nunique"),
            transactions=("sales_mt", "size"),
        )
        .rename(columns={"sales_oem": "OEM"})
        .sort_values("sales_mt", ascending=False)
    )
    sales_summary["detail_key"] = sales_summary["OEM"].map(lambda value: f"SALES|{value}")
    sales_customer_detail = (
        sales_transactions.groupby(
            ["sales_oem", "customer_key", "CUSTOMER  NAME"],
            dropna=False,
            as_index=False,
        )
        .agg(qty=("sales_mt", "sum"))
    )
    for oem_name, group in sales_customer_detail.groupby("sales_oem", dropna=False):
        metric_details[f"SALES|{oem_name}"] = [
            {
                "source": "Sales dump",
                "plant": oem_name,
                "sku": None if pd.isna(row["CUSTOMER  NAME"]) else str(row["CUSTOMER  NAME"]),
                "material_code": row["customer_key"],
                "qty": float(row["qty"]),
                "unit": "MT",
            }
            for _, row in group.sort_values("qty", ascending=False).iterrows()
        ]

    # 8. Missing mappings are surfaced as two explicit queues: material and customer.
    missing_rows = []

    def add_missing(frame, mapping_type, source, customer_code, customer, material_code,
                    description, reason, qty_column=None, qty_scale=1.0):
        if frame.empty:
            return
        working = frame.copy()
        working["_customer_code"] = (
            working[customer_code].map(norm_code) if customer_code in working else None
        )
        working["_customer"] = (
            working[customer].astype(str).replace("nan", "") if customer in working else ""
        )
        working["_material_code"] = (
            working[material_code].map(norm_code) if material_code in working else None
        )
        working["_description"] = (
            working[description].astype(str).replace("nan", "") if description in working else ""
        )
        working["_qty_mt"] = (
            pd.to_numeric(working[qty_column], errors="coerce").fillna(0) * qty_scale
            if qty_column and qty_column in working else 0.0
        )
        grouped = (
            working.groupby(
                ["_customer_code", "_customer", "_material_code", "_description"],
                dropna=False,
                as_index=False,
            )["_qty_mt"].sum()
        )
        for _, row in grouped.iterrows():
            missing_rows.append(
                {
                    "mapping_type": mapping_type,
                    "source": source,
                    "customer_code": row["_customer_code"],
                    "customer": row["_customer"],
                    "material_code": row["_material_code"],
                    "description": row["_description"],
                    "reason": reason,
                    "affected_mt": float(row["_qty_mt"]),
                }
            )

    tvsm_material_scope = (
        sales_transactions["oem_key_oem"].eq("TVS")
        | sales_transactions["customer_key"].eq("943209")
    )
    add_missing(
        sales_transactions[sales_transactions["bucket"].isna() & tvsm_material_scope],
        "Material", "sales.xlsx", "CUSTOMER  CD", "CUSTOMER  NAME",
        "MATERAIL NUMBER", "Material   Description",
        "TVSM/943209 material code has no governed bucket",
        "Quantity", 0.001,
    )
    add_missing(
        sales_transactions[sales_transactions["oem_key_oem"].isna()],
        "Customer", "sales.xlsx", "CUSTOMER  CD", "CUSTOMER  NAME",
        "", "", "Customer code/name is absent from OEM_key_1_rev codes", "sales_mt",
    )
    # Every scheduled line that reaches no governed bucket, wherever it came from. This
    # covered only the supplement at first, so when the owner's own workbook started
    # carrying all the customers the queue silently emptied — the rows were still
    # unmapped, just no longer looked at. A size a customer has ordered and nothing
    # governs is the same problem whichever sheet it arrived on.
    scheduled = schedule[
        pd.to_numeric(schedule["SCHEDULE in nos"], errors="coerce").fillna(0) > 0
    ]
    # A row with no bucket often has no description either, and a queue entry that names
    # neither is a blank line. Write the size out from the dimensions the row does carry.
    unmapped_schedule = scheduled[scheduled["bucket"].isna()].copy()
    if not unmapped_schedule.empty:
        def scheduled_size(row):
            stated = str(row.get("MATERIAL DES") or "").strip()
            if stated and stated.lower() != "nan":
                return stated
            od = pd.to_numeric(row.get("ACTUAL OD"), errors="coerce")
            inner = pd.to_numeric(row.get("ID"), errors="coerce")
            thk = pd.to_numeric(row.get("TICKNESS"), errors="coerce")
            length = pd.to_numeric(row.get("LENGTH"), errors="coerce")
            if pd.isna(od) or pd.isna(thk) or pd.isna(length):
                return LOOKUP_ERROR
            face = f"{od:g}" if pd.isna(inner) or inner == 0 else f"{od:g} x {inner:g}"
            grade = str(row.get("Grade") or "").strip()
            return (f"{face} x {thk:g} x {length:g} mm"
                    + (f" {grade}" if grade and grade.lower() != "nan" else ""))
        unmapped_schedule["MATERIAL DES"] = [
            scheduled_size(row) for _, row in unmapped_schedule.iterrows()
        ]
    add_missing(
        unmapped_schedule,
        "Schedule", schedule_sheet, "CUSTOMER CODE", "Helper Customer",
        "MATERIAL NO", "MATERIAL DES",
        "Scheduled size has no governed bucket in Bucketting",
        # The computed column, not the sheet's own: a row whose tonnage the sheet leaves
        # to its formula would otherwise report to the queue as 0 MT.
        "schedule_mt",
    )

    missing_mappings = pd.DataFrame(missing_rows)
    if not missing_mappings.empty:
        missing_mappings = missing_mappings.sort_values(
            ["mapping_type", "affected_mt"], ascending=[True, False]
        )

    # Resolve the dispatch SO from the latest earlier invoice of the same material.
    # A sales order belongs to a customer, so prefer that customer's own order before
    # falling back to any order for the material, and record which level matched.
    def resolve_so(row):
        """Most specific evidence first: the exact material this customer bought.

        The material code is only usable now that it reads correctly; before that its
        last digit was lost, so the CTL bucket carried the whole join.
        """
        ctl = row["ctl_bucket"]
        material = row["material_key"]
        for code in row["customer_codes"]:
            if material:
                hit = so_by_customer_material.get((code, material))
                if hit:
                    return pd.Series({
                        "so_number": hit[0], "dispatch_plant": hit[1],
                        "so_material": hit[2],
                        "so_source": "same customer and material code",
                    })
        for code in row["customer_codes"]:
            hit = so_by_customer_ctl.get((code, ctl))
            if hit:
                return pd.Series({
                    "so_number": hit[0], "dispatch_plant": hit[1],
                    "so_material": hit[2], "so_source": "same customer and material",
                })
        if material:
            hit = so_by_material.get(material)
            if hit:
                return pd.Series({
                    "so_number": hit[0], "dispatch_plant": hit[1],
                    "so_material": hit[2], "so_source": "same material code",
                })
        hit = so_by_ctl.get(ctl)
        if hit:
            return pd.Series({
                "so_number": hit[0], "dispatch_plant": hit[1],
                "so_material": hit[2], "so_source": "same material",
            })
        return pd.Series({
            "so_number": None, "dispatch_plant": None,
            "so_material": None, "so_source": None,
        })

    schedule_group = schedule_group.join(schedule_group.apply(resolve_so, axis=1))
    # The schedule names its plant by location while the dispatch plan quotes a plant
    # code. Learn the mapping from the lines whose SO resolved, so a line without a
    # prior invoice still quotes a code rather than a location name.
    location_plant = (
        schedule_group.dropna(subset=["dispatch_plant"])
        .groupby("Plant")["dispatch_plant"]
        .agg(lambda values: values.value_counts().idxmax())
    )
    schedule_group["dispatch_plant"] = schedule_group["dispatch_plant"].fillna(
        schedule_group["Plant"].map(location_plant)
    )

    schedule_export = schedule_group.drop(columns=["customer_codes"])
    schedule_export.to_csv(output_dir / "customer_schedule_lines.csv", index=False)
    customer_summary.to_csv(output_dir / "customer_summary.csv", index=False)
    # tvsm_ll_tracker.csv is written after the order book (section 16) so the export
    # carries the order column too.
    sales_summary.to_csv(output_dir / "sales_summary.csv", index=False)
    missing_mappings.to_csv(output_dir / "missing_mappings.csv", index=False)

    # Total TVS dispatch for the headline card. Use the direct OEM_key_1_rev result
    # so a Boiler material-group override cannot drop a TVS customer's sale, and
    # add customer 943209, which the OEM key maps to Direct but which supplies TVS.
    tvs_oem_sales = sales[sales["oem_key_oem"].eq("TVS")]
    cust_943209_sales = sales[sales["customer_key"].eq("943209")]
    tvs_total_sales = sales[
        sales["oem_key_oem"].eq("TVS") | sales["customer_key"].eq("943209")
    ]
    # 9. Stock analysis: physical plant stock as material line items, split into cut
    # length and long length. Plant is a filter rather than a grouping level, and rows
    # are ordered by oldest stock first. This is an inventory view of the whole PLANT
    # STOCKS sheet, so it is deliberately wider than the approved coverage sources used
    # by the customer and long-length trackers.
    def rfd_split(plant, material, row_mt):
        """A row's share of its material's SAP-against-RFD reconciliation.

        Blank for anything the reconciliation does not cover — every plant but 4731, and
        long length everywhere — so the columns stay empty rather than reading as a
        perfect match on stock RFD says nothing about. The plant test is load-bearing:
        the same code is stocked at other plants, and keying on the material alone gave
        an 0789 row 4731's verdict and scaled its tonnage by 4731's SAP total.
        """
        entry = rfd_by_material.get(material) if str(plant) == "4731" else None
        if entry is None:
            return {
                "rfd_verdict": None, "rfd_explanation": None,
                "rfd_matched_mt": None, "rfd_unmatched_mt": None,
            }
        share = row_mt / entry["sap_mt"] if entry["sap_mt"] else 0.0
        return {
            "rfd_verdict": entry["verdict"],
            "rfd_explanation": entry["explanation"],
            "rfd_matched_mt": round(entry["matched_mt"] * share, 3),
            "rfd_unmatched_mt": round(entry["unmatched_mt"] * share, 3),
        }

    def build_stock_analysis(frame, key_prefix):
        rows = []
        frame = frame.assign(
            high_age_mt=frame["stock_mt"].where(frame["is_high_age"], 0.0)
        )
        grouped = frame.groupby(
            ["Plant", "material_key", "Material Description", "CUSTOMER NAME"],
            dropna=False,
            as_index=False,
        ).agg(
            stock_mt=("stock_mt", "sum"),
            stock_nos=("stock_nos", "sum"),
            nos_is_weight=("nos_is_weight", "all"),
            batches=("BATCH", "nunique"),
            high_age_mt=("high_age_mt", "sum"),
            oldest_age=("ageing_days_month_end", "max"),
            rfd_status=("rfd_status", first_unique),
        )
        # `mergesort` for the same reason as the overdue drill-downs: the default is not
        # stable, and materials tie on both age and tonnage, so which of two rows printed
        # first was decided by the sort's internals rather than by anything here.
        for _, agg in grouped.sort_values(
            ["oldest_age", "stock_mt"], ascending=[False, False], kind="mergesort"
        ).iterrows():
            plant = agg["Plant"]
            material = agg["material_key"]
            holder = agg["CUSTOMER NAME"]
            holder_label = "Unassigned" if pd.isna(holder) else str(holder)
            detail_key = f"{key_prefix}|{plant}|{material}|{holder_label.replace('|', '/')}"
            scope = frame[frame["Plant"].eq(plant) & frame["material_key"].eq(material)]
            scope = (
                scope[scope["CUSTOMER NAME"].isna()] if pd.isna(holder)
                else scope[scope["CUSTOMER NAME"].eq(holder)]
            )
            detail = (
                scope
                .groupby(["BATCH", "CUSTOMER NAME"], dropna=False, as_index=False)
                .agg(
                    qty=("stock_mt", "sum"),
                    age_me=("ageing_days_month_end", "max"),
                    age_now=("ageing_days", "max"),
                )
                .sort_values("age_me", ascending=False, kind="mergesort")
            )
            batch_rows = [
                {
                    "batch": None if pd.isna(d["BATCH"]) else str(d["BATCH"]),
                    "plant": plant,
                    "material_code": material,
                    "description": (
                        None if pd.isna(agg["Material Description"])
                        else str(agg["Material Description"])
                    ),
                    "holder": (
                        None if pd.isna(d["CUSTOMER NAME"]) else str(d["CUSTOMER NAME"])
                    ),
                    # Ageing date is the date the stock reached its current age.
                    "ageing_date": (
                        as_of_date - pd.Timedelta(days=int(d["age_now"]))
                    ).date().isoformat(),
                    "age_days": int(d["age_now"]),
                    "age_days_month_end": int(d["age_me"]),
                    "qty": float(d["qty"]),
                    "unit": "MT",
                }
                for _, d in detail.iterrows()
            ]
            stock_details[detail_key] = batch_rows
            stock_details[f"{detail_key}|HIGHAGE"] = [
                r for r in batch_rows if r["age_days_month_end"] > HIGH_AGE_DAYS
            ]
            rows.append(
                {
                    "plant": plant,
                    "material_code": material,
                    "description": (
                        None if pd.isna(agg["Material Description"])
                        else str(agg["Material Description"])
                    ),
                    "holder": holder_label,
                    "stock_mt": round(float(agg["stock_mt"]), 3),
                    "stock_nos": (
                        None if bool(agg["nos_is_weight"]) else float(agg["stock_nos"])
                    ),
                    "batches": int(agg["batches"]),
                    "high_age_mt": round(float(agg["high_age_mt"]), 3),
                    "oldest_age_days": int(agg["oldest_age"]),
                    "rfd_status": (
                        None if pd.isna(agg["rfd_status"]) else str(agg["rfd_status"])
                    ),
                    # The reconciliation is per material and a row is per material and
                    # holder, so the matched and unmatched tonnage is allocated across a
                    # material's rows in proportion to what each one holds. Repeating the
                    # material total on every row would double it in the column subtotal
                    # the moment one code is held for two customers.
                    **rfd_split(plant, material, float(agg["stock_mt"])),
                    "high_age_detail_key": f"{detail_key}|HIGHAGE",
                    "detail_key": detail_key,
                }
            )
        return rows

    # Reconcile on quantity, not on presence. A material can appear in RFD and still be
    # overstated in SAP: 3910648 holds 6,123 nos at 4731 against 3,000 nos in RFD, so
    # calling the whole line "backed" leaves 3,123 nos on the books that are not there.
    is_4731_ctl = (
        stock["Plant"].eq("4731")
        & stock["CTL/LL"].astype(str).str.strip().str.upper().eq("CTL")
    )
    # Compare weight, not the piece count. SAP holds 4731 in kilograms and repeats that
    # figure in the NOS column, so a piece-for-piece comparison against RFD is units
    # against kilograms: 3910648 reads 6,123 "nos" against 3,000 real pieces, which is
    # 6.123 MT against 6.321 MT — backed in full, not short by half.
    sap_4731_mt = (
        stock.loc[is_4731_ctl].groupby("material_key")["stock_mt"].sum().to_dict()
    )
    # One RFD line can name several SAP codes. Share its weight between them in
    # proportion to what SAP holds, so the same physical stock can never back two
    # materials at once and inflate the covered figure.
    rfd_mt_by_material = {}
    rfd_nos_by_material = {}
    rfd_shared_materials = set()
    for _, r in rfd[rfd["stock_nos"] > 0].iterrows():
        codes = (
            str(r["backed_materials"]).split("|")
            if pd.notna(r["backed_materials"])
            else ([r["material_key"]] if pd.notna(r["material_key"]) else [])
        )
        codes = [c for c in codes if c in sap_4731_mt]
        if not codes:
            continue
        if len(codes) > 1:
            rfd_shared_materials.update(codes)
        weights = {c: float(sap_4731_mt.get(c, 0) or 0) for c in codes}
        total_weight = sum(weights.values())
        for code in codes:
            share = (
                weights[code] / total_weight if total_weight > 0 else 1 / len(codes)
            )
            rfd_mt_by_material[code] = (
                rfd_mt_by_material.get(code, 0.0) + float(r["stock_mt"]) * share
            )
            rfd_nos_by_material[code] = (
                rfd_nos_by_material.get(code, 0.0) + float(r["stock_nos"]) * share
            )

    def rfd_comment(material):
        """SAP against RFD for one 4731 material, split into what agrees and what does not.

        Returns the matched tonnage, the unmatched tonnage, a short verdict and the
        sentence explaining the difference. Matched and unmatched always add back to
        what SAP holds, so both columns can be totalled — where RFD holds *more* than
        SAP the excess is stated in words rather than shown as a negative, because
        there is no SAP tonnage behind it to write off or to keep.
        """
        sap_mt = float(sap_4731_mt.get(material, 0) or 0)
        rfd_mt = float(rfd_mt_by_material.get(material, 0) or 0)
        rfd_nos = float(rfd_nos_by_material.get(material, 0) or 0)
        shared = " (RFD line shared with another code)" if material in rfd_shared_materials else ""
        matched_mt = min(sap_mt, rfd_mt)
        gap = sap_mt - rfd_mt
        if rfd_mt <= 0:
            verdict, explanation = "Not in RFD", (
                f"RFD holds nothing against this code - write off {sap_mt:.3f} MT{shared}"
            )
        # Weights are carried to the kilogram, so treat anything under 10 kg as
        # rounding rather than a real shortfall.
        elif gap > 0.01:
            verdict, explanation = "Short in RFD", (
                f"RFD backs {rfd_mt:.3f} of {sap_mt:.3f} MT "
                f"({fmt_nos(rfd_nos)} nos) - write off {gap:.3f} MT{shared}"
            )
        elif gap < -0.01:
            verdict, explanation = "RFD holds more", (
                f"Fully backed - RFD holds {rfd_mt:.3f} MT ({fmt_nos(rfd_nos)} nos) "
                f"against {sap_mt:.3f} MT in SAP, {-gap:.3f} MT more than SAP shows{shared}"
            )
        else:
            verdict, explanation = "Match", (
                f"SAP and RFD agree - {sap_mt:.3f} MT ({fmt_nos(rfd_nos)} nos){shared}"
            )
        return {
            "verdict": verdict,
            "explanation": explanation,
            "sap_mt": sap_mt,
            "rfd_mt": rfd_mt,
            "matched_mt": matched_mt,
            "unmatched_mt": max(sap_mt - matched_mt, 0.0),
        }

    rfd_by_material = {
        material: rfd_comment(material) for material in sap_4731_mt
    }
    rfd_status_by_material = {
        material: entry["explanation"] for material, entry in rfd_by_material.items()
    }
    stock.loc[is_4731_ctl, "rfd_status"] = (
        stock.loc[is_4731_ctl, "material_key"].map(rfd_status_by_material)
    )
    # Tonnage that has to come off SAP: the whole line where RFD holds nothing, and the
    # unbacked share of it where RFD holds less than SAP.
    rfd_unbacked_mt = 0.0
    rfd_unbacked_materials = 0
    rfd_partly_backed_materials = 0
    for material, sap_mt in sap_4731_mt.items():
        rfd_mt = float(rfd_mt_by_material.get(material, 0) or 0)
        gap = max(0.0, float(sap_mt) - rfd_mt)
        if gap <= 0.01:
            continue
        rfd_unbacked_materials += 1
        rfd_unbacked_mt += gap
        if rfd_mt > 0:
            rfd_partly_backed_materials += 1

    stock_scoped = stock[stock["stock_mt"] > 0]
    # Every inventory source maps its material to a governed bucket, and what fails to
    # map is stock the coverage views cannot see. Report the shortfall per source with
    # its own line items, so the size of the blind spot is visible on the stock view
    # and the rows to fix are queued in the missing-mappings view.
    stock_unmapped = [
        {
            "material_code": r["material_key"],
            "description": (
                None if pd.isna(r["Material Description"])
                else str(r["Material Description"])
            ),
            "plant": r["Plant"],
            "holder": None if pd.isna(r["CUSTOMER NAME"]) else str(r["CUSTOMER NAME"]),
            "length_type": "LL" if r["is_long"] else "CTL",
            "stock_mt": round(float(r["stock_mt"]), 3),
            "batches": int(r["batches"]),
        }
        for _, r in (
            stock.assign(is_long=is_long)[stock["bucket"].isna() & (stock["stock_mt"] > 0)]
            .groupby(
                ["material_key", "Material Description", "Plant", "CUSTOMER NAME",
                 "is_long"],
                dropna=False, as_index=False,
            )
            .agg(stock_mt=("stock_mt", "sum"), batches=("BATCH", "nunique"))
            .sort_values("stock_mt", ascending=False, kind="mergesort")
            .iterrows()
        )
    ]
    rfd_positive = rfd[rfd["stock_nos"] > 0]
    source_coverage = []
    for label, source_file, total_mt, unmapped_mt, rows_total, rows_unmapped, key in (
        (
            "PLANT STOCKS", "stock.xlsx",
            float(stock.loc[stock["stock_mt"] > 0, "stock_mt"].sum()),
            float(stock.loc[stock["bucket"].isna() & (stock["stock_mt"] > 0), "stock_mt"].sum()),
            int((stock["stock_mt"] > 0).sum()),
            int((stock["bucket"].isna() & (stock["stock_mt"] > 0)).sum()),
            "SRCGAP|stock",
        ),
        (
            "WIP ystockn", "wip.xlsx",
            float(wip.loc[wip["wip_mt"] > 0, "wip_mt"].sum()),
            float(wip.loc[wip["bucket"].isna() & (wip["wip_mt"] > 0), "wip_mt"].sum()),
            int((wip["wip_mt"] > 0).sum()),
            int((wip["bucket"].isna() & (wip["wip_mt"] > 0)).sum()),
            "SRCGAP|wip",
        ),
        (
            "RFD 4731", "rfd_4731.xlsx",
            float(rfd_positive["stock_mt"].sum()),
            float(rfd_positive.loc[~rfd_positive["ctl_bucket"].map(valid_bucket), "stock_mt"].sum()),
            int(len(rfd_positive)),
            int((~rfd_positive["ctl_bucket"].map(valid_bucket)).sum()),
            "SRCGAP|rfd",
        ),
    ):
        source_coverage.append(
            {
                "source": label,
                "file": source_file,
                "rows": rows_total,
                "unmapped_rows": rows_unmapped,
                "total_mt": round(total_mt, 3),
                "mapped_mt": round(total_mt - unmapped_mt, 3),
                "unmapped_mt": round(unmapped_mt, 3),
                "unmapped_pct": (
                    round(100 * unmapped_mt / total_mt, 2) if total_mt else 0.0
                ),
                "detail_key": key,
            }
        )
    stock_details["SRCGAP|stock"] = [
        {
            "source": f"{r['length_type']} · {r['holder'] or 'no customer'}",
            "plant": r["plant"],
            "sku": r["description"],
            "material_code": r["material_code"],
            "qty": r["stock_mt"],
            "unit": "MT",
        }
        for r in stock_unmapped
    ]
    stock_details["SRCGAP|wip"] = [
        {
            "source": r["reason"] or "No governed bucket",
            "plant": r["plant"],
            "sku": r["description"],
            "material_code": r["material_code"],
            "qty": r["wip_mt"],
            "unit": "MT",
        }
        for r in wip_unmapped
    ]
    stock_details["SRCGAP|rfd"] = [
        {
            "source": r["reason"],
            "plant": "4731",
            "sku": r["size"],
            "material_code": r["listed_code"],
            "qty": r["stock_mt"],
            "unit": "MT",
        }
        for r in rfd_unrecovered
    ]
    stock_analysis = {
        "ctl": build_stock_analysis(stock_scoped[~is_long.reindex(stock_scoped.index, fill_value=False)], "STOCKCTL"),
        "ll": build_stock_analysis(stock_scoped[is_long.reindex(stock_scoped.index, fill_value=False)], "STOCKLL"),
        "source_coverage": source_coverage,
    }

    # The stock analysis and its reconciliation, written out when asked for.
    if os.environ.get("DUMP_ANALYSIS"):
        Path(os.environ["DUMP_ANALYSIS"]).write_text(json.dumps({
            "stock_analysis": _plain(stock_analysis),
            "stock_unmapped": _plain(stock_unmapped),
            "details": _plain({k: v for k, v in stock_details.items()
                               if k.startswith("STOCKCTL|") or k.startswith("STOCKLL|")
                               or k.startswith("SRCGAP|")}),
            "rfd_unbacked_mt": float(rfd_unbacked_mt),
            "rfd_unbacked_materials": int(rfd_unbacked_materials),
            "rfd_partly_backed_materials": int(rfd_partly_backed_materials),
        }))
        print(f"  analysis written to {os.environ['DUMP_ANALYSIS']}")

    # 10. Overdue analysis for TVS ancillaries, from the yf65 receivables ageing file.
    overdue_rows = []
    overdue_unmapped = []
    overdue_excluded = {}
    if not receivables.empty:
        rec = receivables.copy()
        rec["customer_name_key"] = rec["Customer Name"].map(norm_text)
        rec["customer_key"] = rec["Customer Code"].map(norm_code)
        rec["oem"] = rec["customer_name_key"].map(oem_map)
        rec["oem"] = rec["oem"].mask(
            rec["customer_key"].isin(CONVERSION_AGENT_OEM_BY_CODE),
            rec["customer_key"].map(CONVERSION_AGENT_OEM_BY_CODE),
        )
        rec["open_amount"] = pd.to_numeric(rec["Open Amount"], errors="coerce").fillna(0)
        # A receivable falls due RECEIVABLE_DUE_DAYS after the invoice date. This
        # governed term replaces both the per-document Net Due Date and the file's
        # own Due Status flag, whose payment terms vary by document.
        rec["invoice_date"] = pd.to_datetime(rec["Document Date"], errors="coerce")
        # Billing Doc is the invoice number; Document Number is the accounting document.
        rec["invoice_no"] = rec["Billing Doc"].map(
            lambda v: None if pd.isna(v) else str(int(v))
        )
        rec["net_due_date"] = rec["invoice_date"] + pd.Timedelta(days=RECEIVABLE_DUE_DAYS)
        rec["days_overdue"] = (as_of_date - rec["net_due_date"]).dt.days
        # Only billing documents are treated as overdue invoices. Doc types RV and RD
        # are exactly the rows with Nature = BILLING; other types are debit balances,
        # credit notes and collections, which are not invoices to chase.
        rec["doc_type_key"] = rec["Doc Type"].astype(str).str.strip().str.upper()
        rec["nature_key"] = rec["Nature"].astype(str).str.strip().str.upper()
        overdue = rec[
            (rec["days_overdue"] > 0) & rec["doc_type_key"].isin(BILLING_DOC_TYPES)
        ].copy()
        # Open payments and credit notes are not invoices to chase, but they offset
        # what is owed, so report them beside the overdue rather than discarding them.
        # An offset is told by its Nature, not by not being a billing document: the
        # complement of billing also holds debit balances, which add to the exposure
        # rather than reducing it and belong nowhere near this figure.
        offsets = rec[rec["nature_key"].isin(OFFSET_NATURES)].copy()
        tvs_rows = rec[rec["oem"].eq("TVS")]
        # What the two whitelists leave behind — debit balances, and any Nature nobody has
        # seen before. Excluded from the view, not from the record: the QC summary carries
        # the count and the amount per Nature, so setting the debit balances aside is a
        # figure somebody can check rather than a disappearance.
        overdue_excluded = {
            str(nature): {
                "documents": int(len(group)),
                "amount": round(float(group["open_amount"].sum()), 2),
            }
            for nature, group in tvs_rows[
                ~tvs_rows["doc_type_key"].isin(BILLING_DOC_TYPES)
                & ~tvs_rows["nature_key"].isin(OFFSET_NATURES)
            ].groupby("nature_key", dropna=False)
        }
        tvs_overdue = overdue[overdue["oem"].eq("TVS")]
        for name, group in tvs_overdue.groupby("Customer Name", dropna=False):
            detail_key = f"OVERDUE|{name}"
            stock_details[detail_key] = [
                {
                    "invoice_no": d["invoice_no"],
                    "document": f"{d['Doc Type']} {d['Document Number']}",
                    "invoice_date": (
                        d["invoice_date"].date().isoformat()
                        if pd.notna(d["invoice_date"]) else None
                    ),
                    "due_date": (
                        d["net_due_date"].date().isoformat()
                        if pd.notna(d["net_due_date"]) else None
                    ),
                    "age_days": (
                        int(d["days_overdue"]) if pd.notna(d["days_overdue"]) else None
                    ),
                    "qty": float(d["open_amount"]),
                    "unit": "INR",
                }
                # `mergesort` because the default `quicksort` is not stable, and a great
                # many documents share an age: which of two rows the same number of days
                # overdue comes first was decided by the sort's internals rather than by
                # anything here, and so could move between pandas versions with nothing to
                # say it had. Stable makes it the sheet's own order, which is a reason.
                for _, d in group.sort_values(
                    "days_overdue", ascending=False, kind="mergesort").iterrows()
            ]
            offset_group = offsets[offsets["Customer Name"].eq(name)]
            offset_key = f"OFFSET|{name}"
            stock_details[offset_key] = [
                {
                    "document": f"{d['Doc Type']} {d['Document Number']}",
                    "nature": d["Nature"],
                    "posted_on": (
                        d["invoice_date"].date().isoformat()
                        if pd.notna(d["invoice_date"]) else None
                    ),
                    "reference": (
                        None if pd.isna(d["invoice_no"]) else str(d["invoice_no"])
                    ),
                    "qty": float(d["open_amount"]),
                    "unit": "INR",
                }
                # Stable, for the same reason as the ageing sort above: offsets of equal
                # value are common, and their order should come from the sheet.
                for _, d in offset_group.sort_values(
                    "open_amount", kind="mergesort").iterrows()
                if float(d["open_amount"] or 0) != 0
            ]
            aged = group[group["days_overdue"] > 90]["open_amount"].sum()
            debits = group.loc[group["open_amount"] > 0, "open_amount"].sum()
            credits = group.loc[group["open_amount"] < 0, "open_amount"].sum()
            overdue_rows.append(
                {
                    "ancillary": name,
                    "customer_code": first_unique(group["customer_key"]),
                    "overdue_amount": round(float(group["open_amount"].sum()), 2),
                    "documents": int(len(group)),
                    "oldest_days": (
                        int(group["days_overdue"].max())
                        if group["days_overdue"].notna().any() else None
                    ),
                    "over_90_days_amount": round(float(aged), 2),
                    "offsets_amount": round(float(offset_group["open_amount"].sum()), 2),
                    "offsets_documents": int(len(offset_group)),
                    "offsets_detail_key": offset_key,
                    "overdue_debits": round(float(debits), 2),
                    "overdue_credits": round(float(credits), 2),
                    "detail_key": detail_key,
                }
            )
        overdue_rows.sort(key=lambda r: r["overdue_amount"], reverse=True)
        overdue_unmapped = [
            {
                "customer": name,
                "overdue_amount": round(float(group["open_amount"].sum()), 2),
                "documents": int(len(group)),
            }
            for name, group in overdue[overdue["oem"].isna()].groupby(
                "Customer Name", dropna=False
            )
        ]

    # 11. Megh Steel SKU tracker, driven by the RM tracker's `vsm stock` sheet.
    # That sheet is the operating plan for what Megh converts: it carries the schedule,
    # what is on the ground, what is in transit and what has been ordered, all in kg
    # (Stock reconciles to NOS x Wt/Len, and its own Coverage = Stock / Schedule x 30).
    vsm_stock = src.frame("vsm_stock")

    def cut_type(end_condition):
        text = str(end_condition or "").strip().upper()
        return "FC" if text in {"FC", "FIN CUT"} else "NFC"

    for column in ("Schedule", "Stock", "In Transit", "NOS"):
        vsm_stock[column] = pd.to_numeric(vsm_stock[column], errors="coerce").fillna(0)
    order_columns = [c for c in vsm_stock.columns if str(c).strip().endswith("Order")]
    vsm_stock["orders_kg"] = sum(
        pd.to_numeric(vsm_stock[c], errors="coerce").fillna(0) for c in order_columns
    )
    # Only rows the plan is actually tracking.
    vsm_stock = vsm_stock[
        (vsm_stock["Schedule"] != 0) | (vsm_stock["Stock"] != 0)
    ].copy()
    plant_code_columns = [c for c in ("056", "0789", "0788") if c in vsm_stock.columns]

    # Normalise the plan's mixed length units before anything keys on them, so the SKU
    # key, the tab and the length-bucketing all agree on one unit.
    vsm_stock["Length"] = pd.to_numeric(vsm_stock["Length"], errors="coerce")
    vsm_stock["Length"] = vsm_stock["Length"].where(
        vsm_stock["Length"] <= VSM_LENGTH_MM_ABOVE_M, vsm_stock["Length"] / 1000
    )

    # Take the key the plan states rather than deriving one. `length key` is the owner's
    # own statement of what each SKU joins on, so the pipeline no longer has to infer a
    # cut token from an end condition the two sources disagree about. Deriving from the
    # governed bucket plus `Length` remains only as a fallback for a row stating none.
    #
    # The `Megh-` prefix is read off the **length key**, not `key`. The prefix marks a
    # size Megh supplies onward to RE or HMSIL rather than to TVSM, and four rows carry
    # it on the length key while their `key` column still names a governed TVS bucket
    # (`34.93-0-1.2-ERW 1-FC`). The prefix is the statement of where the material goes,
    # so it decides: those rows hold no TVS bucket, stay out of the assign-a-bucket
    # queue, and take their end OEM from the conversion-agent code that bought them.
    # No row prefixes `key` without also prefixing `length key`, so nothing is lost by
    # reading the one rather than the other.
    plan_key = vsm_stock["key"].map(norm_bucket)
    plan_length_key = vsm_stock["length key"].map(norm_length_key)
    is_megh_only = (
        plan_length_key.where(plan_length_key.notna(), plan_key)
        .fillna("")
        .str.upper()
        .str.startswith(MEGH_KEY_PREFIX.upper())
    )
    vsm_stock["megh_only"] = is_megh_only
    # Only a governed TVS bucket goes in the bucket column. A size destined for RE or
    # HMSIL has none, which is the truth and is what the length-bucketing reports.
    vsm_stock["vsm_bucket"] = plan_key.where(~is_megh_only)
    vsm_stock["vsm_key"] = [
        stated or bucket_vsm_key(bucket, length)
        for stated, bucket, length in zip(
            plan_length_key, vsm_stock["vsm_bucket"], vsm_stock["Length"],
        )
    ]
    # Which OEM a prefixed size actually reaches. The prefix says "not TVSM" but not
    # which of RE and HMSIL, so that is read from the conversion-agent code that has
    # bought it — 943210 is HMSIL and 943211 is RE. Read over the whole sales window the
    # trend files supply, not just the current month, so a size sold in April is still
    # attributed. A size no code has yet bought keeps the honest joint label.
    agent_oem_by_code = {
        code: oem for code, oem in CONVERSION_AGENT_OEM_BY_CODE.items()
        if oem in MEGH_ONWARD_OEMS
    }
    onward_sales = sales_all[["material_key", "customer_key"]]
    onward_sales = onward_sales[onward_sales["customer_key"].isin(agent_oem_by_code)]
    oems_by_code = (
        onward_sales.assign(oem=onward_sales["customer_key"].map(agent_oem_by_code))
        .dropna(subset=["material_key"])
        .groupby("material_key")["oem"]
        .agg(lambda values: sorted(set(values)))
        .to_dict()
    )

    def end_oem_for(row):
        if not row["megh_only"]:
            return TVSM_END_OEM
        found = set()
        for column in plant_code_columns:
            code = norm_code(row[column])
            if code:
                found.update(oems_by_code.get(code, []))
        return " and ".join(sorted(found)) if found else MEGH_ONWARD_UNKNOWN

    vsm_stock["end_oem"] = [end_oem_for(r) for _, r in vsm_stock.iterrows()]

    # The plan states the material codes each plant extends for a SKU, and for a size
    # bound for RE or HMSIL that is the only route to stock and sales: no governed TVS
    # bucket means the bucket join can never reach it. 22 such codes carry 183.923 MT of
    # stock and 181.434 MT of July sales on the 31 July file.
    code_to_vsm_key = {}
    for _, r in vsm_stock.iterrows():
        if not r["vsm_key"]:
            continue
        for column in plant_code_columns:
            code = norm_code(r[column])
            if code and code.isdigit():
                code_to_vsm_key.setdefault(code, r["vsm_key"])

    # The owner's own SKU assignments, from the Megh queue on the Missing mappings tab.
    #
    # The counterpart to the bucket override in section 1, and the same shape for the same
    # reason: this is the single place a material code becomes a plan SKU, so overriding it
    # here is what makes an answer given on that queue actually move tonnage onto the Megh
    # tab. An override rather than a fallback, because a code the plan resolves *wrongly*
    # is exactly the case somebody is correcting.
    #
    # Applied to all three frames rather than to the Megh sales rows alone: an assignment
    # that moved the sales onto a SKU and left the stock behind would show the row sold
    # against cover that reads zero.
    sku_assignments = (assignments or {}).get("megh_sku", {})
    if sku_assignments:
        print(f"  assignments: {len(sku_assignments)} material codes assigned to plan SKUs")
    for frame in (stock, sales, wip):
        # **A material code reaches a plan SKU only because somebody said so** — the plan
        # names the code in its own plant columns, or the owner answered the Megh queue.
        # There is no derived fallback, by the owner's rule (19 Aug 2026): mapping is
        # manual so the data is deterministic.
        #
        # Until then a key was *derived* from the governed bucket plus the length and the
        # plan's own code list consulted only when that produced nothing — which had the
        # Megh tab keyed off Bucketting, the TVSM ancillaries master, and the two masters'
        # spellings deciding whether tonnage landed. On the 14 Aug build, 12 codes the
        # plan itself names sat in the unmapped queue carrying 155.6 MT of 209.9 —
        # PE against FC, `Megh-` prefixes Bucketting knows nothing of, 6.001 m against
        # 6 m — while 37.5 MT landed on SKUs no master had ever tied the code to.
        # A derived key that lands is indistinguishable from a stated one on the tab, so
        # the wrong ones could only be found by reading the queue for what was *missing*.
        # The derived key survives as the queue's suggestion column, where it is checked
        # by a person instead of trusted by a join.
        frame["vsm_key"] = frame["material_key"].map(code_to_vsm_key)
        if sku_assignments:
            frame["vsm_key"] = (
                frame["material_key"].map(sku_assignments).fillna(frame["vsm_key"])
            )
        # Taken off the key rather than the bucket, so a row that reached its SKU by the
        # material-code route carries the family of the SKU it actually met. Read after the
        # override, so an assigned row carries the family of the SKU it was assigned to.
        frame["vsm_family"] = frame["vsm_key"].map(key_family)

    megh_codes = {"943209", "943210", "943211"}
    megh_sales_rows = sales[sales["customer_key"].isin(megh_codes)].copy()
    # Only long length is offered against a Megh SKU; cut pieces cannot be re-cut.
    allocatable = pd.concat([
        stock.loc[is_long & (stock["stock_mt"] > 0),
                  ["vsm_key", "vsm_family", "Plant", "material_key",
                   "Material Description", "stock_mt"]],
        wip.loc[wip["length_m"].ge(LONG_LENGTH_MIN_M) & (wip["wip_mt"] > 0),
                ["vsm_key", "vsm_family", "Plant", "material_key",
                 "Material Description", "wip_mt"]].rename(columns={"wip_mt": "stock_mt"}),
    ], ignore_index=True)

    def megh_detail(frame, key, source, qty_col="stock_mt", unit="MT"):
        """Aggregate a Megh drill-down, resolving column names per frame.

        Stock, WIP and sales frames name their description, plant and customer
        columns differently, so pick whichever this frame actually carries.
        """
        if frame.empty:
            return
        description = next(
            (c for c in ("Material Description", "Material   Description")
             if c in frame.columns), None
        )
        plant = next(
            (c for c in ("Plant", "Supply Plant.", "DESP P LANT") if c in frame.columns),
            None,
        )
        holder = next(
            (c for c in ("CUSTOMER NAME", "CUSTOMER  NAME") if c in frame.columns), None
        )
        group_cols = [c for c in (plant, "material_key", description, holder) if c]
        grouped = (
            frame.groupby(group_cols, dropna=False, as_index=False)
            .agg(qty=(qty_col, "sum"))
            .sort_values("qty", ascending=False)
        )
        rows = [
            {
                "source": source if not holder or pd.isna(r[holder]) else str(r[holder]),
                "plant": norm_code(r[plant]) if plant else None,
                "sku": None if not description or pd.isna(r[description]) else str(r[description]),
                "material_code": r.get("material_key"),
                "qty": float(r["qty"]),
                "unit": unit,
            }
            for _, r in grouped.iterrows()
            if float(r["qty"] or 0) != 0
        ]
        if rows:
            stock_details[key] = stock_details.get(key, []) + rows

    megh_rows = []
    for sku, group in vsm_stock.dropna(subset=["vsm_key"]).groupby("vsm_key", sort=False):
        first = group.iloc[0]
        # Two different questions, answered from two different columns. The key's cut
        # token exists to make the plan and the stock, sales and WIP frames meet, and
        # the only field all four share is the governed bucket, so it comes from the
        # bucket's end condition. What the SKU actually is comes from the plan's own
        # `FC/NFC` column, which states it outright — FC is fin cut, NFC is not — and
        # is the more reliable answer where a bucket ends in something that says
        # nothing about finning, such as `CEW`.
        cut = cut_type(str(first["vsm_bucket"] or "").split("-")[-1]) \
            if first["vsm_bucket"] else cut_type(first["FC/NFC"])
        stated = str(first["FC/NFC"] or "").strip().upper()
        if stated in {"FC", "FIN CUT"}:
            cut_label = "Fin cut"
        elif stated in {"NFC", "NON FIN", "NON FIN CUT", "PE"}:
            cut_label = "Non fin cut"
        else:
            cut_label = "Fin cut" if cut == "FC" else "Non fin cut"
        # Taken off the key the plan stated, for the same reason the key itself is.
        family = key_family(sku)
        sold = megh_sales_rows[megh_sales_rows["vsm_key"].eq(sku)]
        at_length = allocatable[allocatable["vsm_key"].eq(sku)]
        other_length = allocatable[
            allocatable["vsm_family"].eq(family) & ~allocatable["vsm_key"].eq(sku)
        ]
        materials = sorted({
            norm_code(v) for c in plant_code_columns for v in group[c].dropna()
            if norm_code(v)
        })

        keys = {k: f"MEGH{k.upper()}|{sku}" for k in
                ("stock", "sales", "atlength", "otherlength")}
        stock_details[keys["stock"]] = [
            {"source": src, "plant": "TVSM plan", "sku": sku,
             "material_code": "vsm stock sheet", "qty": qty / 1000, "unit": "MT"}
            for src, qty in (("Ground stock", float(group["Stock"].sum())),
                             ("In transit", float(group["In Transit"].sum())))
            if qty
        ]
        stock_details[f"MEGHSCHEDULE|{sku}"] = [
            {"source": "vsm stock plan", "plant": "TVSM",
             "sku": f"{int(r['S.NO']) if pd.notna(r['S.NO']) else ''} · {r['Grade']} {r['FC/NFC']}",
             "material_code": norm_code(r["Column1"]),
             "qty": float(r["Schedule"]) / 1000, "unit": "MT"}
            for _, r in group.iterrows() if float(r["Schedule"])
        ]
        stock_details[f"MEGHORDERS|{sku}"] = [
            {"source": f"{str(c).strip()} logged", "plant": str(c).replace(" Order", "").strip(),
             "sku": sku, "material_code": "vsm stock sheet",
             "qty": float(pd.to_numeric(group[c], errors="coerce").fillna(0).sum()) / 1000,
             "unit": "MT"}
            for c in order_columns
            if float(pd.to_numeric(group[c], errors="coerce").fillna(0).sum())
        ]
        megh_detail(at_length, keys["atlength"], "Long length at required size")
        megh_detail(other_length, keys["otherlength"], "Long length, other length")

        schedule_mt = float(group["Schedule"].sum()) / 1000
        total_stock_mt = (
            float(group["Stock"].sum()) + float(group["In Transit"].sum())
        ) / 1000
        orders_mt = float(group["orders_kg"].sum()) / 1000
        megh_rows.append({
            "sku": sku,
            "family": family,
            # This row came from the plan. The BOP block below adds rows that did not,
            # and every consumer needs to be able to tell them apart.
            "in_plan": True,
            "plan_note": None,
            # The governed TVS bucket this size belongs to, where it has one. A
            # `Megh-` prefixed size has none by design — it is bound for RE or HMSIL and
            # Bucketting governs TVS — so an empty cell here is the answer, not a gap.
            "bucket": blank_to_none(first["vsm_bucket"]),
            "od": norm_od(first["O D"]),
            "inner_d": "0",
            "thickness": norm_thickness(first["Thk."]),
            "length_m": float(pd.to_numeric(first["Length"], errors="coerce")),
            "grade": str(first["Grade"]).strip(),
            "cut_type": cut_label,
            # Which OEM Megh Steel supplies this size onward to. The plan marks the RE
            # and HMSIL sizes with the key prefix; which of the two comes from the
            # conversion-agent code that has bought it.
            "end_oem": first["end_oem"],
            "materials": materials,
            "schedule_mt": round(float(group["Schedule"].sum()) / 1000, 3),
            "ground_stock_mt": round(float(group["Stock"].sum()) / 1000, 3),
            "transit_stock_mt": round(float(group["In Transit"].sum()) / 1000, 3),
            "total_stock_mt": round(
                (float(group["Stock"].sum()) + float(group["In Transit"].sum())) / 1000, 3
            ),
            "orders_logged_mt": round(float(group["orders_kg"].sum()) / 1000, 3),
            "sales_mt": round(float(sold["sales_mt"].sum()), 3),
            "stock_at_length_mt": round(float(at_length["stock_mt"].sum()), 3),
            "other_length_stock_mt": round(float(other_length["stock_mt"].sum()), 3),
            # Coverage on stock alone, and on stock plus what has been ordered, so the
            # order column can be judged against the 45-day target.
            "coverage_days": (
                round(total_stock_mt / schedule_mt * 30, 1) if schedule_mt > 0 else None
            ),
            "coverage_days_post_order": (
                round((total_stock_mt + orders_mt) / schedule_mt * 30, 1)
                if schedule_mt > 0 else None
            ),
            "stock_detail_key": keys["stock"],
            "orders_detail_key": f"MEGHORDERS|{sku}",
            "sales_detail_key": keys["sales"],
            "at_length_detail_key": keys["atlength"],
            "other_length_detail_key": keys["otherlength"],
        })
    megh_rows.sort(key=lambda r: natural_bucket_key(r["sku"]))
    megh_sku_keys = {r["sku"] for r in megh_rows}

    # Flag the bought-out parts. The list gives dimensions and a nominal length; the plan
    # holds exact cut lengths, so each line takes the nearest length within tolerance and
    # a SKU is claimed once. 19.05 x 2.0 is listed twice, at 5840 and 6000: assigning
    # nearest-first gives them 5.841 and 5.8, where taking each line's own nearest in
    # order would hand 5.841 to both and leave 5.8 unflagged.
    bop_candidates = []
    for index, (dim1, dim2, thickness, length_mm, nos, plant) in enumerate(MEGH_BOP_ITEMS):
        wanted = (norm_od(dim1), f"{dim2:g}", norm_thickness(thickness))
        for row in megh_rows:
            parts = str(row["sku"]).split("-")
            if len(parts) < 4 or tuple(parts[:3]) != wanted:
                continue
            if row["length_m"] is None or pd.isna(row["length_m"]):
                continue
            gap = abs(float(row["length_m"]) * 1000 - length_mm)
            if gap <= MEGH_BOP_LENGTH_TOLERANCE_MM:
                bop_candidates.append((gap, index, row["sku"]))
    bop_candidates.sort()
    bop_by_sku, claimed_lines, claimed_skus = {}, set(), set()
    for gap, index, sku in bop_candidates:
        if index in claimed_lines or sku in claimed_skus:
            continue
        claimed_lines.add(index)
        claimed_skus.add(sku)
        dim1, dim2, thickness, length_mm, nos, plant = MEGH_BOP_ITEMS[index]
        stated = (f"{dim1:g}" + (f"x{dim2:g}" if dim2 else "")
                  + f"x{thickness:g}x{length_mm:g}")
        bop_by_sku[sku] = {
            "nos": int(nos),
            "plant": plant,
            "stated_size": stated,
            "length_gap_mm": round(gap, 1),
        }
    for row in megh_rows:
        entry = bop_by_sku.get(row["sku"])
        row["bop"] = entry is not None
        row["bop_nos"] = entry["nos"] if entry else None
        row["bop_plant"] = entry["plant"] if entry else None
        row["bop_stated_size"] = entry["stated_size"] if entry else None
        row["bop_length_gap_mm"] = entry["length_gap_mm"] if entry else None

    # A listed size the plan does not carry is still a size Megh Steel buys, so it gets
    # its own line item here rather than a footnote under the table — the owner's
    # instruction once 19.05 x 2.0 x 6000 stopped being pulled onto the plan's 5.8 m row.
    # The plan-fed columns read zero because the plan holds nothing for it; what the row
    # can still answer is what long length is available to cut it from, so those columns
    # are joined for real. Grade and cut type are taken from the plan's own rows of the
    # same diameter and thickness when they agree, and read `lookup error` when they do
    # not — a guess there would silently key the row to the wrong family.
    megh_bop_added = []
    for index, (dim1, dim2, thickness, length_mm, nos, plant) in enumerate(MEGH_BOP_ITEMS):
        if index in claimed_lines:
            continue
        od, inner, thk = norm_od(dim1), f"{dim2:g}", norm_thickness(thickness)
        length_m = length_mm / 1000
        # Match siblings on the SKU key's own first three parts, as the claim loop does.
        # The row's `inner_d` cell is not the field to use: the plan writes 0 into it for
        # every row, including the rectangular sections whose key carries the second
        # dimension, so 40 x 25 would take its grade from the 40 x 0 rows.
        siblings = [
            r for r in megh_rows
            if tuple(str(r["sku"]).split("-")[:3]) == (od, inner, thk)
        ]
        grades = {r["grade"] for r in siblings if r["grade"]}
        cuts = {r["cut_type"] for r in siblings if r["cut_type"]}
        grade = next(iter(grades)) if len(grades) == 1 else LOOKUP_ERROR
        cut_label = next(iter(cuts)) if len(cuts) == 1 else LOOKUP_ERROR
        cut = "FC" if cut_label == "Fin cut" else "NFC"
        # The key is the family with the length appended, and the family comes from the
        # siblings rather than being reassembled out of grade and cut type: the plan
        # states the shape and a BOP size has no plan row of its own to state it. Where
        # the siblings disagree there is no family to borrow, and the row says so.
        families = {r["family"] for r in siblings if r.get("family")}
        family = next(iter(families)) if len(families) == 1 else None
        sku = f"{family}-{norm_number(length_m, 4)}" if family \
            else f"{od}-{inner}-{thk}-{LOOKUP_ERROR}-{norm_number(length_m, 4)}"
        if sku in megh_sku_keys:
            # The plan does carry this exact SKU after all, just at a length the
            # tolerance would not bridge. Flag that row instead of adding a duplicate.
            continue
        family = family or key_family(sku)
        stated = (f"{dim1:g}" + (f"x{dim2:g}" if dim2 else "")
                  + f"x{thickness:g}x{length_mm:g}")
        sold = megh_sales_rows[megh_sales_rows["vsm_key"].eq(sku)]
        at_length = allocatable[allocatable["vsm_key"].eq(sku)]
        other_length = allocatable[
            allocatable["vsm_family"].eq(family) & ~allocatable["vsm_key"].eq(sku)
        ]
        keys = {k: f"MEGH{k.upper()}|{sku}" for k in
                ("stock", "sales", "atlength", "otherlength")}
        megh_detail(at_length, keys["atlength"], "Long length at required size")
        megh_detail(other_length, keys["otherlength"], "Long length, other length")
        megh_rows.append({
            "sku": sku,
            "family": family,
            "in_plan": False,
            "plan_note": MEGH_BOP_ADDED_NOTE,
            # No plan row stands behind this size, so there is no plan key to read a
            # governed bucket off. Empty for a different reason than a `Megh-` size's is,
            # and the same on the page.
            "bucket": None,
            "od": od,
            "inner_d": inner,
            "thickness": thk,
            "length_m": float(length_m),
            "grade": grade,
            "cut_type": cut_label,
            # BOP goes to Megh Steel under the TVS conversion code, so the end OEM is
            # not in question the way it is for a `Megh-` prefixed plan size.
            "end_oem": TVSM_END_OEM,
            "materials": [],
            "schedule_mt": 0.0,
            "ground_stock_mt": 0.0,
            "transit_stock_mt": 0.0,
            "total_stock_mt": 0.0,
            "orders_logged_mt": 0.0,
            "sales_mt": round(float(sold["sales_mt"].sum()), 3),
            "stock_at_length_mt": round(float(at_length["stock_mt"].sum()), 3),
            "other_length_stock_mt": round(float(other_length["stock_mt"].sum()), 3),
            "coverage_days": None,
            "coverage_days_post_order": None,
            "stock_detail_key": keys["stock"],
            "orders_detail_key": f"MEGHORDERS|{sku}",
            "sales_detail_key": keys["sales"],
            "at_length_detail_key": keys["atlength"],
            "other_length_detail_key": keys["otherlength"],
            "bop": True,
            "bop_nos": int(nos),
            "bop_plant": plant,
            "bop_stated_size": stated,
            "bop_length_gap_mm": 0.0,
        })
        megh_sku_keys.add(sku)
        megh_bop_added.append({
            "sku": sku,
            "stated_size": stated,
            "nos": int(nos),
            "plant": plant,
            "reason": (
                "no plan row within "
                f"{MEGH_BOP_LENGTH_TOLERANCE_MM} mm of this length; added as its own line"
            ),
        })
    if megh_bop_added:
        megh_rows.sort(key=lambda r: natural_bucket_key(r["sku"]))

    # Megh length-bucketing. Megh Steel buys length-specific sizes, so its governing
    # mapping is the bucket *plus* the length, and `Bucketting` alone cannot supply it:
    # the plan's own `056`/`0789`/`0788` columns name material codes that Bucketting has
    # never heard of. Code 4149395 is the case in point — the plan governs it as
    # 25.4-0-1.6-ERW 1-FC at 5.84 m, Bucketting holds no row for it at all, so the SKU
    # showed on the Megh tab while an order for the same code reached no bucket and was
    # reported as unmapped. This table is that missing mapping, built from the plan
    # itself and offered back as a sheet to paste into the workbook.
    length_bucketing = {}
    # Plan rows that reach no SKU key at all. One 48.6 x 1.6 x 572.5 mm row carries
    # 20 MT of schedule with its key, grade and FC/NFC cells all empty, so it appears on
    # no tab and in no mapping — which is precisely a size that needs assigning, not one
    # to drop silently.
    length_bucketing_unkeyed = []
    for _, r in vsm_stock.iterrows():
        sku = blank_to_none(r["vsm_key"])
        if sku is None:
            missing = [
                label for label, value in (
                    ("bucket key", r["vsm_bucket"]), ("grade", r["Grade"]),
                    ("cut type", r["FC/NFC"]), ("length", r["Length"]),
                    ("OD", r["O D"]), ("thickness", r["Thk."]),
                ) if blank_to_none(value) is None
            ]
            length_bucketing_unkeyed.append({
                "od": norm_od(r["O D"]),
                "thickness": norm_thickness(r["Thk."]),
                "length_m": (
                    None if pd.isna(r["Length"]) else float(r["Length"])
                ),
                "grade": blank_to_none(r["Grade"]),
                "cut_type": blank_to_none(r["FC/NFC"]),
                "missing": ", ".join(missing),
                "schedule_mt": round(
                    float(pd.to_numeric(r["Schedule"], errors="coerce") or 0) / 1000, 3
                ),
                "stock_mt": round(
                    float(pd.to_numeric(r["Stock"], errors="coerce") or 0) / 1000, 3
                ),
            })
            continue
        entry = length_bucketing.setdefault(
            sku,
            {
                "vsm_key": sku,
                "bucket": blank_to_none(r["vsm_bucket"]),
                # A size the planner has keyed `Megh-` is deliberately outside the TVS
                # range, so its empty bucket is the answer rather than a gap to close.
                "megh_only": bool(r["megh_only"]),
                "od": norm_od(r["O D"]),
                "inner_d": "0",
                "thickness": norm_thickness(r["Thk."]),
                "length_m": (
                    None if pd.isna(pd.to_numeric(r["Length"], errors="coerce"))
                    else float(pd.to_numeric(r["Length"], errors="coerce"))
                ),
                "grade": str(r["Grade"]).strip(),
                "cut_type": None,
                "codes": {},
                "megh_only": bool(r["megh_only"]),
                "end_oem": r["end_oem"],
                "notes": set(),
                "schedule_mt": 0.0,
                "stock_mt": 0.0,
            },
        )
        stated = str(r["FC/NFC"] or "").strip().upper()
        entry["cut_type"] = (
            "Fin cut" if stated in {"FC", "FIN CUT"}
            else "Non fin cut" if stated in {"NFC", "NON FIN", "NON FIN CUT", "PE"}
            else entry["cut_type"]
        )
        entry["schedule_mt"] += float(pd.to_numeric(r["Schedule"], errors="coerce") or 0) / 1000
        entry["stock_mt"] += float(pd.to_numeric(r["Stock"], errors="coerce") or 0) / 1000
        for column in plant_code_columns:
            code = norm_code(r[column])
            if not code:
                continue
            # The plan writes a note such as "NEW MCR" where a code has been requested
            # but not yet created. Treating that as a material code would put it in the
            # repository and have the order book try to join on it.
            if code.isdigit():
                entry["codes"].setdefault(code, set()).add(column)
            else:
                entry["notes"].add(f"{column}: {code}")

    # Code to length-specific mapping, the index the order book and the sales dump
    # resolve through when Bucketting has no row for a code.
    megh_code_length_bucket = {}
    for sku, entry in length_bucketing.items():
        for code in entry["codes"]:
            megh_code_length_bucket.setdefault(
                code, (entry["bucket"], entry["length_m"], sku)
            )

    megh_length_bucketing = []
    for sku, entry in sorted(length_bucketing.items(), key=lambda kv: natural_bucket_key(kv[0])):
        codes = sorted(entry["codes"])
        # Which of the plan's codes Bucketting actually governs. A code the plan names
        # and Bucketting does not is precisely why this table has to exist.
        governed = [c for c in codes if c in material_bucket.index]
        megh_length_bucketing.append(
            {
                "vsm_key": sku,
                "bucket": entry["bucket"],
                "od": entry["od"],
                "inner_d": entry["inner_d"],
                "thickness": entry["thickness"],
                "length_m": entry["length_m"],
                "grade": entry["grade"],
                "cut_type": entry["cut_type"],
                "megh_only": entry["megh_only"],
                "end_oem": entry["end_oem"],
                "material_codes": ", ".join(codes),
                "plants": ", ".join(sorted({
                    p for sources in entry["codes"].values() for p in sources
                })),
                "codes_total": len(codes),
                "codes_in_bucketting": len(governed),
                "codes_missing_from_bucketting": ", ".join(
                    c for c in codes if c not in governed
                ) or None,
                "plan_note": ", ".join(sorted(entry["notes"])) or None,
                "tracked_on_megh_tab": sku in megh_sku_keys,
                "schedule_mt": round(entry["schedule_mt"], 3),
                "stock_mt": round(entry["stock_mt"], 3),
            }
        )
    pd.DataFrame(megh_length_bucketing).to_csv(
        output_dir / "megh_length_bucketing.csv", index=False
    )

    # The same mapping as a worksheet for the owner to complete. Three things can be
    # missing on a size and each needs a different entry, so the sheet says which, puts
    # the rows needing work first, and leaves blank columns to fill rather than asking
    # for the answer to be written over data the pipeline produced.
    def assignment_action(row):
        needs = []
        # Only a size that should have a governed bucket and has none needs one.
        if blank_to_none(row["bucket"]) is None and not row["megh_only"]:
            needs.append("assign bucket")
        if blank_to_none(row["material_codes"]) is None:
            needs.append("name a material code")
        # Bucketting governs the TVS range, so a Megh-only size's code being absent from
        # it is the expected state, not a queue item. The column still shows which codes
        # those are.
        if (blank_to_none(row["codes_missing_from_bucketting"]) is not None
                and not row["megh_only"]):
            needs.append("add code to Bucketting")
        return "; ".join(needs) or "complete"

    # On this sheet a blank is ambiguous — it could mean "nothing needed here". Say
    # outright where a lookup was attempted and failed, so the cells to fill in are the
    # cells that read as errors.
    def looked_up(value):
        return LOOKUP_ERROR if blank_to_none(value) is None else value

    megh_sku_mapping = [
        {
            "length_sku_key": r["vsm_key"],
            "current_bucket": (
                f"none - {r['end_oem']} size" if r["megh_only"]
                else looked_up(r["bucket"])
            ),
            "supplied_to": r["end_oem"],
            "od_mm": r["od"],
            "thickness_mm": r["thickness"],
            "length_mm": None if r["length_m"] is None else round(r["length_m"] * 1000, 1),
            "length_m": r["length_m"],
            "grade": looked_up(r["grade"]),
            "cut_type": looked_up(r["cut_type"]),
            "material_codes": looked_up(r["material_codes"]),
            "plants": r["plants"] or None,
            "codes_not_in_bucketting": r["codes_missing_from_bucketting"],
            "plan_note": r["plan_note"],
            "on_megh_tab": "Yes" if r["tracked_on_megh_tab"] else "No",
            "schedule_mt": r["schedule_mt"],
            "stock_mt": r["stock_mt"],
            "what_is_needed": assignment_action(r),
            # Left blank on purpose — these are the columns to fill in and send back.
            "assign_length_bucket": None,
            "assign_bucket": None,
            "assign_material_code": None,
            "remark": None,
        }
        for r in megh_length_bucketing
    ] + [
        # A plan row with no key cannot state one, so the sheet asks for what is missing.
        {
            "length_sku_key": LOOKUP_ERROR,
            "current_bucket": LOOKUP_ERROR,
            "od_mm": r["od"],
            "thickness_mm": r["thickness"],
            "length_mm": None if r["length_m"] is None else round(r["length_m"] * 1000, 1),
            "length_m": r["length_m"],
            "grade": looked_up(r["grade"]),
            "cut_type": looked_up(r["cut_type"]),
            "material_codes": LOOKUP_ERROR,
            "plants": None,
            "codes_not_in_bucketting": None,
            "plan_note": f"plan row has no {r['missing']}",
            "on_megh_tab": "No",
            "schedule_mt": r["schedule_mt"],
            "stock_mt": r["stock_mt"],
            "what_is_needed": f"state {r['missing']}, then assign bucket",
            "assign_length_bucket": None,
            "assign_bucket": None,
            "assign_material_code": None,
            "remark": None,
        }
        for r in length_bucketing_unkeyed
    ]
    megh_sku_mapping.sort(
        key=lambda r: (r["what_is_needed"] == "complete",
                       -r["schedule_mt"], natural_bucket_key(r["length_sku_key"]))
    )
    pd.DataFrame(megh_sku_mapping).to_csv(
        output_dir / "megh_sku_mapping.csv", index=False
    )

    # Megh purchases that reach no VSM SKU need a material-to-SKU assignment.
    unmapped = megh_sales_rows[~megh_sales_rows["vsm_key"].isin(megh_sku_keys)].copy()
    # The key the old derivation would have built, offered as a suggestion and nothing
    # more. It is right often enough to be worth showing and wrong in exactly the ways
    # that made it unfit to be the join — PE for FC, a length the plan rounds differently
    # — so the queue shows it beside the row and a person decides.
    unmapped["suggested_key"] = [
        bucket_vsm_key(b, l)
        for b, l in zip(unmapped["bucket"], unmapped["length_m"])
    ]
    megh_unmapped = [
        {
            "material_code": r["material_key"],
            "description": (
                None if pd.isna(r["Material   Description"])
                else str(r["Material   Description"])
            ),
            "customer": (
                None if pd.isna(r["CUSTOMER  NAME"]) else str(r["CUSTOMER  NAME"])
            ),
            "sales_mt": round(float(r["sales_mt"]), 3),
            "derived_key": r["suggested_key"],
        }
        for _, r in (
            unmapped.groupby(
                ["material_key", "Material   Description", "CUSTOMER  NAME",
                 "suggested_key"],
                dropna=False, as_index=False,
            )
            .agg(sales_mt=("sales_mt", "sum"))
            .sort_values("sales_mt", ascending=False)
            .iterrows()
        )
        if float(r["sales_mt"]) != 0
    ]

    # Round the published components once, then derive the balance from those same
    # figures so the three headline cards reconcile exactly.
    tvs_total_schedule_mt = round(
        float(tvs_schedule["schedule_mt"].sum()) + float(vsm["vsm_schedule_mt"].sum()), 3
    )
    tvs_total_sales_mt = round(float(tvs_total_sales["sales_mt"].sum()), 3)
    tvs_total_open_balance_mt = round(tvs_total_schedule_mt - tvs_total_sales_mt, 3)

    # Two different questions get two different cards, because one number cannot answer
    # both. What TVSM consumed is TSL's direct ancillary billing plus what Megh converted
    # and sold on, which only the RM tracker states. What TSL billed is its direct
    # ancillary billing plus its sales to Megh — a tonne sold to Megh is TSL revenue
    # whether or not it has reached TVSM yet. The two therefore share a term and differ
    # on the second, and neither is a subtotal of the other.
    direct_ancillary_sales = sales[sales["oem_key_oem"].eq("TVS")]
    megh_agent_sales = sales[sales["customer_key"].eq(MEGH_TVS_CUSTOMER_CODE)]
    direct_ancillary_sales_mt = round(float(direct_ancillary_sales["sales_mt"].sum()), 3)
    megh_agent_sales_mt = round(float(megh_agent_sales["sales_mt"].sum()), 3)
    megh_to_tvsm_sales_mt = round(float(vsm["vsm_sales_mt"].sum()), 3)
    tvsm_received_sales_mt = round(
        direct_ancillary_sales_mt + megh_to_tvsm_sales_mt, 3
    )
    tsl_billed_sales_mt = round(direct_ancillary_sales_mt + megh_agent_sales_mt, 3)

    metric_details["SALES|TVSM_RECEIVED"] = [
        {
            "source": "TSL direct to TVSM ancillaries",
            "plant": "TSL",
            "sku": "Sales dump, OEM key 1 rev = TVS",
            "material_code": f"{len(direct_ancillary_sales)} lines",
            "qty": direct_ancillary_sales_mt,
            "unit": "MT",
        },
        {
            "source": "Megh Steel onward to TVSM",
            "plant": "TVSM",
            "sku": "RM Tracker TVSM sheet, VSM Sales",
            "material_code": f"{int(vsm['bucket'].notna().sum())} buckets",
            "qty": megh_to_tvsm_sales_mt,
            "unit": "MT",
        },
    ]
    metric_details["SALES|TSL_BILLED"] = [
        {
            "source": "TSL direct to TVSM ancillaries",
            "plant": "TSL",
            "sku": "Sales dump, OEM key 1 rev = TVS",
            "material_code": f"{len(direct_ancillary_sales)} lines",
            "qty": direct_ancillary_sales_mt,
            "unit": "MT",
        },
        {
            "source": f"TSL to Megh Steel {MEGH_TVS_CUSTOMER_CODE}",
            "plant": "TSL",
            "sku": "Sales dump, conversion agent code",
            "material_code": f"{len(megh_agent_sales)} lines",
            "qty": megh_agent_sales_mt,
            "unit": "MT",
        },
    ]

    metric_details["SCHEDULE|TVS_TOTAL"] = [
        {
            "source": "Schedule July (OEM TVS)",
            "plant": "TSL",
            "sku": "TVS schedule lines",
            "material_code": f"{len(tvs_schedule)} lines",
            "qty": round(float(tvs_schedule["schedule_mt"].sum()), 3),
            "unit": "MT",
        },
        {
            "source": "RM Tracker TVSM",
            "plant": "TVSM",
            "sku": "VSM Requirement",
            "material_code": f"{int(vsm['bucket'].notna().sum())} buckets",
            "qty": round(float(vsm["vsm_schedule_mt"].sum()), 3),
            "unit": "MT",
        },
    ]
    metric_details["BALANCE|TVS_TOTAL"] = [
        {
            "source": "Total schedule",
            "plant": "Formula input",
            "sku": "TSL + TVSM",
            "material_code": "schedule - sales",
            "qty": tvs_total_schedule_mt,
            "unit": "MT",
        },
        {
            "source": "Less total sales",
            "plant": "Formula input",
            "sku": "TVS + conversion agent",
            "material_code": "subtracted",
            "qty": tvs_total_sales_mt,
            "unit": "MT",
        },
    ]
    metric_details["SALES|TVS_TOTAL"] = [
        {
            "source": (
                "OEM key 1 rev = TVS"
                if row["oem_key_oem"] == "TVS"
                else "Conversion agent routed to TVS"
            ),
            "plant": "TVS",
            "sku": None if pd.isna(row["CUSTOMER  NAME"]) else str(row["CUSTOMER  NAME"]),
            "material_code": row["customer_key"],
            "qty": float(row["qty"]),
            "unit": "MT",
        }
        for _, row in (
            tvs_total_sales.groupby(
                ["oem_key_oem", "customer_key", "CUSTOMER  NAME"],
                dropna=False,
                as_index=False,
            )
            .agg(qty=("sales_mt", "sum"))
            .sort_values("qty", ascending=False)
            .iterrows()
        )
    ]

    # 12. Inter-plant transfers. The transfer dump is one row per despatched line:
    # `DESP P LANT` is the sending plant, `CUSTOMER CD`/`CUSTOMER NAME` name the
    # receiving plant, and a line stays in transit until the receiving plant posts a
    # goods receipt, so an empty `GR DATE` is the in-transit flag. Quantity is in kg.
    transfer_rows = []
    transfer_plants = {"source": [], "destination": []}
    transfers_available = False
    transfers_note = "No transfer dump was supplied."
    # Plant names come from the transfer dump, which is optional. The STR plan labels
    # plants whether or not it was supplied, so the lookup is created empty here and
    # filled in below when the dump is present.
    plant_names = {}

    def plant_label(code):
        if code is None or (isinstance(code, float) and pd.isna(code)):
            return None
        name = plant_names.get(code)
        return f"{code} - {name}" if name and not pd.isna(name) else str(code)

    if not transfers_raw.empty:
        tf = transfers_raw.copy()
        tf.columns = [re.sub(r"\s+", " ", str(c)).strip() for c in tf.columns]
        invoice_type = tf.get("Invoice Type", pd.Series(dtype=object)).astype(str).str.upper()
        is_transfer = invoice_type.str.contains(TRANSFER_INVOICE_MARKER, na=False)
        tf = tf[is_transfer & tf["DESP P LANT"].notna()].copy()
        if tf.empty:
            # The daily mail has more than once carried a copy of the sales dump under
            # the transfer filename. Sales lines never carry a transfer invoice type,
            # so an empty result here means the file is not a transfer extract.
            transfers_note = (
                "The supplied transfer.xlsx contains no transfer invoice lines; "
                "it is not a transfer extract."
            )
    else:
        tf = pd.DataFrame()
    if not tf.empty:
        transfers_available = True
        transfers_note = None
        tf["source_plant"] = tf["DESP P LANT"].map(norm_code)
        tf["dest_plant"] = tf["CUSTOMER CD"].map(norm_code)
        source_names = (
            tf.dropna(subset=["source_plant"])
            .groupby("source_plant")["PLANT DESC"]
            .agg(first_unique)
            .to_dict()
        )
        dest_names = (
            tf.dropna(subset=["dest_plant"])
            .groupby("dest_plant")["CUSTOMER NAME"]
            .agg(first_unique)
            .to_dict()
        )
        plant_names.update({**source_names, **dest_names})

        tf["material_key"] = tf["MATERAIL NUMBER"].map(norm_code)
        tf["description_key"] = tf["Material Description"].map(norm_desc)
        code_bucket = tf["material_key"].map(material_bucket)
        tf["bucket"] = code_bucket.fillna(tf["description_key"].map(description_bucket))
        tf["length_m"] = tf["description_key"].map(description_length)
        tf["length_m"] = tf["length_m"].fillna(tf["material_key"].map(material_length))
        tf["ctl_bucket"] = [
            make_ctl_bucket(bucket, length)
            for bucket, length in zip(tf["bucket"], tf["length_m"])
        ]
        tf["is_long"] = tf["length_m"].ge(LONG_LENGTH_MIN_M)
        tf["qty_mt"] = pd.to_numeric(tf["Quantity"], errors="coerce").fillna(0) / 1000
        tf["qty_nos"] = pd.to_numeric(tf["qty in no"], errors="coerce").fillna(0)
        tf["billing_date"] = pd.to_datetime(tf["BILLING DATE"], errors="coerce")
        tf["grn_date"] = pd.to_datetime(tf["GR DATE"], errors="coerce")
        tf["in_transit"] = tf["grn_date"].isna()
        # Days in transit runs to the goods receipt once posted, and to the as-of date
        # while the line is still open.
        tf["transit_days"] = (
            tf["grn_date"].fillna(as_of_date) - tf["billing_date"]
        ).dt.days
        tf["document"] = tf["Billing Document Number"].map(norm_code)
        tf["sto_no"] = tf["DO/STO NO"].map(norm_code)
        tf["mark_customer"] = tf["MARK DESTINATION"].where(
            tf["MARK DESTINATION"].notna(), tf["MARK CUSTOMER"].map(norm_code)
        )
        transfer_plants = {
            "source": sorted(
                ({"code": c, "label": plant_label(c)} for c in source_names),
                key=lambda item: item["code"],
            ),
            "destination": sorted(
                ({"code": c, "label": plant_label(c)} for c in dest_names),
                key=lambda item: item["code"],
            ),
        }
        group_keys = [
            "source_plant", "dest_plant", "document", "material_key",
            "Material Description", "bucket", "ctl_bucket", "in_transit",
        ]
        grouped_tf = (
            tf.groupby(group_keys, dropna=False, as_index=False)
            .agg(
                qty_mt=("qty_mt", "sum"),
                qty_nos=("qty_nos", "sum"),
                batches=("BATCH", "nunique"),
                billing_date=("billing_date", "min"),
                grn_date=("grn_date", "max"),
                transit_days=("transit_days", "max"),
                sto_no=("sto_no", first_unique),
                mark_customer=("mark_customer", first_unique),
                is_long=("is_long", "max"),
            )
        )

        def transfer_lines(scope):
            """Batch-level detail behind a transfer quantity."""
            detail = (
                scope.groupby(
                    ["BATCH", "source_plant", "dest_plant", "document",
                     "billing_date", "grn_date", "in_transit", "mark_customer"],
                    dropna=False, as_index=False,
                )
                .agg(qty=("qty_mt", "sum"))
                .sort_values("qty", ascending=False)
            )
            return [
                {
                    "batch": None if pd.isna(d["BATCH"]) else str(d["BATCH"]),
                    "source_plant_label": plant_label(d["source_plant"]),
                    "dest_plant_label": plant_label(d["dest_plant"]),
                    "document": d["document"],
                    "billing_date": (
                        None if pd.isna(d["billing_date"])
                        else d["billing_date"].date().isoformat()
                    ),
                    "grn_date": (
                        None if pd.isna(d["grn_date"])
                        else d["grn_date"].date().isoformat()
                    ),
                    "status": "In transit" if d["in_transit"] else "Received",
                    "mark_customer": (
                        None if pd.isna(d["mark_customer"]) else str(d["mark_customer"])
                    ),
                    "qty": float(d["qty"]),
                    "unit": "MT",
                }
                for _, d in detail.iterrows()
            ]

        for index, agg in grouped_tf.sort_values(
            ["in_transit", "billing_date"], ascending=[False, False]
        ).iterrows():
            detail_key = f"TRANSFER|{index}"
            scope = tf[
                tf["source_plant"].eq(agg["source_plant"])
                & tf["dest_plant"].eq(agg["dest_plant"])
                & tf["document"].eq(agg["document"])
                & tf["material_key"].eq(agg["material_key"])
                & tf["in_transit"].eq(agg["in_transit"])
            ]
            stock_details[detail_key] = transfer_lines(scope)
            transfer_rows.append(
                {
                    "source_plant": agg["source_plant"],
                    "source_plant_label": plant_label(agg["source_plant"]),
                    "dest_plant": agg["dest_plant"],
                    "dest_plant_label": plant_label(agg["dest_plant"]),
                    "document": agg["document"],
                    "sto_no": None if pd.isna(agg["sto_no"]) else str(agg["sto_no"]),
                    "material_code": agg["material_key"],
                    "description": (
                        None if pd.isna(agg["Material Description"])
                        else str(agg["Material Description"])
                    ),
                    "bucket": None if pd.isna(agg["bucket"]) else str(agg["bucket"]),
                    "ctl_bucket": (
                        None if pd.isna(agg["ctl_bucket"]) else str(agg["ctl_bucket"])
                    ),
                    "length_type": "LL" if bool(agg["is_long"]) else "CTL",
                    "billing_date": (
                        None if pd.isna(agg["billing_date"])
                        else agg["billing_date"].date().isoformat()
                    ),
                    "grn_date": (
                        None if pd.isna(agg["grn_date"])
                        else agg["grn_date"].date().isoformat()
                    ),
                    "status": "In transit" if agg["in_transit"] else "Received",
                    "in_transit": bool(agg["in_transit"]),
                    "transit_days": (
                        None if pd.isna(agg["transit_days"]) else int(agg["transit_days"])
                    ),
                    "mark_customer": (
                        None if pd.isna(agg["mark_customer"])
                        else str(agg["mark_customer"])
                    ),
                    "qty_mt": round(float(agg["qty_mt"]), 3),
                    "qty_nos": float(agg["qty_nos"]),
                    "batches": int(agg["batches"]),
                    "detail_key": detail_key,
                }
            )

    # 13. Stock transfer plan for Hosur EPA (8406). 8406 is an external processing
    # agent for the Hosur ancillary cluster: it receives tube from the sending plants
    # and cuts it to the customer's lengths on site. Cover is therefore held at bucket
    # level, so long lengths already standing there count towards the plan, and the
    # plan is stated per bucket rather than per customer because a single STR line
    # serves whichever plan customer draws on it first.
    #
    # Cover held at 8406 counts ground stock earmarked to the plan customers plus
    # everything already on the road to 8406, because a line in transit will be on the
    # ground before the 15 days are out. The requirement is the balance of that
    # against 15 days of the July schedule.
    #
    # Schedule July names a customer by its Helper Customer; the stock and transfer
    # dumps name it by its SAP customer code or name. Bridge the two through the sales
    # dump's code/name pairs, and drop any code the schedule uses under more than one
    # Helper Customer so an ambiguous code can never move stock into the plan.
    display_by_code = {}
    ambiguous_codes = set()
    for _, row in schedule_group.iterrows():
        for code in row["customer_codes"]:
            existing = display_by_code.setdefault(code, row["customer_display"])
            if existing != row["customer_display"]:
                ambiguous_codes.add(code)
    display_by_code = {
        code: display for code, display in display_by_code.items()
        if code not in ambiguous_codes
    }
    code_by_customer_name = dict(
        zip(
            sales.dropna(subset=["customer_name_key", "customer_key"])["customer_name_key"],
            sales.dropna(subset=["customer_name_key", "customer_key"])["customer_key"],
        )
    )
    str_customers = list(STR_CUSTOMERS)
    # Stock at the destination plant, resolved to a plan customer.
    dest_stock = stock[
        stock["Plant"].eq(STR_DESTINATION_PLANT) & (stock["stock_mt"] > 0)
    ].copy()
    dest_stock["customer_code"] = dest_stock["customer_name_key"].map(code_by_customer_name)
    dest_stock["plan_customer"] = dest_stock["customer_code"].map(display_by_code)
    str_unmapped_dest_stock = [
        {
            "customer_name": None if pd.isna(r["CUSTOMER NAME"]) else str(r["CUSTOMER NAME"]),
            "customer_code": None if pd.isna(r["customer_code"]) else str(r["customer_code"]),
            "stock_mt": round(float(r["stock_mt"]), 3),
        }
        for _, r in (
            dest_stock[dest_stock["plan_customer"].isna() & ~dest_stock["is_transit"]]
            .groupby(["CUSTOMER NAME", "customer_code"], dropna=False, as_index=False)
            .agg(stock_mt=("stock_mt", "sum"))
            .sort_values("stock_mt", ascending=False)
            .iterrows()
        )
    ]
    dest_owned = dest_stock[dest_stock["plan_customer"].isin(str_customers)]
    dest_owned_pool = dest_owned.groupby("bucket", dropna=False)["stock_mt"].sum()
    # Tonnage already despatched towards the destination and not yet received.
    if transfers_available:
        inbound = tf[tf["dest_plant"].eq(STR_DESTINATION_PLANT) & tf["in_transit"]]
        inbound_transit = inbound.groupby("bucket", dropna=False)["qty_mt"].sum()
    else:
        inbound = pd.DataFrame()
        inbound_transit = pd.Series(dtype=float)
    # PLANT STOCKS books the same pipeline at the receiving plant, so the two sources
    # overlap almost completely at batch level (40 of 41 transit batches at 8406 on the
    # 27 July set). Take the transfer dump as authoritative, because it names the
    # sending plant and the invoice, and add only the transit batches it does not
    # already carry.
    inbound_batches = (
        set(inbound["BATCH"].dropna().astype(str)) if not inbound.empty else set()
    )
    dest_transit_rows = dest_stock[
        dest_stock["is_transit"]
        & ~dest_stock["BATCH"].astype(str).isin(inbound_batches)
    ]
    dest_transit_pool = dest_transit_rows.groupby("bucket", dropna=False)["stock_mt"].sum()

    # Stock the sending plants could raise an STR on, per bucket. Two sources feed it:
    # finished goods standing at 0789/0788/4731, and mother tubes in WIP at 0789. A
    # mother tube cannot be transferred under its own PTM code, so it is offered under
    # the finished-goods code that shares its description and carries a remark saying
    # where it came from.
    source_availability = {}
    str_wip_unresolved = []
    source_stock = stock[
        stock["Plant"].isin(STR_SOURCE_PLANTS)
        & (stock["stock_mt"] > 0)
        & ~stock["is_transit"]
        & stock["bucket"].notna()
    ].copy()
    # Same union rule as the stock view: the CTL/LL flag alone strands rows whose
    # description carries a length range and leaves LENGTH at zero.
    source_stock["is_long"] = (
        source_stock["CTL/LL"].astype(str).str.upper().str.strip().eq("LL")
        | source_stock["length_m"].ge(LONG_LENGTH_MIN_M)
    )
    for _, r in (
        source_stock.groupby(
            ["bucket", "Plant", "material_key", "Material Description", "CUSTOMER NAME",
             "is_long"],
            dropna=False, as_index=False,
        )
        .agg(qty=("stock_mt", "sum"))
        .iterrows()
    ):
        source_availability.setdefault(r["bucket"], []).append(
            {
                "plant": r["Plant"],
                "plant_label": plant_label(r["Plant"]),
                "material_code": r["material_key"],
                "description": (
                    None if pd.isna(r["Material Description"])
                    else str(r["Material Description"])
                ),
                "holder": None if pd.isna(r["CUSTOMER NAME"]) else str(r["CUSTOMER NAME"]),
                "source": "Plant stock",
                "remark": "" if r["is_long"] else "Cut length only",
                "from_wip": False,
                "is_long": bool(r["is_long"]),
                "qty": round(float(r["qty"]), 3),
                "str_qty": 0.0,
            }
        )
    wip_source = wip[wip["bucket"].notna() & (wip["wip_mt"] > 0)].copy()
    wip_source["plant_key"] = wip_source["Plant"].map(norm_code)
    wip_source = wip_source[wip_source["plant_key"].isin(STR_SOURCE_PLANTS)]
    for _, r in (
        wip_source.groupby(
            ["bucket", "plant_key", "description_key", "Material Description"],
            dropna=False, as_index=False,
        )
        .agg(qty=("wip_mt", "sum"))
        .iterrows()
    ):
        fg_code, fg_description = fg_code_for_mother_tube(
            r["description_key"], r["plant_key"], r["bucket"]
        )
        mother_tube = (
            None if pd.isna(r["Material Description"]) else str(r["Material Description"])
        )
        if fg_code is None:
            str_wip_unresolved.append(
                {
                    "plant": r["plant_key"],
                    "bucket": r["bucket"],
                    "description": mother_tube,
                    "wip_mt": round(float(r["qty"]), 3),
                }
            )
            continue
        source_availability.setdefault(r["bucket"], []).append(
            {
                "plant": r["plant_key"],
                "plant_label": plant_label(r["plant_key"]),
                "material_code": fg_code,
                "description": fg_description,
                "holder": None,
                "source": "WIP ystockn",
                "remark": f"From WIP: {mother_tube}",
                "from_wip": True,
                "is_long": True,
                "qty": round(float(r["qty"]), 3),
                "str_qty": 0.0,
            }
        )
    # 8406 cuts to order, so a long length serves any of the customer's lengths while a
    # cut length only serves its own. Offer long lengths first, finished goods before
    # mother tubes, and the largest holding first inside each, so the plan asks for as
    # few STR lines as it can and asks for the most usable stock first.
    for lines in source_availability.values():
        lines.sort(
            key=lambda line: (
                not line["is_long"], line["from_wip"], -line["qty"],
                line["material_code"] or "",
            )
        )

    days_in_month = int(month_end.day)
    plan_scope = schedule_group[schedule_group["customer_display"].isin(str_customers)]
    plan_lines = plan_scope[plan_scope["bucket"].map(valid_bucket)]
    # Schedule July leaves a few plan lines with no Bucket. They cannot be matched to
    # stock, so they carry no transfer requirement; report the tonnage rather than let
    # the plan quietly understate demand.
    str_unbucketed = [
        {
            "customer": r["customer_display"],
            "schedule_mt": round(float(r["schedule_mt"]), 3),
            "lines": int(r["lines"]),
        }
        for _, r in (
            plan_scope[~plan_scope["bucket"].map(valid_bucket)]
            .groupby("customer_display", as_index=False)
            .agg(schedule_mt=("schedule_mt", "sum"), lines=("schedule_mt", "size"))
            .sort_values("schedule_mt", ascending=False)
            .iterrows()
        )
    ]
    plan_lines = (
        plan_lines.groupby("bucket", dropna=False, as_index=False)
        .agg(
            schedule_mt=("schedule_mt", "sum"),
            sales_mt=("sales_mt", "sum"),
            open_balance_mt=("open_balance_mt", "sum"),
            cut_lengths=("ctl_length", lambda s: sorted({
                round(float(v), 3) for v in s if pd.notna(v) and float(v) > 0
            })),
            customers=("customer_display", lambda s: sorted(set(s))),
        )
    )
    # Buckets the plan customers hold at 8406 but have no July schedule against.
    idle_at_dest = [
        {"bucket": bucket, "schedule_mt": 0.0, "sales_mt": 0.0, "open_balance_mt": 0.0,
         "cut_lengths": [], "customers": []}
        for bucket in dest_owned_pool.index
        if bucket is not None
        and not pd.isna(bucket)
        and not (plan_lines["bucket"] == bucket).any()
    ]
    if idle_at_dest:
        plan_lines = pd.concat(
            [plan_lines, pd.DataFrame(idle_at_dest)], ignore_index=True
        )

    str_rows = []
    for _, row in plan_lines.iterrows():
        bucket = row["bucket"]
        schedule_mt = float(row["schedule_mt"] or 0)
        daily_mt = schedule_mt / days_in_month if days_in_month else 0.0
        requirement_mt = STR_TARGET_DAYS * daily_mt
        owned_mt = float(dest_owned_pool.get(bucket, 0) or 0)
        transit_mt = float(inbound_transit.get(bucket, 0) or 0) + float(
            dest_transit_pool.get(bucket, 0) or 0
        )
        at_dest = owned_mt + transit_mt
        if schedule_mt <= 0 and at_dest <= 0:
            continue
        coverage_days = (at_dest / daily_mt) if daily_mt > 0 else None
        required_mt = max(0.0, requirement_mt - at_dest)
        # Allocate the requirement across what the sending plants hold, largest ready
        # holding first. The allocation is what the copy button places as STR lines.
        available = source_availability.get(bucket, [])
        outstanding = required_mt
        str_lines = []
        for line in available:
            take = min(line["qty"], outstanding) if outstanding > 0 else 0.0
            outstanding = max(0.0, outstanding - take)
            allocated = dict(line)
            allocated["str_qty"] = round(take, 3)
            str_lines.append(allocated)
        source_mt = sum(line["qty"] for line in available)
        dest_key = f"STRDEST|{bucket}"
        scope = dest_owned[dest_owned["bucket"].eq(bucket)]
        stock_details[dest_key] = [
            {
                "batch": None if pd.isna(d["BATCH"]) else str(d["BATCH"]),
                "plant": STR_DESTINATION_PLANT,
                "material_code": d["material_key"],
                "description": (
                    None if pd.isna(d["Material Description"])
                    else str(d["Material Description"])
                ),
                "holder": None if pd.isna(d["CUSTOMER NAME"]) else str(d["CUSTOMER NAME"]),
                "ageing_date": (
                    as_of_date - pd.Timedelta(days=int(d["age_now"]))
                ).date().isoformat(),
                "age_days": int(d["age_now"]),
                "age_days_month_end": int(d["age_me"]),
                "qty": float(d["qty"]),
                "unit": "MT",
            }
            # `mergesort` for the reason the overdue and stock-analysis sorts already are:
            # the default is not stable, and batches of one bucket routinely hold identical
            # tonnage, so which of two printed first was decided by the sort's internals.
            for _, d in (
                scope.groupby(
                    ["BATCH", "material_key", "Material Description", "CUSTOMER NAME"],
                    dropna=False, as_index=False,
                )
                .agg(
                    qty=("stock_mt", "sum"),
                    age_now=("ageing_days", "max"),
                    age_me=("ageing_days_month_end", "max"),
                )
                .sort_values("qty", ascending=False, kind="mergesort")
                .iterrows()
            )
        ]
        # Everything on the road to 8406, from both sources, so the 8406 column can be
        # opened and read line by line alongside the ground stock above.
        if transfers_available and not inbound.empty:
            stock_details[dest_key] += [
                {
                    "batch": None if pd.isna(d["BATCH"]) else str(d["BATCH"]),
                    "plant": d["source_plant"],
                    "material_code": d["material_key"],
                    "description": d["document"],
                    "holder": "In transit to 8406",
                    "ageing_date": None,
                    "age_days": None,
                    "age_days_month_end": None,
                    "qty": float(d["qty"]),
                    "unit": "MT",
                }
                for _, d in (
                    inbound[inbound["bucket"].eq(bucket)]
                    .groupby(
                        ["BATCH", "source_plant", "document", "material_key"],
                        dropna=False, as_index=False,
                    )
                    .agg(qty=("qty_mt", "sum"))
                    .sort_values("qty", ascending=False, kind="mergesort")
                    .iterrows()
                )
            ]
        stock_details[dest_key] += [
            {
                "batch": None if pd.isna(d["BATCH"]) else str(d["BATCH"]),
                "plant": STR_DESTINATION_PLANT,
                "material_code": d["material_key"],
                "description": (
                    None if pd.isna(d["Material Description"])
                    else str(d["Material Description"])
                ),
                "holder": "In transit, no matching transfer line",
                "ageing_date": None,
                "age_days": None,
                "age_days_month_end": None,
                "qty": float(d["qty"]),
                "unit": "MT",
            }
            for _, d in (
                dest_transit_rows[dest_transit_rows["bucket"].eq(bucket)]
                .groupby(
                    ["BATCH", "material_key", "Material Description"],
                    dropna=False, as_index=False,
                )
                .agg(qty=("stock_mt", "sum"))
                .sort_values("qty", ascending=False, kind="mergesort")
                .iterrows()
            )
        ]
        def source_detail(lines):
            return [
                {
                    "plant": line["plant"],
                    "material_code": line["material_code"],
                    "description": line["description"],
                    "holder": line["holder"],
                    "source": line["source"],
                    "remark": line["remark"],
                    "str_qty": line["str_qty"],
                    "qty": line["qty"],
                    "unit": "MT",
                }
                for line in lines
            ]

        source_key = f"STRSOURCE|{bucket}"
        stock_details[source_key] = source_detail(str_lines)
        # Each sending plant is read on its own, because an STR is raised on one plant
        # and a planner needs to see which of the three can actually supply the gap.
        source_by_plant = {}
        for plant in STR_SOURCE_PLANTS:
            plant_lines = [line for line in str_lines if line["plant"] == plant]
            plant_key = f"STRSOURCE|{bucket}|{plant}"
            stock_details[plant_key] = source_detail(plant_lines)
            source_by_plant[plant] = {
                "stock_mt": round(sum(line["qty"] for line in plant_lines), 3),
                "str_qty_mt": round(sum(line["str_qty"] for line in plant_lines), 3),
                "detail_key": plant_key,
            }
        if coverage_days is None:
            risk = "No schedule"
        elif coverage_days < STR_TARGET_DAYS:
            risk = "Short"
        elif coverage_days < 2 * STR_TARGET_DAYS:
            risk = "Watch"
        else:
            risk = "Covered"
        str_rows.append(
            {
                "bucket": bucket,
                "customers": list(row["customers"] or []),
                "cut_lengths": list(row["cut_lengths"] or []),
                "schedule_mt": round(schedule_mt, 3),
                "sales_mt": round(float(row["sales_mt"] or 0), 3),
                "balance_mt": round(float(row["open_balance_mt"] or 0), 3),
                "daily_mt": round(daily_mt, 4),
                "requirement_mt": round(requirement_mt, 3),
                "owned_8406_mt": round(owned_mt, 3),
                "in_transit_mt": round(transit_mt, 3),
                "stock_8406_mt": round(at_dest, 3),
                "coverage_days": None if coverage_days is None else round(coverage_days, 1),
                "str_required_mt": round(required_mt, 3),
                "str_allocated_mt": round(sum(l["str_qty"] for l in str_lines), 3),
                "str_shortfall_mt": round(outstanding, 3),
                "source_stock_mt": round(source_mt, 3),
                "source_plants": list(STR_SOURCE_PLANTS),
                "source_by_plant": source_by_plant,
                "risk": risk,
                "stock_detail_key": dest_key,
                "source_detail_key": source_key,
                "str_lines": [
                    {
                        "plant": l["plant"],
                        "plant_label": l["plant_label"],
                        "material_code": l["material_code"],
                        "description": l["description"],
                        "source": l["source"],
                        "remark": l["remark"],
                        "from_wip": l["from_wip"],
                        "available_mt": l["qty"],
                        "qty_mt": l["str_qty"],
                    }
                    for l in str_lines if l["str_qty"] > 0
                ],
            }
        )
    str_rows.sort(
        key=lambda r: (-r["str_required_mt"], natural_bucket_key(r["bucket"]))
    )
    str_wip_unresolved.sort(key=lambda r: -r["wip_mt"])

    # 14. SKU pricing. Every scheduled SKU is priced off the customer contract: a base
    # price for the size, plus the value-added operations that SKU carries. The base
    # sheet quotes a price per tonne and per metre for each contract quarter; the view
    # carries the three most recent.
    #
    # The contract names a size by `Key` — dimension1-dimension2-thickness, with the
    # second dimension empty for a round tube — which is the same shape as the first
    # three parts of a governed Bucket. That is the join, and it is what makes the
    # contract addressable from the schedule at all.
    pricing_rows = []
    pricing_unpriced = []
    pricing_corrections = 0
    pricing_available = bool(contract_sheets)
    pricing_note = None if pricing_available else "No contract price sheet was supplied."
    contract_index = {}
    if pricing_available:
        for route, spec in PRICING_SHEETS.items():
            frame = contract_sheets[route]
            # Rows 0-2 are the three header bands: quarter group, sub-group, column name.
            for _, row in frame.iloc[3:].iterrows():
                parsed = size_key(row[spec["key_col"]])
                if parsed is None:
                    continue
                dim1, dim2, thickness, parts = parsed
                prices = {}
                for quarter, (ton_col, metre_col) in spec["quarters"].items():
                    per_ton = pd.to_numeric(row[ton_col], errors="coerce")
                    per_metre = pd.to_numeric(row[metre_col], errors="coerce")
                    # The quarter's increase sits immediately left of its per-tonne
                    # price on both sheets — `Q1 delta / ton`, `Q1 base price / ton`.
                    # The Megh reconciliation states it as its own column, so it is read
                    # here rather than inferred by subtracting one quarter from another,
                    # which would be wrong wherever a correction column sits between.
                    delta = pd.to_numeric(row[ton_col - 1], errors="coerce")
                    prices[quarter] = {
                        "per_ton": None if pd.isna(per_ton) else float(per_ton),
                        "per_m": None if pd.isna(per_metre) else float(per_metre),
                        "delta": None if pd.isna(delta) else float(delta),
                    }
                if not any(p["per_m"] is not None for p in prices.values()):
                    continue
                weight = pd.to_numeric(row[spec["weight_col"]], errors="coerce")
                contract_index.setdefault((dim1, dim2, thickness), []).append(
                    {
                        "route": route,
                        "contract_type": str(row[spec["type_col"]]).strip().upper(),
                        "key": str(row[spec["key_col"]]).strip(),
                        # `-HST` and `-ST` mark the high-strength and structural
                        # variants of a size that also has a plain row.
                        "variant": ("-".join(parts[3:]).strip().upper() or None),
                        "kg_per_m": None if pd.isna(weight) else float(weight),
                        "prices": prices,
                    }
                )

    def contract_row_for_size(dim1, dim2, thickness, grade):
        """The contract row that prices a size, and how it was reached.

        Split out from `contract_row_for` so the Megh reconciliation can price off the
        dimensions its billing lines carry rather than off a governed bucket, and get
        the same answer. Megh's own workbook keys the same way and reaches the same
        rows — including both cases that make this more than a dictionary lookup: a
        drawn CEW line names its bore where the contract names nothing, and a 38.1
        ERW 2 has no `-HST` row so it prices off the plain one.
        """
        grade = (grade or "").strip().upper()
        candidates = contract_index.get((dim1, dim2, thickness))
        via = "size"
        if not candidates and dim2 and abs(dim1 - 2 * thickness - dim2) <= PRICING_BORE_TOLERANCE_MM:
            # A drawn tube's bucket names its bore where the contract names nothing,
            # so a bucket whose second dimension is the bore prices off the round key.
            candidates = contract_index.get((dim1, 0.0, thickness))
            via = "size, bore ignored"
        if not candidates:
            return None, None
        route = "CEW" if grade.startswith("CEW") else "ERW"
        scoped = [c for c in candidates if c["route"] == route] or candidates
        wanted_stkm = "STKM" in grade
        scoped = [
            c for c in scoped if ("STKM" in c["contract_type"]) == wanted_stkm
        ] or scoped
        # The contract's high-strength band is headed "High strength / HST 370/ERW2",
        # so ERW 2 is priced off the HST variant wherever the size has one.
        wanted_hst = "HST" in grade or "ERW 2" in grade
        scoped = [c for c in scoped if (c["variant"] == "HST") == wanted_hst] or scoped
        return scoped[0], via

    def contract_row_for(bucket):
        """The contract row that prices a governed bucket, and how it was reached."""
        parsed = size_key(bucket)
        if parsed is None:
            return None, None
        dim1, dim2, thickness, parts = parsed
        grade = ("-".join(parts[3:-1]) if len(parts) > 4 else parts[3]).strip().upper()
        return contract_row_for_size(dim1, dim2, thickness, grade)

    if pricing_available:
        # Annealing is a property of the material, not of the schedule line: Bucketting
        # carries it in `Annealed`, and the material description names it as an `-AN-`
        # segment for codes Bucketting does not govern.
        annealed_codes = set(
            bucket_map.loc[
                bucket_map["Annealed"].astype(str).str.strip().str.upper().eq("AN"),
                "material_key",
            ].dropna()
        )
        priced = schedule[schedule["bucket"].map(valid_bucket)].copy()
        pricing_unpriced_frame = schedule[~schedule["bucket"].map(valid_bucket)]
        for _, r in (
            pricing_unpriced_frame.groupby(
                ["customer_display", "Bucket"], dropna=False, as_index=False
            )
            .agg(schedule_mt=("schedule_mt", "sum"), lines=("schedule_mt", "size"))
            .iterrows()
        ):
            pricing_unpriced.append(
                {
                    "customer": r["customer_display"],
                    "bucket": norm_bucket(r["Bucket"]),
                    "reason": "No governed bucket in Schedule July",
                    "schedule_mt": round(float(r["schedule_mt"] or 0), 3),
                    "lines": int(r["lines"]),
                }
            )
        # One row per customer, material and cut length: that is the SKU the customer
        # orders and the level the contract prices at.
        sku_group = priced.groupby(
            ["customer_display", "bucket", "ctl_bucket", "material_key",
             "MATERIAL DES", "LENGTH", "uom"],
            dropna=False, as_index=False,
        ).agg(
            schedule_mt=("schedule_mt", "sum"),
            schedule_qty=("schedule_qty", "sum"),
            fin_cut=("FC/NFC", lambda s: any(
                str(v).strip().upper() in {"FC", "FIN CUT"} for v in s
            )),
            chamfer=("Chamferring ", lambda s: any(
                str(v).strip().upper().startswith("CHAM") for v in s
            )),
            angle_cut=("Angle Cut", lambda s: any(
                str(v).strip().upper() == "AG" for v in s
            )),
        )
        no_contract = {}
        for _, r in sku_group.iterrows():
            bucket = r["bucket"]
            match, via = contract_row_for(bucket)
            if match is None:
                entry = no_contract.setdefault(
                    (r["customer_display"], bucket),
                    {
                        "customer": r["customer_display"],
                        "bucket": bucket,
                        "reason": "Size is not in the contract price sheet",
                        "schedule_mt": 0.0,
                        "lines": 0,
                    },
                )
                entry["schedule_mt"] += float(r["schedule_mt"] or 0)
                entry["lines"] += 1
                continue
            kg_per_m = match["kg_per_m"]
            description = (
                None if pd.isna(r["MATERIAL DES"]) else str(r["MATERIAL DES"]).strip()
            )
            length_mm = pd.to_numeric(r["LENGTH"], errors="coerce")
            length_m = None if pd.isna(length_mm) else float(length_mm) / 1000
            # The same cut-off the rest of the dashboard uses: at or above 3.5 m the
            # tube is a long length, sold by the metre; below it, a cut piece.
            is_long = length_m is not None and length_m >= LONG_LENGTH_MIN_M
            unit = "INR/m" if is_long else "INR/nos"
            length_written = None if length_m is None else round(length_m * 1000, 1)

            operations = {}
            if r["fin_cut"]:
                operations["Fin cut"] = PRICING_OPERATION_RATES["Fin cut"]
            if r["chamfer"]:
                operations["Chamferring"] = PRICING_OPERATION_RATES["Chamferring"]
            if r["angle_cut"]:
                operations["Angle cut"] = PRICING_OPERATION_RATES["Angle cut"]
            description_annealed = "-AN-" in (description or "").upper()
            if r["material_key"] in annealed_codes or description_annealed:
                label = f"Annealing {match['route']}"
                operations[label] = PRICING_OPERATION_RATES[label]
            # The owner's correction **overrides** the flags rather than filling in where
            # they are silent. Every SKU where this view disagrees with a customer's own
            # reconciliation is a case where the flags said something and it was wrong — a
            # fin-cut ladder on a `PE` line the schedule does not flag, a fin cut charged
            # per `FC` that the customer waived — so a fallback would correct none of them.
            if length_written is not None:
                corrected = pricing_operation_override(
                    pricing_overrides, r["customer_display"], bucket,
                    r["material_key"], length_written,
                )
                if corrected is not None:
                    operations = {
                        name: PRICING_OPERATION_RATES[name]
                        for name in corrected if name in PRICING_OPERATION_RATES
                    }
                    pricing_corrections += 1
            operations_per_m = (
                sum(rate * kg_per_m / 1000 for rate in operations.values())
                if kg_per_m else 0.0
            )
            row = {
                "customer": r["customer_display"],
                "material_code": r["material_key"],
                "description": description,
                "bucket": bucket,
                "ctl_bucket": r["ctl_bucket"],
                "contract_key": match["key"],
                "contract_type": match["contract_type"],
                "route": match["route"],
                "matched_via": via,
                "length_mm": length_written,
                "kind": "LL" if is_long else "CTL",
                "unit": unit,
                # Six decimals, not four: the contract quotes a weight like 5.269825 and
                # it multiplies a rate in thousands, so a fourth-decimal truncation shows
                # up in the paisa of a price the customer's own reconciliation is checked
                # against. The column renders to two either way.
                "kg_per_m": None if kg_per_m is None else round(kg_per_m, 6),
                "operations": sorted(operations),
                "operations_per_m": round(operations_per_m, 4),
                "schedule_mt": round(float(r["schedule_mt"] or 0), 3),
                "schedule_qty": float(r["schedule_qty"] or 0),
            }
            for quarter in PRICING_QUARTERS:
                base = match["prices"].get(quarter, {})
                per_m = base.get("per_m")
                if per_m is None:
                    row[quarter] = None
                    row[f"{quarter} per m"] = None
                    row[f"{quarter} base per m"] = None
                    continue
                # The contract's own base, published rather than left to be recovered by
                # subtracting the operations back out of the total. The browser reprices a
                # corrected SKU from this figure, and a base recovered from two separately
                # rounded numbers is out by up to a hundredth of a paisa — enough to make
                # the page and the build disagree in the fourth decimal of a build-up.
                row[f"{quarter} base per m"] = round(per_m, 6)
                total_per_m = per_m + operations_per_m
                row[f"{quarter} per m"] = round(total_per_m, 4)
                row[f"{quarter} base per ton"] = base.get("per_ton")
                if is_long:
                    row[quarter] = round(total_per_m, 2)
                elif length_m is not None:
                    row[quarter] = round(total_per_m * length_m, 2)
                else:
                    row[quarter] = None
            # Every quarter gets its own audit trail. A long length is quoted by the
            # metre, so its per-piece column is priced at one metre and the two read
            # the same number rather than the piece column sitting empty.
            price_length = 1.0 if is_long else length_m
            detail_keys = {}
            for quarter in PRICING_QUARTERS:
                base = match["prices"].get(quarter, {})
                base_per_m = base.get("per_m")
                if base_per_m is None or price_length is None:
                    continue
                lines = [
                    {
                        "operation": f"Base price · {match['key']} · {quarter}",
                        "inr_per_mt": base.get("per_ton"),
                        "kg_per_m": kg_per_m,
                        "inr_per_m": round(base_per_m, 4),
                        "length_m": round(price_length, 4),
                        "qty": round(base_per_m * price_length, 4),
                        "unit": "INR",
                    }
                ]
                lines += [
                    {
                        "operation": name,
                        "inr_per_mt": rate,
                        "kg_per_m": kg_per_m,
                        "inr_per_m": round(rate * (kg_per_m or 0) / 1000, 4),
                        "length_m": round(price_length, 4),
                        "qty": round(rate * (kg_per_m or 0) / 1000 * price_length, 4),
                        "unit": "INR",
                    }
                    for name, rate in sorted(operations.items())
                ]
                # The bucket is part of the key, not decoration. Without it, code
                # 3768904 at 878 mm — which Metalman schedules as both a 1.6 and a 2.5
                # wall — wrote two different build-ups to one key, and the 1.6 row opened
                # the 2.5's working: a different weight, a different contract row and a
                # price 44% higher, with nothing on screen to say so.
                key = (
                    f"PRICEBUILD|{row['customer']}|{row['bucket']}|{row['material_code']}"
                    f"|{row['length_mm']}|{quarter}"
                )
                stock_details[key] = lines
                detail_keys[quarter] = key
            row["detail_keys"] = detail_keys
            row["detail_key"] = detail_keys.get(PRICING_QUARTERS[-1])
            row["price_length_m"] = (
                None if price_length is None else round(price_length, 4)
            )
            pricing_rows.append(row)
        pricing_unpriced.extend(no_contract.values())
        pricing_rows.sort(
            key=lambda r: (r["customer"], natural_bucket_key(r["bucket"]),
                           r["length_mm"] or 0)
        )
        pricing_unpriced.sort(key=lambda r: -r["schedule_mt"])

    # 16. Order book. What is committed but not yet despatched, from the sales-planning
    # consolidation. Each sheet reports a different stage of the same commitment and so
    # names its own open-quantity column (see ORDER_BOOK_SHEETS); the three are read on
    # their own terms and then pooled by governed bucket, which is the grain the
    # long-length tracker works in.
    order_rows = []
    orders_available = bool(order_sheets)
    orders_note = None if orders_available else "No order book was supplied."
    order_unmapped = []
    order_sheet_faults = []
    for sheet, spec in ORDER_BOOK_SHEETS.items():
        frame = order_sheets.get(sheet)
        if frame is None or frame.empty:
            continue
        frame = frame.copy()
        frame.columns = [re.sub(r"\s+", " ", str(c)).strip() for c in frame.columns]
        qty_column = spec["quantity_column"]
        if qty_column not in frame.columns:
            order_sheet_faults.append(
                {
                    "origin": spec["label"],
                    "sheet": sheet,
                    "reason": f"sheet carries no {qty_column} column",
                    "lines": int(len(frame)),
                }
            )
            continue
        frame["order_mt"] = pd.to_numeric(frame[qty_column], errors="coerce").fillna(0)
        frame = frame[frame["order_mt"] > 0]
        if frame.empty:
            continue
        # A sheet may name its code column one of several ways, or not carry one at all.
        candidates = spec["code_column"]
        candidates = (candidates,) if isinstance(candidates, str) else (candidates or ())
        code_column = next((c for c in candidates if c in frame.columns), None)
        frame["description_key"] = frame[spec["description_column"]].map(norm_desc)
        frame["stated_code"] = (
            frame[code_column].map(norm_code) if code_column
            else pd.Series([None] * len(frame), index=frame.index)
        )
        # The stock-transfer sheet carries no material number at all, only a description,
        # so recover the code from zmat before anything else needs one. Every downstream
        # join — bucket, length, the Megh length-bucketing, the drill-down's code column
        # — then works on that sheet exactly as it does on the two that state a code.
        frame["recovered_code"] = frame["description_key"].map(description_material)
        frame["material_key"] = frame["stated_code"].fillna(frame["recovered_code"])
        # Test for NaN explicitly: a missing code arrives as NaN, which is truthy, so
        # `if stated` labels a blank cell as though the sheet had stated a code and a
        # line with no recovery at all as though zmat had supplied one.
        def code_source_for(stated, recovered, description_key):
            if pd.notna(stated):
                return "sheet"
            if pd.notna(recovered):
                return "zmat description"
            candidates = description_materials.get(description_key)
            if candidates is not None and len(candidates) > 1:
                return "several zmat codes: " + ", ".join(candidates)
            return None

        frame["code_source"] = [
            code_source_for(stated, recovered, description_key)
            for stated, recovered, description_key in zip(
                frame["stated_code"], frame["recovered_code"], frame["description_key"]
            )
        ]
        # Resolve the bucket through Bucketting first, then the description, then the
        # Megh length-bucketing the plan supplies — a code the plan governs and
        # Bucketting does not reaches a bucket only through that last step.
        frame["bucket"] = frame["material_key"].map(material_bucket)
        frame["bucket"] = frame["bucket"].fillna(
            frame["description_key"].map(description_bucket)
        )
        plan_bucket = frame["material_key"].map(
            lambda c: megh_code_length_bucket.get(c, (None, None, None))[0]
        )
        frame["bucket"] = frame["bucket"].fillna(plan_bucket)
        frame["length_m"] = frame["description_key"].map(description_length)
        frame["length_m"] = frame["length_m"].fillna(
            frame["material_key"].map(material_length)
        )
        frame["length_m"] = frame["length_m"].fillna(
            frame["material_key"].map(
                lambda c: megh_code_length_bucket.get(c, (None, None, None))[1]
            )
        )
        # A PT- code names the plant on the planning sheets; the dumps use the SAP number.
        plant_raw = frame[spec["plant_column"]].astype(str).str.strip().str.upper()
        frame["plant"] = plant_raw.map(ORDER_PLANT_CODES).fillna(
            frame[spec["plant_column"]].map(norm_code)
        )
        # How long the order has been open. Two sheets state the age in days under
        # different names; the transfer sheet states only the date the STR was raised,
        # so its age is the as-of date less that date. Reporting a raised date as if it
        # were a day count would read as an eleven-year-old order.
        age_column, age_date_column = spec["age_column"], spec["age_date_column"]
        if age_column and age_column in frame.columns:
            frame["age_days"] = pd.to_numeric(frame[age_column], errors="coerce")
        elif age_date_column and age_date_column in frame.columns:
            raised = pd.to_datetime(frame[age_date_column], errors="coerce")
            frame["age_days"] = (as_of_date - raised).dt.days
        else:
            frame["age_days"] = pd.Series([None] * len(frame), index=frame.index)
        # Lines the planners have marked in the remarks column are not live demand.
        remarks_column = spec["remarks_column"]
        if remarks_column and remarks_column in frame.columns:
            frame["remark"] = frame[remarks_column].map(
                lambda v: None if pd.isna(v) else str(v).strip()
            )
        else:
            frame["remark"] = None
        frame["excluded"] = frame["remark"].map(
            lambda v: bool(v) and str(v).strip().upper() == ORDER_EXCLUDE_REMARK
        )
        for _, r in frame.iterrows():
            order_rows.append(
                {
                    "origin": spec["label"],
                    "sheet": sheet,
                    "kind": spec["kind"],
                    "plant": None if pd.isna(r["plant"]) else str(r["plant"]),
                    "order_no": (
                        None if not spec["order_column"]
                        or spec["order_column"] not in frame.columns
                        or pd.isna(r[spec["order_column"]])
                        else str(r[spec["order_column"]]).split(".")[0]
                    ),
                    "customer": (
                        None if pd.isna(r[spec["customer_column"]])
                        else str(r[spec["customer_column"]]).strip()
                    ),
                    "material_code": r["material_key"],
                    "code_source": r["code_source"],
                    "description": (
                        None if pd.isna(r[spec["description_column"]])
                        else str(r[spec["description_column"]]).strip()
                    ),
                    "basis": spec["quantity_meaning"],
                    "remark": r["remark"],
                    "excluded": bool(r["excluded"]),
                    "age_days": (
                        None if pd.isna(r["age_days"]) else int(r["age_days"])
                    ),
                    "bucket": None if pd.isna(r["bucket"]) else str(r["bucket"]),
                    "length_m": None if pd.isna(r["length_m"]) else float(r["length_m"]),
                    "order_mt": round(float(r["order_mt"]), 3),
                }
            )

    orders_all = pd.DataFrame(order_rows)
    # Everything downstream — the pools, both trackers and the gap analysis — works on
    # the live book. The excluded lines are kept in `orders_all` only so they can be
    # counted and listed; nothing may pool them.
    orders_frame = (
        orders_all[~orders_all["excluded"]].copy() if not orders_all.empty else orders_all
    )
    order_pool = {}
    megh_order_plan = {}
    if not orders_frame.empty:
        mapped = orders_frame[orders_frame["bucket"].notna()]
        order_pool = mapped.groupby("bucket")["order_mt"].sum().to_dict()
        # Line items behind each bucket, plant by plant, so the tonnage can be opened
        # and read against the plant that owes it.
        for bucket, group in mapped.groupby("bucket"):
            stock_details[f"ORDERS|{bucket}"] = [
                {
                    "plant": r["plant"],
                    "origin": r["origin"],
                    "kind": r["kind"],
                    "order_no": r["order_no"],
                    "customer": r["customer"],
                    "material_code": r["material_code"],
                    "code_source": r["code_source"],
                    "description": r["description"],
                    "basis": r["basis"],
                    "age_days": r["age_days"],
                    "qty": r["order_mt"],
                    "unit": "MT",
                }
                for _, r in group.sort_values("order_mt", ascending=False).iterrows()
            ]
        # Megh Steel's own orders, keyed to the VSM SKU so they sit beside the plan's
        # OMS figure rather than replacing it.
        megh = mapped[
            mapped["customer"].astype(str).str.upper().str.contains("MEGH", na=False)
        ].copy()
        # The SKU the plan itself holds against the code, or the owner's assignment —
        # the same two sources the stock, sales and WIP frames map by, and deliberately
        # not one more. This join used to fall back to deriving a key from the bucket
        # and length; an order landing on a SKU by a route the sales beside it cannot
        # take would sit against the wrong OMS line and disagree with the tab.
        megh["vsm_key"] = [
            sku_assignments.get(code)
            or megh_code_length_bucket.get(code, (None, None, None))[2]
            for code in megh["material_code"]
        ]
        megh_keyed = megh[megh["vsm_key"].notna()]
        megh_order_plan = megh_keyed.groupby("vsm_key")["order_mt"].sum().to_dict()
        for sku, group in megh_keyed.groupby("vsm_key"):
            stock_details[f"MEGHORDERPLAN|{sku}"] = [
                {
                    "plant": r["plant"],
                    "origin": r["origin"],
                    "kind": r["kind"],
                    "order_no": r["order_no"],
                    "customer": r["customer"],
                    "material_code": r["material_code"],
                    "code_source": r["code_source"],
                    "description": r["description"],
                    "basis": r["basis"],
                    "age_days": r["age_days"],
                    "qty": r["order_mt"],
                    "unit": "MT",
                }
                for _, r in group.sort_values("order_mt", ascending=False).iterrows()
            ]
        # Every open order line absent from a view that should carry it, one row per
        # line. A line can be absent from one view and present in the other — a Megh
        # order on an unscheduled bucket shows on the Megh tab and nowhere on the
        # long-length tracker — so each row names both the view it is missing from and
        # the view it is visible on. Without that it reads as an unmapped material, which
        # is a different problem with a different fix.
        LL_VIEW, MEGH_VIEW = "Long-length tracker", "Megh Steel tab"
        ll_buckets = set(ll_tracker["bucket"])
        off_plan_keys = set(
            megh_keyed.loc[~megh_keyed["vsm_key"].isin(megh_sku_keys), "vsm_key"]
        )
        megh_line_keys = dict(zip(megh_keyed.index, megh_keyed["vsm_key"]))
        # A Megh line whose bucket does not govern its length yields no SKU key at all,
        # so it reaches no Megh row either. Today every such line happens to be caught
        # by the bucket test as well; that is coincidence, not cover.
        megh_line = megh.index if not megh.empty else pd.Index([])
        for index, r in orders_frame.iterrows():
            bucket = r["bucket"]
            sku = megh_line_keys.get(index)
            missing_ll = pd.isna(bucket) or bucket not in ll_buckets
            unkeyed_megh = index in megh_line and sku is None
            missing_megh = sku in off_plan_keys or unkeyed_megh
            if not missing_ll and not missing_megh:
                continue
            # A Megh line belongs on both views; anything else only on the long-length
            # tracker, so it is never "missing" from the Megh tab.
            is_megh = index in megh_line
            missing_from = [LL_VIEW] if missing_ll else []
            if missing_megh:
                missing_from.append(MEGH_VIEW)
            shown_on = [
                view for view, absent, applies in (
                    (LL_VIEW, missing_ll, True),
                    (MEGH_VIEW, missing_megh, is_megh),
                ) if applies and not absent
            ]
            if pd.isna(bucket):
                cause = (
                    "No governed bucket" if r["material_code"]
                    else "No governed bucket (sheet carries no code)"
                )
            else:
                cause = "; ".join(
                    part for part, on in (
                        ("Bucket not scheduled", missing_ll),
                        ("Length not governed", unkeyed_megh),
                        ("SKU not in plan", missing_megh and not unkeyed_megh),
                    ) if on
                )
            order_unmapped.append(
                {
                    "missing_from": " and ".join(missing_from),
                    "shown_on": " and ".join(shown_on) or "Nowhere",
                    "cause": cause,
                    "origin": r["origin"],
                    "plant": r["plant"],
                    "kind": r["kind"],
                    "order_no": r["order_no"],
                    "customer": r["customer"],
                    "material_code": r["material_code"],
                    "code_source": r["code_source"],
                    "description": r["description"],
                    "bucket": None if pd.isna(bucket) else bucket,
                    "sku": sku,
                    "age_days": r["age_days"],
                    "order_mt": r["order_mt"],
                }
            )
    # Tonnage visible on no view at all is the real loss, so it leads; within each group
    # the largest line first, because that is the one worth chasing.
    # Lines the planners marked. Listed so the sheet accounts for every line in the book,
    # labelled so they are never mistaken for a mapping to fix, and sorted last.
    if not orders_all.empty:
        for _, r in orders_all[orders_all["excluded"]].iterrows():
            order_unmapped.append(
                {
                    "missing_from": "Excluded from both views",
                    "shown_on": "Excluded on purpose",
                    "cause": f"Remark {r['remark']}",
                    "origin": r["origin"],
                    "plant": r["plant"],
                    "kind": r["kind"],
                    "order_no": r["order_no"],
                    "customer": r["customer"],
                    "material_code": r["material_code"],
                    "code_source": r["code_source"],
                    "description": r["description"],
                    "bucket": r["bucket"],
                    "sku": None,
                    "age_days": r["age_days"],
                    "order_mt": r["order_mt"],
                }
            )
    # Actionable rows lead: tonnage visible on no view first, then the rest, then the
    # lines excluded on purpose, which need nothing done to them.
    order_unmapped.sort(
        key=lambda r: (
            r["shown_on"] == "Excluded on purpose",
            r["shown_on"] != "Nowhere",
            r["missing_from"],
            -r["order_mt"],
        )
    )

    # The long-length tracker and the Megh tracker are both built before the order book
    # can be pooled, so the order columns are attached to them here. The tracker's own
    # export is written now rather than with its siblings for the same reason.
    # 16b. Order sign-off. Two columns rather than one total, so a SKU's coverage can be
    # read against firm demand and against the rest separately.
    signoff_by_bucket, signoff_by_sku, signoff_rows = {}, {}, []
    signoff_unmapped = []
    if any(src.available(f"signoff:{sheet}") for sheet in SIGNOFF_SHEETS):
        for sheet, spec in SIGNOFF_SHEETS.items():
            try:
                frame = src.frame(f"signoff:{sheet}")
            except (SheetMissing, FileNotFoundError):
                continue
            if spec["code"] not in frame.columns:
                continue
            codes = frame[spec["code"]].map(norm_code)
            quantity = (pd.to_numeric(frame[spec["quantity"]], errors="coerce").fillna(0)
                        if spec["quantity"] and spec["quantity"] in frame.columns
                        else pd.Series(0.0, index=frame.index))
            if spec["flag"]:
                is_signed = frame[spec["flag"]].astype(str).str.strip().str.upper().eq(
                    spec["signed_when"])
                signed = quantity.where(is_signed, 0.0)
                unsigned = quantity.where(~is_signed, 0.0)
            else:
                signed = (pd.to_numeric(frame[spec["signed"]], errors="coerce").fillna(0)
                          if spec["signed"] in frame.columns
                          else pd.Series(0.0, index=frame.index))
                if spec["unsigned"] and spec["unsigned"] in frame.columns:
                    unsigned = pd.to_numeric(frame[spec["unsigned"]],
                                             errors="coerce").fillna(0)
                else:
                    # The remainder of the order, never below zero: a sheet that signs
                    # off more than it ordered would otherwise lend the difference back.
                    unsigned = (quantity - signed).clip(lower=0)
            for code, sign_mt, rest_mt in zip(codes, signed, unsigned):
                if not code or (sign_mt <= 0 and rest_mt <= 0):
                    continue
                bucket = material_bucket.get(code)
                sku = code_to_vsm_key.get(code)
                signoff_rows.append({
                    "plant": sheet, "material_code": code, "bucket": bucket, "sku": sku,
                    "signed_mt": round(float(sign_mt), 3),
                    "unsigned_mt": round(float(rest_mt), 3),
                })
                if bucket:
                    entry = signoff_by_bucket.setdefault(bucket, [0.0, 0.0])
                    entry[0] += float(sign_mt)
                    entry[1] += float(rest_mt)
                if sku:
                    entry = signoff_by_sku.setdefault(sku, [0.0, 0.0])
                    entry[0] += float(sign_mt)
                    entry[1] += float(rest_mt)
                if not bucket and not sku:
                    signoff_unmapped.append(
                        {**signoff_rows[-1],
                         "qty_mt": round(float(sign_mt) + float(rest_mt), 3)}
                    )
        # Drill-downs, per bucket and per SKU, plant by plant.
        for scope, index in (("SIGNOFF", signoff_by_bucket), ("MEGHSIGNOFF", signoff_by_sku)):
            field = "bucket" if scope == "SIGNOFF" else "sku"
            for key in index:
                lines = [r for r in signoff_rows if r[field] == key]
                # One line per plant and code, both halves side by side.
                merged = {}
                for r in lines:
                    entry = merged.setdefault((r["plant"], r["material_code"]),
                                              {"signed": 0.0, "unsigned": 0.0})
                    entry["signed"] += r["signed_mt"]
                    entry["unsigned"] += r["unsigned_mt"]
                stock_details[f"{scope}|{key}"] = [
                    {"plant": plant, "sku": key, "material_code": code,
                     "signed_mt": round(v["signed"], 3),
                     "unsigned_mt": round(v["unsigned"], 3),
                     "qty": round(v["signed"] + v["unsigned"], 3), "unit": "MT"}
                    for (plant, code), v in sorted(
                        merged.items(), key=lambda kv: -(kv[1]["signed"] + kv[1]["unsigned"]))
                ]

    if signoff_unmapped:
        add_missing(
            pd.DataFrame(signoff_unmapped).assign(customer=""),
            "Order sign-off", SIGNOFF_FILE, "customer", "plant",
            "material_code", "material_code",
            "Sign-off material code reaches no governed bucket or plan SKU",
            "qty_mt",
        )
        missing_mappings = pd.DataFrame(missing_rows).sort_values(
            ["mapping_type", "affected_mt"], ascending=[True, False]
        )
        missing_mappings.to_csv(output_dir / "missing_mappings.csv", index=False)

    ll_tracker["signoff_mt"] = [
        round(signoff_by_bucket.get(bucket, [0.0, 0.0])[0], 3)
        for bucket in ll_tracker["bucket"]
    ]
    ll_tracker["non_signoff_mt"] = [
        round(signoff_by_bucket.get(bucket, [0.0, 0.0])[1], 3)
        for bucket in ll_tracker["bucket"]
    ]
    ll_tracker["signoff_detail_key"] = [
        f"SIGNOFF|{bucket}" if bucket in signoff_by_bucket else None
        for bucket in ll_tracker["bucket"]
    ]
    for row in megh_rows:
        signed, rest = signoff_by_sku.get(row["sku"], [0.0, 0.0])
        row["signoff_mt"] = round(signed, 3)
        row["non_signoff_mt"] = round(rest, 3)
        row["signoff_detail_key"] = (
            f"MEGHSIGNOFF|{row['sku']}" if row["sku"] in signoff_by_sku else None
        )

    ll_tracker["order_logged_mt"] = [
        round(float(order_pool.get(bucket, 0) or 0), 3)
        for bucket in ll_tracker["bucket"]
    ]
    ll_tracker["order_detail_key"] = [
        f"ORDERS|{bucket}" if order_pool.get(bucket) else None
        for bucket in ll_tracker["bucket"]
    ]
    ll_tracker.to_csv(output_dir / "tvsm_ll_tracker.csv", index=False)
    for row in megh_rows:
        planned = float(megh_order_plan.get(row["sku"], 0) or 0)
        row["orders_planning_mt"] = round(planned, 3)
        row["orders_plan_detail_key"] = (
            f"MEGHORDERPLAN|{row['sku']}" if planned else None
        )

    def sheet_slice(frame, sheet):
        return frame.loc[frame["sheet"] == sheet] if not frame.empty else frame

    order_summary = [
        {
            "origin": spec["label"],
            "sheet": sheet,
            "basis": spec["quantity_meaning"],
            "lines": int(len(sheet_slice(orders_frame, sheet))),
            "order_mt": round(float(sheet_slice(orders_frame, sheet)["order_mt"].sum()), 3)
            if not orders_frame.empty else 0.0,
            # What the sheet holds before the remark filter, so the two reconcile.
            "lines_in_sheet": int(len(sheet_slice(orders_all, sheet))),
            "excluded_lines": int(
                len(sheet_slice(orders_all, sheet)) - len(sheet_slice(orders_frame, sheet))
            ),
            "excluded_mt": round(
                float(sheet_slice(orders_all, sheet)["order_mt"].sum())
                - float(sheet_slice(orders_frame, sheet)["order_mt"].sum()), 3
            ) if not orders_all.empty else 0.0,
            "age_basis": (
                f"{ORDER_BOOK_SHEETS[sheet]['age_column']} column"
                if ORDER_BOOK_SHEETS[sheet]["age_column"]
                else f"as-of date less {ORDER_BOOK_SHEETS[sheet]['age_date_column']}"
            ),
            "oldest_order_days": (
                max(
                    (r["age_days"] for r in order_rows
                     if r["sheet"] == sheet and r["age_days"] is not None),
                    default=None,
                )
            ),
        }
        for sheet, spec in ORDER_BOOK_SHEETS.items()
    ]

    # 15. Code repository. One customer buys the same SKU under several material codes,
    # and bills it to one address while shipping it to another, so a price change has
    # to be raised against every ship-to, bill-to, plant and code combination that has
    # actually been invoiced. Read the longer sales window when it is supplied, because
    # the daily dump is the current month only and a code billed in April would
    # otherwise be missing from the change request.
    repository_source = sales_history if not sales_history.empty else sales_raw
    repo = repository_source.copy()
    repo.columns = [str(c) for c in repo.columns]
    repo["customer_key"] = repo["CUSTOMER  CD"].map(norm_code)
    repo["customer_name_key"] = repo["CUSTOMER  NAME"].map(norm_text)
    repo["material_key"] = repo["MATERAIL NUMBER"].map(norm_code)
    repo["description_key"] = repo["Material   Description"].map(norm_desc)
    repo["bucket"] = repo["material_key"].map(material_bucket)
    repo["bucket"] = repo["bucket"].fillna(repo["description_key"].map(description_bucket))
    repo["length_m"] = repo["description_key"].map(description_length)
    repo["length_m"] = repo["length_m"].fillna(repo["material_key"].map(material_length))
    repo["ctl_bucket"] = [
        make_ctl_bucket(bucket, length)
        for bucket, length in zip(repo["bucket"], repo["length_m"])
    ]
    repo["oem"] = repo["customer_name_key"].map(oem_map)
    repo["oem"] = repo["oem"].where(
        ~repo["customer_key"].isin(CONVERSION_AGENT_OEM_BY_CODE),
        repo["customer_key"].map(CONVERSION_AGENT_OEM_BY_CODE),
    )
    repo["plant"] = repo["DESP P LANT"].map(norm_code)
    repo["ship_to_key"] = repo["SHIP TO PARTY C"].map(norm_code)
    repo["billing_date"] = pd.to_datetime(repo["BILLING  DATE"], errors="coerce")
    repo["qty_nos"] = pd.to_numeric(repo["qty in no"], errors="coerce").fillna(0)
    repo["qty_mt"] = pd.to_numeric(repo["Quantity"], errors="coerce").fillna(0) / 1000
    # The repository covers the TVS ancillary base plus the Megh Steel conversion
    # codes, which the OEM key files under Direct but which convert for TVS.
    in_scope = repo["oem"].eq("TVS") | repo["customer_key"].isin(
        CONVERSION_AGENT_OEM_BY_CODE
    )
    repo = repo[in_scope & repo["material_key"].notna() & (repo["qty_mt"] > 0)]
    code_repository = [
        {
            "bill_to_code": r["customer_key"],
            "bill_to_name": None if pd.isna(r["CUSTOMER  NAME"]) else str(r["CUSTOMER  NAME"]).strip(),
            "ship_to_code": r["ship_to_key"],
            "ship_to_name": (
                None if pd.isna(r["SHIPTO PARTY DISC"])
                else str(r["SHIPTO PARTY DISC"]).strip()
            ),
            "plant": r["plant"],
            "material_code": r["material_key"],
            "description": (
                None if pd.isna(r["Material   Description"])
                else str(r["Material   Description"]).strip()
            ),
            "bucket": None if pd.isna(r["bucket"]) else str(r["bucket"]),
            "ctl_bucket": None if pd.isna(r["ctl_bucket"]) else str(r["ctl_bucket"]),
            "length_mm": None if pd.isna(r["length_m"]) else round(float(r["length_m"]) * 1000, 1),
            "oem": None if pd.isna(r["oem"]) else str(r["oem"]),
            "invoices": int(r["invoices"]),
            "qty_nos": float(r["qty_nos"]),
            "qty_mt": round(float(r["qty_mt"]), 3),
            "first_billed": None if pd.isna(r["first_billed"]) else r["first_billed"].date().isoformat(),
            "last_billed": None if pd.isna(r["last_billed"]) else r["last_billed"].date().isoformat(),
        }
        for _, r in (
            repo.groupby(
                ["customer_key", "CUSTOMER  NAME", "ship_to_key", "SHIPTO PARTY DISC",
                 "plant", "material_key", "Material   Description", "bucket",
                 "ctl_bucket", "length_m", "oem"],
                dropna=False, as_index=False,
            )
            .agg(
                invoices=("Billing  Document Number", "nunique"),
                qty_nos=("qty_nos", "sum"),
                qty_mt=("qty_mt", "sum"),
                first_billed=("billing_date", "min"),
                last_billed=("billing_date", "max"),
            )
            .sort_values(["CUSTOMER  NAME", "material_key", "plant"])
            .iterrows()
        )
    ]
    repository_window = {
        "source": "sales_history.xlsx" if not sales_history.empty else "sales.xlsx",
        "from": (
            None if repo["billing_date"].isna().all()
            else repo["billing_date"].min().date().isoformat()
        ),
        "to": (
            None if repo["billing_date"].isna().all()
            else repo["billing_date"].max().date().isoformat()
        ),
        "rows": len(code_repository),
        "customers": len({r["bill_to_code"] for r in code_repository}),
        "materials": len({r["material_code"] for r in code_repository}),
        "plants": sorted({r["plant"] for r in code_repository if r["plant"]}),
        "multi_code_skus": len({
            (r["bill_to_code"], r["ctl_bucket"]) for r in code_repository
            if r["ctl_bucket"]
        }),
    }

    # 17. Past sales trend. What TSL has actually billed to the TVSM chain, month by
    # month, over the quarterly extracts plus the current month's dump. Two parties are
    # tracked and never merged: the ancillaries TSL bills directly, and Megh Steel under
    # 943209, which converts for TVS. `OEM_key_1_rev codes` classifies 943209 as Direct,
    # so it is matched on the code rather than inferred from the OEM key.
    #
    # The whole ledger, which is the whole window. There used to be a one-month-one-source
    # rule here: each source claimed the months no earlier source had, because two files
    # covering the same month would otherwise count it twice. That rule deduplicated whole
    # months because it had no finer key to work with, and it cost real tonnage both ways
    # — a month held by two sources was counted twice without it, and on 1 August the
    # daily dump stopped covering July while no archive yet held it, so the trend silently
    # lost 3,344.836 MT, the most recent complete month, from a six-month view.
    #
    # The ledger's key retires it. Deduplication happens at the line, on billing document
    # and item, so a month may be assembled from as many extracts as have ever been
    # uploaded and each line still counts once. That is what lets a partial backfill
    # *merge* into a closed month — send an extract that finally carries Jamshedpur and
    # Khopoli, and it adds its missing lines to January rather than having to replace it.
    trend_all = sales_all[sales_all["billing_month"].notna()].copy()
    is_megh = trend_all["customer_key"].eq(MEGH_TVS_CUSTOMER_CODE)
    is_direct = trend_all["oem_key_oem"].eq("TVS") & ~is_megh
    trend_all["segment"] = np.where(
        is_megh, TREND_SEGMENT_MEGH, np.where(is_direct, TREND_SEGMENT_DIRECT, None)
    )
    trend = trend_all[trend_all["segment"].notna()].copy()

    # Value adds are a property of the SKU as scheduled, and `Schedule July` is the only
    # sheet that states them, so a historical line inherits the flags of its own
    # material. A material never scheduled in July carries neither flag rather than a
    # guess. The view says so.
    def flag_any(series, test):
        return any(test(str(v).strip().upper()) for v in series)

    schedule_flags = (
        schedule.dropna(subset=["material_key"])
        .groupby("material_key")
        .agg(
            angle_cut=("Angle Cut", lambda s: flag_any(s, lambda v: v == "AG")),
            chamfer=("Chamferring ", lambda s: flag_any(s, lambda v: v.startswith("CHAM"))),
        )
    )
    trend["angle_cut"] = trend["material_key"].map(schedule_flags["angle_cut"]).fillna(False)
    trend["chamfer"] = trend["material_key"].map(schedule_flags["chamfer"]).fillna(False)
    # Long length by the same 3.5 m rule the rest of the dashboard uses.
    trend["length_type"] = np.where(
        pd.to_numeric(trend["length_m"], errors="coerce").fillna(0) >= LONG_LENGTH_MIN_M,
        "LL", "CTL",
    )
    trend["customer_display"] = (
        trend["CUSTOMER  NAME"].astype(str).str.strip().replace({"nan": None})
    )
    trend["despatch_plant"] = trend["DESP P LANT"].map(norm_code)

    trend_months = sorted(trend["billing_month"].dropna().unique())

    def month_map(frame, key_columns, value="sales_mt", digits=3):
        """{key: {month: value}} for a table that runs months across the columns."""
        grouped = (
            frame.groupby(key_columns + ["billing_month"])[value].sum().reset_index()
        )
        out = {}
        for _, r in grouped.iterrows():
            key = tuple(r[c] for c in key_columns)
            key = key[0] if len(key) == 1 else key
            out.setdefault(key, {})[r["billing_month"]] = round(float(r[value]), digits)
        return out

    # Sales to Megh, month by month, behind the Megh tab's own figure.
    #
    # The other breakups on that tab split one month's figure by where the material is;
    # this one answers a different question, which is how the size has sold over time. So
    # it is a small table in its own right: a material code per row, a month per column,
    # and the footer adding each month down its own column. The published month's column
    # therefore totals to the very figure that was clicked, which is what keeps a history
    # honest beside a monthly number.
    #
    # Read from the ledger rather than the month's dump, and filtered to the same three
    # conversion-agent codes `sales_mt` itself uses — a breakup drawn from a wider set
    # than the column above it is a breakup that contradicts it.
    megh_history = trend_all[trend_all["customer_key"].isin(megh_codes)].copy()
    if not megh_history.empty:
        # The same two routes the tab itself uses — the plan's own per-plant material
        # codes, under the owner's assignments — applied to the whole ledger, not just
        # the published month. A history keyed differently from the column it breaks up
        # would total to a different figure than the one that was clicked.
        megh_history["vsm_key"] = megh_history["material_key"].map(code_to_vsm_key)
        if sku_assignments:
            megh_history["vsm_key"] = (
                megh_history["material_key"].map(sku_assignments)
                .fillna(megh_history["vsm_key"])
            )
    megh_sales_months = (
        month_map(megh_history.dropna(subset=["vsm_key"]),
                  ["vsm_key", "material_key", "description_key"])
        if not megh_history.empty else {}
    )
    megh_history_by_sku: dict[str, list] = {}
    for (sku, code, description), months in megh_sales_months.items():
        megh_history_by_sku.setdefault(sku, []).append({
            "material_code": code,
            "sku": description,
            # One field per month, because the panel reads flat fields off a row. Only
            # the months that moved are written; the rest read as a dash rather than a
            # zero, which is the difference between "sold none" and "no line at all".
            **{f"m_{month}": qty for month, qty in months.items()},
            "qty": round(sum(months.values()), 3),
            "unit": "MT",
        })
    # Only for sizes that are actually on the tab. Megh buys plenty the plan carries no
    # line for — that is what the unmapped-purchases table below exists to report — and a
    # breakup written against a SKU no row names is a breakup nobody can open.
    on_the_tab = {row["sku"] for row in megh_rows}
    megh_history_by_sku = {
        sku: lines for sku, lines in megh_history_by_sku.items() if sku in on_the_tab
    }
    for sku, lines in megh_history_by_sku.items():
        lines.sort(key=lambda line: -line["qty"])
        stock_details[f"MEGHSALES|{sku}"] = lines
    # How many months this size has sold in, and the key to open them.
    #
    # The count is what the figure is guarded on, and it earns its place rather than
    # duplicating the key. The rule this tab already follows is that `when` guards the
    # figure wherever the key exists but the breakup may not — and a key nulled out is a
    # weaker guarantee than it looks, because any future build that writes the key
    # unconditionally, as this one used to, turns every unsold size into a button onto
    # nothing. Stating the condition outright is what makes that impossible.
    for row in megh_rows:
        lines = megh_history_by_sku.get(row["sku"], [])
        row["sales_months"] = len({
            field for line in lines for field in line if field.startswith("m_")
        })
        row["sales_detail_key"] = f"MEGHSALES|{row['sku']}" if lines else None

    # Table one: bucket by month, both parties consolidated, each cell opening its split.
    bucketed = trend[trend["bucket"].notna()]
    by_bucket = month_map(bucketed, ["bucket"])
    # The same table in pieces. A cut length is ordered in pieces and a long length by
    # weight, so a trend read only in tonnage answers half the question — and the whole
    # tab can be switched to the other half.
    by_bucket_nos = month_map(bucketed, ["bucket"], value="sales_nos", digits=0)
    trend_buckets = []
    for bucket, months in sorted(by_bucket.items(), key=lambda kv: natural_bucket_key(kv[0])):
        rows = bucketed[bucketed["bucket"].eq(bucket)]
        for month in months:
            slice_ = rows[rows["billing_month"].eq(month)]
            stock_details[f"TRENDBUCKET|{bucket}|{month}"] = [
                {
                    "source": segment,
                    "plant": None,
                    "sku": bucket,
                    "material_code": ", ".join(sorted({
                        str(c) for c in group["material_key"].dropna()
                    })) or None,
                    "customer": ", ".join(sorted({
                        str(c) for c in group["customer_display"].dropna()
                    })) or None,
                    "nos": round(float(group["sales_nos"].sum()), 0),
                    "qty": round(float(group["sales_mt"].sum()), 3),
                    "unit": "MT",
                }
                for segment, group in slice_.groupby("segment")
            ]
        months_nos = by_bucket_nos.get(bucket, {})
        trend_buckets.append({
            "bucket": bucket,
            "months": months,
            "months_nos": months_nos,
            "total_mt": round(sum(months.values()), 3),
            "total_nos": round(sum(months_nos.values()), 0),
            "direct_nos": round(float(rows.loc[
                rows["segment"].eq(TREND_SEGMENT_DIRECT), "sales_nos"].sum()), 0),
            "megh_nos": round(float(rows.loc[
                rows["segment"].eq(TREND_SEGMENT_MEGH), "sales_nos"].sum()), 0),
            "direct_mt": round(float(rows.loc[
                rows["segment"].eq(TREND_SEGMENT_DIRECT), "sales_mt"].sum()), 3),
            "megh_mt": round(float(rows.loc[
                rows["segment"].eq(TREND_SEGMENT_MEGH), "sales_mt"].sum()), 3),
        })

    # Which Helper Customer each SAP code belongs to, and which codes a customer holds.
    # Built here rather than beside the history below because the trend tables need it
    # first, to group the sales file's names.
    codes_by_display, displays_by_code = {}, {}
    for _, row in schedule_group.iterrows():
        display = row["customer_display"]
        for code in row["customer_codes"]:
            codes_by_display.setdefault(display, set()).add(code)
            displays_by_code.setdefault(code, set()).add(display)

    # The customer as the *business* names it, beside the customer as SAP names it.
    #
    # The sales file writes a ship-to's own spelling, so one customer arrives under
    # several: Rajsriya under six, Sandhar under four, Elkayem under three — 26 names for
    # about thirteen customers. A selector offering all 26 asks the reader to know which
    # of them is the plant they meant, which is not a question the dashboard should be
    # asking. So each row also carries the Helper Customer its SAP code belongs to.
    #
    # A code used under more than one Helper Customer cannot be resolved and keeps its raw
    # name as its own group — the same rule the history below follows, and for the same
    # reason: guessing which of two customers a shared code belongs to is worse than
    # showing it under the name the sales file actually used. So do parties with no
    # schedule at all, Megh Steel and TVS Motor among them.
    unique_display_by_code = {
        code: next(iter(displays))
        for code, displays in displays_by_code.items()
        if len(displays) == 1
    }
    trend["customer_group"] = (
        trend["customer_key"].map(unique_display_by_code).fillna(trend["customer_display"])
    )

    # Table two: one ancillary at a time, its SKUs month by month. Megh Steel is in the
    # same list, because "who bought what" is the same question for both.
    trend_customers = sorted({c for c in trend["customer_display"].dropna()})
    keyed = trend[trend["ctl_bucket"].notna()]
    sku_months = month_map(keyed, ["customer_display", "ctl_bucket"])
    sku_months_nos = month_map(
        keyed, ["customer_display", "ctl_bucket"], value="sales_nos", digits=0)
    trend_customer_skus = []
    for (customer, sku), group in keyed.groupby(["customer_display", "ctl_bucket"]):
        first = group.iloc[0]
        months = sku_months.get((customer, sku), {})
        months_nos = sku_months_nos.get((customer, sku), {})
        total_mt = round(float(group["sales_mt"].sum()), 3)
        total_nos = round(float(group["sales_nos"].sum()), 0)
        trend_customer_skus.append({
            "customer_group": first["customer_group"],
            "customer": customer,
            "sku": sku,
            "bucket": first["bucket"],
            "length_m": (
                None if pd.isna(first["length_m"]) else round(float(first["length_m"]), 3)
            ),
            "length_type": first["length_type"],
            "material_codes": ", ".join(sorted({
                str(c) for c in group["material_key"].dropna()
            })) or None,
            "segment": first["segment"],
            "months": months,
            "months_nos": months_nos,
            "total_mt": total_mt,
            "total_nos": total_nos,
            # The window total is kept on the row because the average is taken off it,
            # but the table closes on the average: a SKU bought in three months of eight
            # has a three-month rate, and its eight-month total reads as a monthly one.
            "months_active": len(months),
            "avg_active_month_mt": round(total_mt / len(months), 3) if months else None,
            "avg_active_month_nos": round(total_nos / len(months), 0) if months else None,
        })
    trend_customer_skus.sort(key=lambda r: (r["customer_group"], r["customer"], -r["total_mt"]))

    # ---- The quarterly price-difference working -----------------------------------
    #
    # Every billing line of a quarter, for one customer, in the shape the CN/DN
    # reconciliation is built in. Until now this was typed up by hand into
    # `Price Working <Q> <customer>.xlsx` and only then fed to the reco script.
    #
    # It is written as a **drill-down**, not a section. A quarter is around eight thousand
    # billing lines across all customers and a tab fetches a section whole; `detail_rows`
    # is fetched one key at a time and gated on its prefix, so the page reads only the
    # customer and quarter actually asked for.
    #
    # Three of the sales file's quantity columns are easy to confuse and all three are
    # needed: `qty in no` is pieces, `Domain for z_qty_meter` is metres, and `Quantity`
    # is **always kilograms** whatever the sales unit says — confirmed against all three
    # units by `MATERIAL VAL = RATE/UNIT x (quantity in the sales unit)`.
    #
    # Megh Steel is left out on purpose: it is billed per kilogram against a conversion
    # rate and its reconciliation does not follow the contract-price formula, so it gets
    # its own document rather than being quietly mixed into this one.
    reco_lines = trend[trend["segment"].eq(TREND_SEGMENT_DIRECT)]
    reco_quarters = set()
    reco_grouped = {}
    for _, r in reco_lines.iterrows():
        quarter = financial_quarter(r["billing_month"])
        if quarter is None:
            continue
        reco_quarters.add(quarter)
        length_m = pd.to_numeric(r["length_m"], errors="coerce")
        reco_grouped.setdefault((r["customer_group"], quarter), []).append({
            "customer": r["customer_group"],
            "sap_name": r["customer_display"],
            "customer_code": r["customer_key"],
            # Text, not a number. SAP writes both as integers and pandas reads them as
            # floats, so an invoice would otherwise land in the customer's sheet as
            # `4731002954.0` and match nothing in their file.
            "invoice_no": whole_number_text(r["Billing  Document Number"]),
            "billing_item": whole_number_text(r["Billing Item"]),
            "material_code": r["material_key"],
            "description": none_if_nan(r["Material   Description"]),
            "sales_unit": (
                None if pd.isna(r["SALES  UNIT"]) else str(r["SALES  UNIT"]).strip()
            ),
            "qty_nos": round(float(r["sales_nos"] or 0), 0),
            "qty_m": round(float(r["sales_m"] or 0), 3),
            "qty_kg": round(float(r["sales_mt"] or 0) * 1000, 3),
            "billing_rate": (
                None if pd.isna(r["RATE/UNIT"]) else round(float(r["RATE/UNIT"]), 4)
            ),
            # What the copy joins to a priced SKU on, so the PO rate can be quoted.
            "bucket": none_if_nan(r["bucket"]),
            "ctl_bucket": none_if_nan(r["ctl_bucket"]),
            "length_mm": None if pd.isna(length_m) else round(float(length_m) * 1000, 1),
            "billing_month": r["billing_month"],
            "unit": "INR",
        })
    for (customer, quarter), lines in reco_grouped.items():
        lines.sort(key=lambda x: (str(x["invoice_no"] or ""), str(x["billing_item"] or "")))
        stock_details[f"RECO|{customer}|{quarter}"] = lines
    # Only the quarters this build actually holds billing for. The pricing tab quotes
    # three contract quarters and the sales window covers two and a bit of them; offering
    # a quarter with no invoices would hand somebody an empty document that looks like a
    # nil claim rather than a missing dump.
    reco_quarters = sorted(reco_quarters, key=financial_quarter_order)

    # Which despatch plants each quarter's billing actually covers, and which it is
    # missing that another quarter has.
    #
    # This exists because two of the archived extracts are short and nothing said so.
    # `sales_q4.xlsx` and `sales_q1.xlsx` carry the southern plants only — no Jamshedpur
    # and no Khopoli — where `sales_jul.xlsx` and the daily dump carry every plant. On
    # the complete months those two are 17.7% of lines and 29% of tonnage, and for Megh
    # Steel alone they are 125 of the 200 invoices in Q1 FY27. A claim built off a
    # quarter like that is not slightly short, it is missing a third of itself, and it
    # looks exactly like a complete one.
    #
    # So the coverage is computed rather than assumed, by comparing each quarter against
    # the plants the whole window has seen, and every document says what it is standing
    # on. Nothing is filtered out — a short quarter is still worth reading, and the
    # right response is to re-archive the extract, not to hide the quarter.
    quarter_plants = {}
    plant_weight = {}
    for _, r in trend_all.iterrows():
        quarter = financial_quarter(r["billing_month"])
        plant = norm_code(r["DESP P LANT"])
        if not (quarter and plant):
            continue
        quarter_plants.setdefault(quarter, set()).add(plant)
        plant_weight[plant] = plant_weight.get(plant, 0.0) + float(r["sales_mt"] or 0)
    plants_seen = set().union(*quarter_plants.values()) if quarter_plants else set()
    window_mt = sum(plant_weight.values()) or 1.0
    quarter_coverage = {}
    for quarter, plants in quarter_plants.items():
        missing = sorted(plants_seen - plants)
        # Weighted, because a plant is not a plant: 4318 and 8307 come and go with a
        # handful of lines between them, where Jamshedpur and Khopoli are nearly three
        # tonnes in ten.
        #
        # Stated and not judged. A plant absent from one quarter's extract and present
        # in another's is either a gap in the extract or a plant that shipped nothing,
        # and nothing in the data tells the two apart — so the document prints what each
        # quarter covers and leaves the reading to somebody who knows. A boolean here
        # would be a guess wearing a fact's clothes, and it would be wrong about 4318,
        # which really did stop.
        share = sum(plant_weight.get(p, 0.0) for p in missing) / window_mt
        quarter_coverage[quarter] = {
            "plants": sorted(plants),
            "missing_plants": missing,
            "missing_share": round(share, 4),
        }

    # ---- Megh Steel's own quarterly working ---------------------------------------
    #
    # A separate document, because it is a separate calculation — see the note beside
    # `MEGH_RECO_COST` for why a conversion agent's claim cannot be the ancillaries'.
    # All four codes Megh converts under, in one working per quarter with the OEM as its
    # first column, which is how the four sheets of the owner's workbook divide.
    #
    # **The claim columns are blank and that is deliberate.** Megh prices off its own
    # base-price master, looked up by material number in a workbook this dashboard does
    # not hold. It agrees with `contract.xlsx` on most sizes and not on all: deriving the
    # base from the contract instead reproduces 1,060 of 1,207 lines and overstates a
    # Rs 1.76 crore quarter by Rs 5.05 lakh. Everything that does not depend on it — the
    # line, its quantities in all three units, and the price actually charged — is
    # stated, so the working is complete except for the half nobody can compute yet.
    megh_reco_lines = trend_all[
        trend_all["customer_key"].isin(CONVERSION_AGENT_OEM_BY_CODE)
    ]
    megh_reco_quarters = set()
    megh_reco_grouped = {}
    for _, r in megh_reco_lines.iterrows():
        quarter = financial_quarter(r["billing_month"])
        if quarter is None:
            continue
        megh_reco_quarters.add(quarter)
        kg = float(pd.to_numeric(r["Quantity"], errors="coerce") or 0)
        gross = float(pd.to_numeric(r["TOTAL INV VALUE"], errors="coerce") or 0)
        # What Megh was actually charged, per kilogram, net of GST. Taken off the gross
        # invoice value and not off `MATERIAL VAL`: the two agree on all but a handful of
        # lines, and on those handful the gross is what the owner's workbook uses.
        charged = round(gross / MEGH_RECO_GST_FACTOR / kg, 2) if kg else None
        plant = norm_code(r["DESP P LANT"])
        # The dimensions the line was billed at, which is what Megh's own workbook keys
        # on. A blank bore is zero and not `NaN`: `NaN` is truthy, so a bore left blank
        # would look like a bore and never reach the round key.
        def dim(column):
            value = pd.to_numeric(r[column], errors="coerce")
            return 0.0 if pd.isna(value) else float(value)
        # The sales dump has no grade column; the governed bucket's fourth part is where
        # the grade lives, and it is what tells ERW 2 and CEW apart for the contract.
        parsed = size_key(r["bucket"]) if pd.notna(r["bucket"]) else None
        grade = "" if parsed is None or len(parsed[3]) < 4 else parsed[3][3]
        match = contract_row_for_size(
            dim("Outer Diameter of Material"),
            dim("Inner Diameter of Material"),
            dim("Thickness for TATA Tubes Material"),
            grade,
        )[0]
        base = None if match is None else match["prices"].get(quarter, {}).get("per_ton")
        length_m = pd.to_numeric(r["length_m"], errors="coerce")
        is_long = bool(pd.notna(length_m) and float(length_m) >= LONG_LENGTH_MIN_M)
        megh_reco_grouped.setdefault(quarter, []).append({
            "oem": CONVERSION_AGENT_OEM_BY_CODE[r["customer_key"]],
            "customer_code": r["customer_key"],
            "invoice_no": whole_number_text(r["Billing  Document Number"]),
            "billing_item": whole_number_text(r["Billing Item"]),
            "plant": plant,
            "material_code": r["material_key"],
            "description": none_if_nan(r["Material   Description"]),
            "sales_unit": (
                None if pd.isna(r["SALES  UNIT"]) else str(r["SALES  UNIT"]).strip()
            ),
            "qty_nos": round(float(r["sales_nos"] or 0), 0),
            "qty_m": round(float(r["sales_m"] or 0), 3),
            "qty_kg": round(kg, 3),
            "grade": grade or None,
            "length_type": "LL" if is_long else "CTL",
            "carrying_days": MEGH_RECO_CARRYING_DAYS.get(
                plant, MEGH_RECO_DEFAULT_CARRYING_DAYS
            ),
            # The Tata contract's own figure for the size, for reference beside the
            # charged price. It is **not** Megh's base price and must not be read as one.
            "contract_key": None if match is None else match["key"],
            "contract_base_per_mt": base,
            "charged_rate_per_kg": charged,
            "proposed_rate_per_kg": None,
            "difference_per_kg": None,
            "cn_dn_value": None,
            "cn_dn": None,
            "basis": (
                "Megh prices off its own base-price master, which this build does not "
                "hold — the contract figure beside this is Tata's, not Megh's"
            ),
            "unit": "INR",
        })
    for quarter, lines in megh_reco_grouped.items():
        lines.sort(key=lambda x: (x["oem"], str(x["invoice_no"] or ""),
                                  str(x["billing_item"] or "")))
        stock_details[f"MEGHRECO|{quarter}"] = lines
    megh_reco_quarters = sorted(megh_reco_quarters, key=financial_quarter_order)

    # The same history, re-keyed to the names the customer tracker uses, so a buying
    # meeting can ask "is this month normal for this SKU" without leaving the tab.
    #
    # The two sides name a customer differently: the trend frame writes it as the sales
    # file does ("BALAJI PRESS PRODUCTS INDIA"), the schedule writes the Helper Customer
    # ("Balaji Press Product"). Read the history through the SAP codes the tracker
    # customer itself names, not through `display_by_code` — that map is built for the
    # STR plan and drops any code used under more than one Helper Customer, which is the
    # right rule for moving stock and the wrong one here. Three codes are shared on the
    # 31 July build, and dropping them cost Balaji Press Product and ELKAYEM AUTO Hosur
    # their whole history: 45 tracker lines showing an empty table that reads as "bought
    # nothing" rather than "cannot tell the two apart". A customer can also hold several
    # codes legitimately — ELKAYEM Hosur buys under two. `codes_by_display` and
    # `displays_by_code` are built above, where the trend tables first need them.
    history_keyed = keyed.copy()
    display_rows = []
    for display, codes in codes_by_display.items():
        part = history_keyed[history_keyed["customer_key"].isin(codes)]
        if part.empty:
            continue
        part = part.copy()
        part["plan_customer"] = display
        display_rows.append(part)
    history_keyed = (
        pd.concat(display_rows, ignore_index=True) if display_rows
        else history_keyed.assign(plan_customer=None).iloc[0:0]
    )
    # Where a code is shared, the same history lands under both customers. Say which,
    # rather than presenting one book twice as if it were two.
    shared_with = {
        # A set, because two shared codes can point at the same other customer —
        # ELKAYEM Hosur and Rajsriya Hosur share both of theirs.
        display: sorted({
            other
            for code in codes if len(displays_by_code.get(code, ())) > 1
            for other in displays_by_code[code] if other != display
        })
        for display, codes in codes_by_display.items()
    }
    history_months = month_map(history_keyed, ["plan_customer", "ctl_bucket"])
    # The same history in pieces. A cut length is bought in pieces — the customer's own
    # schedule is written that way — so a CTL trend read only in tonnage is being read in
    # the wrong unit. Carried for every row and shown where it means something.
    history_months_nos = month_map(
        history_keyed, ["plan_customer", "ctl_bucket"], value="sales_nos", digits=0)
    customer_sku_history = []
    for (customer, sku), group in history_keyed.groupby(["plan_customer", "ctl_bucket"]):
        first = group.iloc[0]
        months = history_months.get((customer, sku), {})
        months_nos = history_months_nos.get((customer, sku), {})
        codes = ", ".join(sorted({str(c) for c in group["material_key"].dropna()})) or None
        # One row per month, so the drill-down reads as a history rather than a total.
        stock_details[f"SKUHISTORY|{customer}|{sku}"] = [
            {
                "source": month,
                "plant": None,
                "sku": sku,
                "material_code": codes,
                "customer": customer,
                "nos": months_nos.get(month),
                "qty": months[month],
                "unit": "MT",
            }
            for month in trend_months if months.get(month)
        ]
        total_mt = round(float(group["sales_mt"].sum()), 3)
        total_nos = round(float(group["sales_nos"].sum()), 0)
        customer_sku_history.append({
            "customer": customer,
            "sku": sku,
            "bucket": first["bucket"],
            "length_m": (
                None if pd.isna(first["length_m"]) else round(float(first["length_m"]), 3)
            ),
            "length_type": first["length_type"],
            "material_codes": codes,
            "months": months,
            "months_nos": months_nos,
            "total_mt": total_mt,
            "total_nos": total_nos,
            # Averaged over the months the SKU actually moved, not over the window. A
            # SKU bought in two of seven months has a two-month average; dividing by
            # seven would read as a small steady line rather than an occasional large
            # one, and those are bought differently.
            "months_active": len(months),
            "avg_active_month_mt": (
                round(total_mt / len(months), 3) if months else None
            ),
            "avg_active_month_nos": (
                round(total_nos / len(months), 0) if months else None
            ),
            "detail_key": f"SKUHISTORY|{customer}|{sku}",
        })
    customer_sku_history.sort(key=lambda r: (r["customer"], -r["total_mt"]))
    # Why a customer's history is empty, for the customers where it is. "No sales under
    # its codes" and "no codes to look under" are different problems with different
    # fixes, and an empty table states neither.
    history_customers = {r["customer"] for r in customer_sku_history}
    customer_history_notes = {
        display: {
            "shared_codes_with": shared_with.get(display, []),
            "reason": (
                None if display in history_customers
                else "no code recorded for this customer" if not codes
                else "no sales under "
                     + ("code " if len(codes) == 1 else "codes ")
                     + ", ".join(sorted(codes)) + " in the history window"
            ),
        }
        for display, codes in codes_by_display.items()
    }

    # And the same history on the tracker's own lines, so it sits beside this month's
    # schedule and dispatch instead of in a second place to look. The **average** month,
    # not the window total: the line beside it is one month of schedule and one month of
    # dispatch, and a six-month total set against them reads as a SKU running six times
    # its real rate. Averaged over the months that moved, the same rule the history table
    # and its card use, so the three agree.
    history_averages = {
        (r["customer"], r["sku"]): r["avg_active_month_mt"] for r in customer_sku_history
    }
    history_months = {
        (r["customer"], r["sku"]): r["months_active"] for r in customer_sku_history
    }
    history_pairs = set(history_averages)
    schedule_export["history_avg_month_mt"] = [
        history_averages.get((customer, sku))
        for customer, sku in zip(
            schedule_export["customer_display"], schedule_export["ctl_bucket"]
        )
    ]
    schedule_export["history_months_active"] = [
        history_months.get((customer, sku))
        for customer, sku in zip(
            schedule_export["customer_display"], schedule_export["ctl_bucket"]
        )
    ]
    schedule_export["history_detail_key"] = [
        f"SKUHISTORY|{customer}|{sku}" if (customer, sku) in history_pairs else None
        for customer, sku in zip(
            schedule_export["customer_display"], schedule_export["ctl_bucket"]
        )
    ]

    # Table three: despatch plants. Held at the grain the filters cut on, so the page can
    # total it live without a round trip.
    plant_grouped = (
        trend.groupby(
            ["despatch_plant", "billing_month", "length_type", "angle_cut", "chamfer"],
            dropna=False,
        )
        .agg(sales_mt=("sales_mt", "sum"), sales_nos=("sales_nos", "sum"))
        .reset_index()
    )
    trend_plants = [
        {
            "plant": None if pd.isna(r["despatch_plant"]) else str(r["despatch_plant"]),
            "month": r["billing_month"],
            "length_type": r["length_type"],
            "angle_cut": bool(r["angle_cut"]),
            "chamfer": bool(r["chamfer"]),
            "sales_mt": round(float(r["sales_mt"]), 3),
            "sales_nos": round(float(r["sales_nos"]), 0),
        }
        for _, r in plant_grouped.iterrows()
    ]

    trend_segment_totals = {
        segment: round(float(group["sales_mt"].sum()), 3)
        for segment, group in trend.groupby("segment")
    }
    trend_segment_totals_nos = {
        segment: round(float(group["sales_nos"].sum()), 0)
        for segment, group in trend.groupby("segment")
    }
    trend_month_totals = {
        month: {
            "total_mt": round(float(group["sales_mt"].sum()), 3),
            "total_nos": round(float(group["sales_nos"].sum()), 0),
            TREND_SEGMENT_DIRECT: round(float(
                group.loc[group["segment"].eq(TREND_SEGMENT_DIRECT), "sales_mt"].sum()), 3),
            TREND_SEGMENT_MEGH: round(float(
                group.loc[group["segment"].eq(TREND_SEGMENT_MEGH), "sales_mt"].sum()), 3),
            f"{TREND_SEGMENT_DIRECT} nos": round(float(
                group.loc[group["segment"].eq(TREND_SEGMENT_DIRECT), "sales_nos"].sum()), 0),
            f"{TREND_SEGMENT_MEGH} nos": round(float(
                group.loc[group["segment"].eq(TREND_SEGMENT_MEGH), "sales_nos"].sum()), 0),
        }
        for month, group in trend.groupby("billing_month")
    }
    for month, totals in trend_month_totals.items():
        # Both units on the card, so switching the tab does not change what a breakup says.
        stock_details[f"TRENDMONTH|{month}"] = [
            {"source": segment, "plant": None, "sku": month, "material_code": None,
             "nos": totals[f"{segment} nos"], "qty": totals[segment], "unit": "MT"}
            for segment in (TREND_SEGMENT_DIRECT, TREND_SEGMENT_MEGH)
        ]

    sales_trend = {
        "available": bool(trend_months),
        "note": None if trend_months else "No sales history was supplied.",
        "months": trend_months,
        "sources": trend_sources + [{"file": "sales.xlsx", "rows": int(len(sales))}],
        "segments": [TREND_SEGMENT_DIRECT, TREND_SEGMENT_MEGH],
        "segment_totals": trend_segment_totals,
        "segment_totals_nos": trend_segment_totals_nos,
        "month_totals": trend_month_totals,
        "buckets": trend_buckets,
        "customers": trend_customers,
        "customer_skus": trend_customer_skus,
        # Keyed to the customer tracker's names rather than the sales file's.
        "customer_sku_history": customer_sku_history,
        "customer_history_notes": customer_history_notes,
        "plants": trend_plants,
        "unbucketed_mt": round(float(
            trend.loc[trend["bucket"].isna(), "sales_mt"].sum()), 3),
        "value_add_source": "Schedule July, matched on material code",
    }

    # The long-length tracker reads one month against one month's stock, which answers
    # "are we short now" and not "is this month normal". The bucket's own billing history
    # is already built above, so the tracker carries the last complete month beside the
    # current one and opens the whole window on a click.
    #
    # Last complete month, not simply the last month held: the window runs to the month in
    # progress, and five days of August against a full July would read as a collapse.
    as_of_month = f"{as_of_date.year:04d}-{as_of_date.month:02d}"
    complete_months = [m for m in trend_months if m < as_of_month]
    last_full_month = complete_months[-1] if complete_months else None
    trend_by_bucket = {r["bucket"]: r for r in trend_buckets}
    # Write onto the frame, never rebuild it from `ll_rows`. Order book and sign-off are
    # added to `ll_tracker` as columns further up, long after those dicts were built, so
    # `pd.DataFrame(ll_rows)` here would silently drop them — which it did: the whole
    # tracker published 0 MT ordered and 0 MT signed off.
    last_month_by_bucket, history_key_by_bucket = {}, {}
    for bucket in ll_tracker["bucket"]:
        months = (trend_by_bucket.get(bucket) or {}).get("months", {})
        last_month_by_bucket[bucket] = round(float(months.get(last_full_month, 0) or 0), 3)
        # A bucket with no billing in the window at all has no history to open, and a
        # button onto an empty card is worse than a plain figure.
        history_key_by_bucket[bucket] = f"LLHISTORY|{bucket}" if months else None
        if not months:
            continue
        month_rows = bucketed[bucketed["bucket"].eq(bucket)]
        stock_details[f"LLHISTORY|{bucket}"] = [
            {
                "source": month,
                "plant": None,
                "sku": bucket,
                "material_code": None,
                "direct_mt": round(float(month_rows.loc[
                    month_rows["billing_month"].eq(month)
                    & month_rows["segment"].eq(TREND_SEGMENT_DIRECT), "sales_mt"].sum()), 3),
                "megh_mt": round(float(month_rows.loc[
                    month_rows["billing_month"].eq(month)
                    & month_rows["segment"].eq(TREND_SEGMENT_MEGH), "sales_mt"].sum()), 3),
                "qty": months[month],
                "unit": "MT",
            }
            for month in trend_months if months.get(month)
        ]
    ll_tracker["last_month_sales_mt"] = ll_tracker["bucket"].map(last_month_by_bucket)
    ll_tracker["history_detail_key"] = (
        ll_tracker["bucket"].map(history_key_by_bucket).astype(object).where(
            ll_tracker["bucket"].map(history_key_by_bucket).notna(), None)
    )
    sales_trend["last_full_month"] = last_full_month

    qc = {
        "sales_material_number_last_digit_zero_rate": round(
            sales_transactions["material_key"].dropna().str.endswith("0").mean(), 4
        ),
        "sales_bucket_resolution": {
            "rows": int(len(sales_transactions)),
            "resolved": int(sales_transactions["bucket"].notna().sum()),
            "rate": round(sales_transactions["bucket"].notna().mean(), 4),
            "tvs_rows": int(sales_transactions["OEM"].eq("TVS").sum()),
            "tvs_resolved": int(
                (sales_transactions["OEM"].eq("TVS") & sales_transactions["bucket"].notna()).sum()
            ),
            "tvs_rate": round(
                sales_transactions.loc[
                    sales_transactions["OEM"].eq("TVS"), "bucket"
                ].notna().mean(),
                4,
            ),
        },
        "stock_bucket_resolution": {
            "rows": int(len(stock)),
            "resolved": int(stock["bucket"].notna().sum()),
            "rate": round(stock["bucket"].notna().mean(), 4),
            "oem_resolved_rate": round(stock["OEM"].notna().mean(), 4),
            "tvs_rows": int(stock["OEM"].eq("TVS").sum()),
            "tvs_resolved_rate": round(
                stock.loc[stock["OEM"].eq("TVS"), "bucket"].notna().mean(), 4
            ),
        },
        "wip_unmapped": {
            "lines": len(wip_unmapped),
            "wip_mt": round(sum(r["wip_mt"] for r in wip_unmapped), 3),
            "by_reason": {
                reason: round(
                    sum(r["wip_mt"] for r in wip_unmapped if r["reason"] == reason), 3
                )
                for reason in sorted({r["reason"] for r in wip_unmapped if r["reason"]})
            },
        },
        "wip_bucket_resolution": {
            "rows": int(len(wip)),
            "resolved": int(wip["bucket"].notna().sum()),
            "rate": round(wip["bucket"].notna().mean(), 4),
            "customer_or_oem_available": False,
        },
        "rfd_4731_resolution": {
            "positive_rows": int((rfd["stock_nos"] > 0).sum()),
            "resolved_rows": int(((rfd["stock_nos"] > 0) & rfd["ctl_bucket"].notna()).sum()),
            "resolved_nos": round(float(rfd_stock["stock_nos"].sum()), 3),
            "unresolved_nos": round(
                float(rfd.loc[(rfd["stock_nos"] > 0) & rfd["ctl_bucket"].isna(), "stock_nos"].sum()),
                3,
            ),
            "rows_without_ctl_code": int(
                ((rfd["stock_nos"] > 0) & rfd["CTL Code"].isna()).sum()
            ),
            "recovered_by_size": {
                "rows": len(rfd_recovered),
                "stock_nos": round(sum(r["stock_nos"] for r in rfd_recovered), 3),
                "stock_mt": round(sum(r["stock_mt"] for r in rfd_recovered), 3),
                "materials": sorted(
                    {code for r in rfd_recovered for code in r["materials"]}
                ),
            },
            "no_bucket_after_recovery": {
                "rows": len(rfd_unrecovered),
                "stock_nos": round(sum(r["stock_nos"] for r in rfd_unrecovered), 3),
                "stock_mt": round(sum(r["stock_mt"] for r in rfd_unrecovered), 3),
            },
        },
        "inventory_source_coverage": source_coverage,
        "approved_inventory_sources": {
            "ctl_789_nos": round(float(ctl_stock["stock_nos"].sum()), 3),
            "ctl_rfd_4731_nos": round(float(rfd_stock["stock_nos"].sum()), 3),
            "ll_plant_stock_mt": round(float(ll_stock["stock_mt"].sum()), 3),
            "ll_wip_ystockn_mt": round(float(wip.loc[wip["bucket"].notna(), "wip_mt"].sum()), 3),
            "ll_transit_mt": round(float(transit_stock["stock_mt"].sum()), 3),
            "stock_analysis_ctl_mt": round(
                sum(r["stock_mt"] for r in stock_analysis["ctl"]), 3
            ),
            "stock_analysis_ll_mt": round(
                sum(r["stock_mt"] for r in stock_analysis["ll"]), 3
            ),
            "rfd_unbacked_4731_ctl_mt": round(rfd_unbacked_mt, 3),
            "rfd_unbacked_4731_ctl_materials": rfd_unbacked_materials,
            "rfd_partly_backed_4731_ctl_materials": rfd_partly_backed_materials,
            "high_age_mt_month_end": round(
                sum(r["high_age_mt"] for r in stock_analysis["ctl"] + stock_analysis["ll"]), 3
            ),
            "high_age_rule": (
                f"ageing over {HIGH_AGE_DAYS} days at {month_end.date().isoformat()} "
                f"(as-of + {days_to_month_end} days)"
            ),
        },
        "schedule": {
            "active_rows": int(len(schedule)),
            "grouped_lines": int(len(schedule_group)),
            "oem_resolved_rate": round(schedule_group["OEM"].notna().mean(), 4),
            # Top-card metrics are TVS-only: TSL demand is restricted to OEM TVS
            # and combined with the TVSM sheet requirement.
            "tvs_lines": int(len(tvs_schedule)),
            "tsl_schedule_mt": round(float(tvs_schedule["schedule_mt"].sum()), 3),
            "tvsm_schedule_mt": round(float(vsm["vsm_schedule_mt"].sum()), 3),
            "total_schedule_mt": tvs_total_schedule_mt,
            "matched_sales_mt": round(float(tvs_schedule["sales_mt"].sum()), 3),
            "tsl_open_balance_mt": round(float(tvs_schedule["open_balance_mt"].sum()), 3),
            "all_oem_schedule_mt": round(float(schedule_group["schedule_mt"].sum()), 3),
            # Total TVS dispatch is every sale for a customer whose OEM_key_1_rev
            # OEM is TVS, plus customer 943209 (Megh Steels - TVS A), which the OEM
            # key classifies as Direct but which supplies TVS. The two sets are
            # disjoint, so the totals add without double counting.
            "tvs_oem_sales_mt": round(float(tvs_oem_sales["sales_mt"].sum()), 3),
            "tvs_proxy_ll_stock_mt": round(
                float(
                    ll_stock.loc[
                        ll_stock["customer_name_key"].isin(TVS_PROXY_CUSTOMER_NAMES),
                        "stock_mt",
                    ].sum()
                ),
                3,
            ),
            "cust_943209_sales_mt": round(float(cust_943209_sales["sales_mt"].sum()), 3),
            "tvs_total_sales_mt": tvs_total_sales_mt,
            # Headline open balance nets total TVS demand against total TVS dispatch.
            # Left unclamped so aggregate over-dispatch stays visible.
            "total_open_balance_mt": tvs_total_open_balance_mt,
        },
        "ll_risk_counts": ll_tracker["risk"].value_counts().to_dict(),
        "megh_tracker": {
            "skus": len(megh_rows),
            "ground_stock_mt": round(sum(r["ground_stock_mt"] for r in megh_rows), 3),
            "transit_stock_mt": round(sum(r["transit_stock_mt"] for r in megh_rows), 3),
            "sales_mt": round(sum(r["sales_mt"] for r in megh_rows), 3),
            "megh_sales_in_file_mt": round(float(megh_sales_rows["sales_mt"].sum()), 3),
            "schedule_mt": round(sum(r["schedule_mt"] for r in megh_rows), 3),
            "orders_logged_mt": round(sum(r["orders_logged_mt"] for r in megh_rows), 3),
            "orders_planning_mt": round(
                sum(r["orders_planning_mt"] for r in megh_rows), 3
            ),
            # The length-bucketing the plan supplies, and how much of it Bucketting is
            # missing — a code the plan governs and Bucketting does not is what stops an
            # order for that code reaching a bucket on its own.
            # Bought-out parts: sizes Megh buys finished rather than converting.
            "bop_items_listed": len(MEGH_BOP_ITEMS),
            "bop_skus_flagged": sum(1 for r in megh_rows if r["bop"]),
            "bop_matched_on_nearest_length": sum(
                1 for r in megh_rows
                if r["bop"] and r["in_plan"] and float(r["bop_length_gap_mm"] or 0) > 0
            ),
            # Listed sizes the plan has no row for, carried as their own line items.
            "bop_added_off_plan": len(megh_bop_added),
            "bop_nos_listed": sum(item[4] for item in MEGH_BOP_ITEMS),
            "length_bucketing_sizes": len(megh_length_bucketing),
            "length_bucketing_codes": sum(
                r["codes_total"] for r in megh_length_bucketing
            ),
            "length_bucketing_codes_absent_from_bucketting": sum(
                r["codes_total"] - r["codes_in_bucketting"] for r in megh_length_bucketing
            ),
            "unmapped_sales_lines": len(megh_unmapped),
            "unmapped_sales_mt": round(sum(r["sales_mt"] for r in megh_unmapped), 3),
        },
        "overdue_analysis": {
            "rule": f"open items unpaid {RECEIVABLE_DUE_DAYS} days after invoice date",
            "ancillaries": len(overdue_rows),
            "total_overdue": round(sum(r["overdue_amount"] for r in overdue_rows), 2),
            # The gross split of the net. Recorded here rather than shown on the tab,
            # where two more columns sat between the figure and its ageing.
            "total_debits": round(sum(r["overdue_debits"] for r in overdue_rows), 2),
            "total_credits": round(sum(r["overdue_credits"] for r in overdue_rows), 2),
            "over_90_days": round(sum(r["over_90_days_amount"] for r in overdue_rows), 2),
            "unmapped_customers": overdue_unmapped,
            "total_offsets": round(sum(r["offsets_amount"] for r in overdue_rows), 2),
            # Rows that are neither a billing document nor an offset — chiefly the debit
            # balances, which add to the exposure rather than reducing it and so are kept
            # out of the offsets figure. Reported per Nature so the exclusion is a number
            # somebody can check, and so a Nature nobody has seen appears here first.
            "excluded_natures": overdue_excluded,
        },
        "transfers": {
            "available": transfers_available,
            "note": transfers_note,
            "lines": len(transfer_rows),
            "transferred_mt": round(sum(r["qty_mt"] for r in transfer_rows), 3),
            "in_transit_mt": round(
                sum(r["qty_mt"] for r in transfer_rows if r["in_transit"]), 3
            ),
            "in_transit_lines": sum(1 for r in transfer_rows if r["in_transit"]),
            # Transfer lines that reach no governed bucket cannot join the STR plan.
            "unbucketed_mt": round(
                sum(r["qty_mt"] for r in transfer_rows if not r["bucket"]), 3
            ),
            "bucket_resolution_rate": (
                round(
                    sum(r["qty_mt"] for r in transfer_rows if r["bucket"])
                    / sum(r["qty_mt"] for r in transfer_rows),
                    4,
                )
                if any(r["qty_mt"] for r in transfer_rows) else None
            ),
        },
        "rm_tracker_tvsm": {
            # The sheet ends with its own grand total. Report what was dropped so the
            # figures can be reconciled against the workbook by eye.
            "grand_total_rows_dropped": len(vsm_totals_dropped),
            "grand_total_values": vsm_totals_dropped,
            "vsm_sales_mt": megh_to_tvsm_sales_mt,
            "vsm_schedule_mt": round(float(vsm["vsm_schedule_mt"].sum()), 3),
        },
        "sales_trend": {
            "available": sales_trend["available"],
            "months": len(sales_trend["months"]),
            "from": sales_trend["months"][0] if sales_trend["months"] else None,
            "to": sales_trend["months"][-1] if sales_trend["months"] else None,
            "sources": sales_trend["sources"],
            "buckets": len(sales_trend["buckets"]),
            "customers": len(sales_trend["customers"]),
            "customer_skus": len(sales_trend["customer_skus"]),
            "segment_totals": sales_trend["segment_totals"],
            "total_mt": round(sum(sales_trend["segment_totals"].values()), 3),
            # Trend tonnage on a line reaching no governed bucket: it is in the totals
            # and the plant table, and cannot appear in the bucket table.
            "unbucketed_mt": sales_trend["unbucketed_mt"],
        },
        "orders": {
            "available": orders_available,
            "note": orders_note,
            # The live book, after the remark filter. `in_sheet` is what arrived.
            "lines": sum(1 for r in order_rows if not r["excluded"]),
            "order_mt": round(
                sum(r["order_mt"] for r in order_rows if not r["excluded"]), 3
            ),
            "lines_in_sheet": len(order_rows),
            "order_mt_in_sheet": round(sum(r["order_mt"] for r in order_rows), 3),
            "excluded_remark": ORDER_EXCLUDE_REMARK,
            "excluded_lines": sum(1 for r in order_rows if r["excluded"]),
            "excluded_mt": round(
                sum(r["order_mt"] for r in order_rows if r["excluded"]), 3
            ),
            "by_origin": order_summary,
            # Orders reaching no governed bucket sit outside the pooled column, so the
            # tonnage they hold has to be reported rather than silently dropped.
            "unbucketed_mt": round(
                sum(r["order_mt"] for r in order_rows
                    if not r["bucket"] and not r["excluded"]), 3
            ),
            "bucket_resolution_rate": (
                round(
                    sum(r["order_mt"] for r in order_rows
                        if r["bucket"] and not r["excluded"])
                    / sum(r["order_mt"] for r in order_rows if not r["excluded"]),
                    4,
                )
                if any(r["order_mt"] for r in order_rows if not r["excluded"]) else None
            ),
            "buckets_with_orders": len(order_pool),
            "megh_skus_with_orders": len(megh_order_plan),
            "megh_order_mt": round(sum(megh_order_plan.values()), 3),
            # Megh order tonnage reaching no row on the Megh tab, whether because the
            # plan does not carry the SKU or because no SKU key could be derived.
            "megh_order_off_plan_mt": round(
                sum(r["order_mt"] for r in order_unmapped
                    if "Megh Steel tab" in r["missing_from"]), 3
            ),
            # Bucketed order tonnage on a bucket the long-length tracker has no row for.
            "orders_off_ll_tracker_mt": round(
                sum(r["order_mt"] for r in order_unmapped
                    if "Long-length tracker" in r["missing_from"]), 3
            ),
            # One line per open order absent from a view that should carry it, so this
            # total is the tonnage missing from an Order logged column without double
            # counting. The invisible_mt subset is absent from every view at once.
            # Excluded lines are listed on the same sheet but are not a gap to close.
            "unmapped_lines": sum(
                1 for r in order_unmapped if r["shown_on"] != "Excluded on purpose"
            ),
            "unmapped_mt": round(sum(
                r["order_mt"] for r in order_unmapped
                if r["shown_on"] != "Excluded on purpose"), 3),
            "invisible_mt": round(
                sum(r["order_mt"] for r in order_unmapped if r["shown_on"] == "Nowhere"), 3
            ),
            "oldest_order_days": max(
                (r["age_days"] for r in order_rows
                 if r["age_days"] is not None and not r["excluded"]),
                default=None,
            ),
            "lines_without_age": sum(
                1 for r in order_rows if r["age_days"] is None and not r["excluded"]
            ),
            "sheet_faults": order_sheet_faults,
        },
        "str_plan": {
            "destination_plant": STR_DESTINATION_PLANT,
            "source_plants": list(STR_SOURCE_PLANTS),
            "target_days": STR_TARGET_DAYS,
            "customers": list(STR_CUSTOMERS),
            "grain": "bucket",
            "rule": (
                f"cover = (stock earmarked to the plan customers at "
                f"{STR_DESTINATION_PLANT} + tonnage in transit to it) divided by "
                f"schedule MT / {days_in_month} days; STR required = "
                f"{STR_TARGET_DAYS} days of schedule less that cover"
            ),
            "rows": len(str_rows),
            "short_rows": sum(1 for r in str_rows if r["risk"] == "Short"),
            "stock_at_destination_mt": round(
                sum(r["owned_8406_mt"] for r in str_rows), 3
            ),
            "in_transit_to_destination_mt": round(
                sum(r["in_transit_mt"] for r in str_rows), 3
            ),
            "str_required_mt": round(sum(r["str_required_mt"] for r in str_rows), 3),
            "str_allocated_mt": round(sum(r["str_allocated_mt"] for r in str_rows), 3),
            "str_shortfall_mt": round(sum(r["str_shortfall_mt"] for r in str_rows), 3),
            "str_lines": sum(len(r["str_lines"]) for r in str_rows),
            "str_lines_from_wip": sum(
                1 for r in str_rows for l in r["str_lines"] if l["from_wip"]
            ),
            "wip_without_fg_code": {
                "rows": len(str_wip_unresolved),
                "wip_mt": round(sum(r["wip_mt"] for r in str_wip_unresolved), 3),
            },
            "unmapped_destination_stock": str_unmapped_dest_stock,
            "unbucketed_schedule": str_unbucketed,
        },
        "sku_pricing": {
            "available": pricing_available,
            "note": pricing_note,
            "quarters": list(PRICING_QUARTERS),
            "operation_rates_inr_per_ton": dict(PRICING_OPERATION_RATES),
            "rule": (
                "price per m = contract base price per m for the quarter + "
                "sum(operation INR per tonne x contract kg/m / 1000); LL is quoted "
                f"per metre and CTL per piece at length, split at "
                f"{LONG_LENGTH_MIN_M} m"
            ),
            "contract_sizes": sum(len(v) for v in contract_index.values()),
            "rows": len(pricing_rows),
            "customers": len({r["customer"] for r in pricing_rows}),
            "priced_schedule_mt": round(sum(r["schedule_mt"] for r in pricing_rows), 3),
            "unpriced_schedule_mt": round(
                sum(r["schedule_mt"] for r in pricing_unpriced), 3
            ),
            "rows_with_value_adds": sum(1 for r in pricing_rows if r["operations"]),
            # SKUs whose operations the owner has corrected on the tab. Worth watching:
            # a correction that stops matching — because a length changed, or a customer
            # was renamed — goes quiet rather than erroring, and this is where it shows.
            "rows_with_corrected_operations": pricing_corrections,
            # The quarterly CN/DN working, as drill-downs: one key per customer per
            # quarter, and how many billing lines they carry between them.
            "reco_quarters": reco_quarters,
            "reco_keys": len(reco_grouped),
            "reco_lines": sum(len(v) for v in reco_grouped.values()),
            "matched_ignoring_bore": sum(
                1 for r in pricing_rows if r["matched_via"] != "size"
            ),
            "unpriced": pricing_unpriced[:20],
        },
        "code_repository": repository_window,
        "missing_mapping_counts": (
            missing_mappings["mapping_type"].value_counts().to_dict()
            if not missing_mappings.empty else {}
        ),
        "critical_low_examples": ll_tracker[
            ll_tracker["risk"].isin(["Critical", "Low"])
        ].head(20).replace({np.nan: None}).to_dict("records"),
        "limitations": [
            "CTL and LL stock are pooled resources; pool values must not be summed across customer rows.",
            "WIP ystockn is treated as shared LL stock because it has no customer/OEM ownership.",
            "Customer CTL stock uses only 0789 plant stock plus mapped RFD 4731 quantity.",
            "Transit stock is read only from PLANT STOCKS and pooled at bucket level; the plant shown is where it is booked, not the despatch plant.",
        ],
    }
    warnings = []
    failures = []
    if schedule_month is not None and as_of_date.month != schedule_month:
        warnings.append(
            f"The schedule is {schedule_sheet.replace('Schedule ', '')}'s while these "
            f"dumps are {as_of_date.strftime('%B')}'s, so balances are last month's "
            "demand against this month's dispatch and read far higher than they are. "
            "Coverage, open balance and dispatch compliance are not comparable until "
            "the new month's schedule workbook arrives."
        )
    if qc["sales_bucket_resolution"]["tvs_rate"] < 0.98:
        warnings.append("TVS sales bucket resolution is below 98%.")
    if qc["stock_bucket_resolution"]["tvs_resolved_rate"] < 0.99:
        warnings.append("TVS stock bucket resolution is below 99%.")
    if qc["wip_bucket_resolution"]["rate"] < 0.90:
        warnings.append("WIP bucket resolution is below 90%; unresolved WIP is excluded from LL stock.")
    if not qc["transfers"]["available"]:
        warnings.append(
            f"Transfers and STR in-transit are unavailable: {qc['transfers']['note']}"
        )
    if not qc["sku_pricing"]["available"]:
        warnings.append(f"SKU pricing is unavailable: {qc['sku_pricing']['note']}")
    if qc["rfd_4731_resolution"]["unresolved_nos"] > 0:
        warnings.append("Some positive RFD 4731 quantity has no CTL mapping and is excluded.")
    if qc["sales_bucket_resolution"]["tvs_rate"] < 0.90:
        failures.append("TVS sales bucket resolution is below the 90% hard floor.")
    if qc["stock_bucket_resolution"]["tvs_resolved_rate"] < 0.95:
        failures.append("TVS stock bucket resolution is below the 95% hard floor.")
    if qc["schedule"]["active_rows"] == 0:
        failures.append("No active schedule rows were found.")
    if qc["schedule"]["oem_resolved_rate"] < 0.99:
        failures.append("Schedule OEM resolution is below 99%.")

    status = "FAIL" if failures else ("WARN" if warnings else "PASS")
    refreshed_at = datetime.now(timezone.utc).isoformat()
    as_of = as_of or refreshed_at[:10]

    def records(frame):
        return json.loads(
            frame.replace({np.nan: None, np.inf: None, -np.inf: None}).to_json(
                orient="records", date_format="iso"
            )
        )

    dashboard_data = {
        "metadata": {
            "status": status,
            "as_of": as_of,
            "refreshed_at_utc": refreshed_at,
            "warnings": warnings,
            "failures": failures,
        },
        "summary": {
            "active_schedule_rows": qc["schedule"]["tvs_lines"],
            "tsl_schedule_mt": qc["schedule"]["tsl_schedule_mt"],
            "tvsm_schedule_mt": qc["schedule"]["tvsm_schedule_mt"],
            "schedule_mt": qc["schedule"]["total_schedule_mt"],
            "sales_mt": qc["schedule"]["tvs_total_sales_mt"],
            # The two headline sales cards. They share the direct-ancillary term and
            # differ on the second, so neither is a subtotal of the other.
            "tvsm_received_sales_mt": tvsm_received_sales_mt,
            "tsl_billed_sales_mt": tsl_billed_sales_mt,
            "direct_ancillary_sales_mt": direct_ancillary_sales_mt,
            "megh_agent_sales_mt": megh_agent_sales_mt,
            "megh_to_tvsm_sales_mt": megh_to_tvsm_sales_mt,
            "tvs_oem_sales_mt": qc["schedule"]["tvs_oem_sales_mt"],
            "cust_943209_sales_mt": qc["schedule"]["cust_943209_sales_mt"],
            "matched_sales_mt": qc["schedule"]["matched_sales_mt"],
            "open_balance_mt": qc["schedule"]["total_open_balance_mt"],
            "tsl_open_balance_mt": qc["schedule"]["tsl_open_balance_mt"],
            "critical_buckets": int(qc["ll_risk_counts"].get("Critical", 0)),
            "low_buckets": int(qc["ll_risk_counts"].get("Low", 0)),
        },
        "mapping_quality": {
            "tvs_sales": qc["sales_bucket_resolution"]["tvs_rate"],
            "tvs_stock": qc["stock_bucket_resolution"]["tvs_resolved_rate"],
            "wip": qc["wip_bucket_resolution"]["rate"],
        },
        "customer_lines": records(schedule_export),
        "customer_summary": records(customer_summary),
        "ll_tracker": records(ll_tracker),
        "stock_details": {**stock_details, **metric_details},
        "missing_mappings": records(missing_mappings),
        "sales_summary": records(sales_summary),
        "stock_analysis": stock_analysis,
        "str_plan": {
            "rows": str_rows,
            "destination_plant": STR_DESTINATION_PLANT,
            "source_plants": list(STR_SOURCE_PLANTS),
            "target_days": STR_TARGET_DAYS,
            "customers": list(STR_CUSTOMERS),
            "unmapped_destination_stock": str_unmapped_dest_stock,
            "unbucketed_schedule": str_unbucketed,
            "wip_without_fg_code": str_wip_unresolved,
        },
        "transfers": {
            "rows": transfer_rows,
            "plants": transfer_plants,
            "available": transfers_available,
            "note": transfers_note,
        },
        "code_repository": {
            "rows": code_repository,
            "window": repository_window,
        },
        "sales_trend": sales_trend,
        "orders": {
            "rows": order_rows,
            "summary": order_summary,
            "unmapped": order_unmapped,
            "sheet_faults": order_sheet_faults,
            "available": orders_available,
            "note": orders_note,
        },
        "sku_pricing": {
            "rows": pricing_rows,
            "unpriced": pricing_unpriced,
            "available": pricing_available,
            "note": pricing_note,
            "quarters": list(PRICING_QUARTERS),
            # The quarters the CN/DN calculation can actually be produced for: the ones
            # this build holds billing lines for, which is not the same list. The contract
            # covers three quarters and the sales window covers two and a bit of them, so
            # offering all three would hand somebody an empty document that reads as a nil
            # claim rather than as a missing dump.
            "reco_quarters": reco_quarters,
            # What each of those quarters is standing on. A quarter whose extract is
            # missing a plant that another quarter has is named as such on the document.
            "quarter_coverage": quarter_coverage,
            "operation_rates_inr_per_ton": dict(PRICING_OPERATION_RATES),
        },
        "megh_tracker": megh_rows,
        # The quarters Megh's own working can be produced for, and how much of it is
        # still waiting on their base-price master. A scalar rather than a section: it
        # is four numbers, and the working itself is a drill-down.
        "megh_reco": {
            "quarters": megh_reco_quarters,
            "quarter_coverage": quarter_coverage,
            "lines": sum(len(v) for v in megh_reco_grouped.values()),
            "oems": sorted(set(CONVERSION_AGENT_OEM_BY_CODE.values())),
            "priced": False,
            "note": (
                "Line-level only. Megh prices off its own base-price master, looked up "
                "by material number in a workbook this build does not hold, so the "
                "claim columns are left blank rather than derived from the Tata "
                "contract — which agrees on most sizes and not on all."
            ),
        },
        "megh_length_bucketing": megh_length_bucketing,
        "megh_bop_added": megh_bop_added,
        "megh_unmapped": megh_unmapped,
        "wip_unmapped": wip_unmapped,
        "stock_unmapped": stock_unmapped,
        "rfd_unmapped": rfd_unrecovered,
        "governed_buckets": governed_buckets,
        "signoff": {
            "available": bool(signoff_rows),
            "sheets": list(SIGNOFF_SHEETS),
            "signed_mt": round(sum(r["signed_mt"] for r in signoff_rows), 3),
            "non_signed_mt": round(sum(r["unsigned_mt"] for r in signoff_rows), 3),
            "unmapped": signoff_unmapped[:50],
            "unmapped_mt": round(
                sum(r["signed_mt"] + r["unsigned_mt"] for r in signoff_unmapped), 3),
        },
        "detail_columns": {
            "STOCKCTL": STOCK_DETAIL_COLUMNS,
            "STOCKLL": STOCK_DETAIL_COLUMNS,
            "OVERDUE": OVERDUE_DETAIL_COLUMNS,
            "OFFSET": OFFSET_DETAIL_COLUMNS,
            "STRDEST": STOCK_DETAIL_COLUMNS,
            "STRSOURCE": STR_SOURCE_DETAIL_COLUMNS,
            "SIGNOFF": SIGNOFF_DETAIL_COLUMNS,
            "MEGHSIGNOFF": SIGNOFF_DETAIL_COLUMNS,
            # Months across the columns, so the layout is as long as the window is.
            "MEGHSALES": megh_sales_detail_columns(trend_months),
            "TRENDBUCKET": TREND_DETAIL_COLUMNS,
            "TRENDMONTH": TREND_DETAIL_COLUMNS,
            "SKUHISTORY": SKU_HISTORY_DETAIL_COLUMNS,
            "LLHISTORY": LL_HISTORY_DETAIL_COLUMNS,
            "PRICEBUILD": PRICE_BUILD_DETAIL_COLUMNS,
            "RECO": RECO_DETAIL_COLUMNS,
            "MEGHRECO": MEGH_RECO_DETAIL_COLUMNS,
            "TRANSFER": TRANSFER_DETAIL_COLUMNS,
            "ORDERS": ORDER_DETAIL_COLUMNS,
            "MEGHORDERPLAN": ORDER_DETAIL_COLUMNS,
        },
        "overdue_analysis": overdue_rows,
        "qc": qc,
    }
    def json_safe(value):
        """Replace NaN/Inf with null anywhere in the payload.

        Frames routed through records() are already clean, but hand-built structures
        can carry NaN straight from pandas, and json.dumps would emit a bare NaN that
        no browser will parse.
        """
        if isinstance(value, dict):
            return {k: json_safe(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [json_safe(v) for v in value]
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            return None
        if value is not None and value is not True and value is not False:
            try:
                if pd.isna(value):
                    return None
            except (TypeError, ValueError):
                pass
        return value

    dashboard_data = json_safe(dashboard_data)
    (output_dir / "data.json").write_text(
        json.dumps(
            dashboard_data, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ),
        encoding="utf-8",
    )
    # Written once and then left alone: a refresh must not silently reset who can see
    # what. Refresh the tab list inside it so a new tab becomes grantable, but never
    # touch the grants themselves.
    access_path = output_dir / "access.json"
    access = json.loads(ACCESS_DEFAULTS_JSON) if not access_path.exists() else json.loads(
        access_path.read_text(encoding="utf-8")
    )
    access["admin"] = ADMIN_USER
    access.setdefault("salt", ACCESS_SALT)
    access.setdefault("accounts", ACCESS_DEFAULTS["accounts"])
    access["tabs"] = ACCESS_DEFAULTS["tabs"]
    access.setdefault("visible", {})
    access_path.write_text(json.dumps(access, indent=2) + "\n", encoding="utf-8")

    (output_dir / "qc_summary.json").write_text(
        json.dumps(qc, indent=2, default=str), encoding="utf-8"
    )
    (output_dir / "run_summary.json").write_text(
        json.dumps(
            {
                "status": status,
                "as_of": as_of,
                "refreshed_at_utc": refreshed_at,
                "warnings": warnings,
                "failures": failures,
                "outputs": ["index.html", "data.json", "access.json"],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    template = Path(__file__).resolve().parent.parent / "assets" / "dashboard_template.html"
    shutil.copyfile(template, output_dir / "index.html")
    print(json.dumps({"status": status, "warnings": warnings, "failures": failures}))
    return 1 if status == "FAIL" else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Build the TVSM customer and long-length dashboard."
    )
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--as-of")
    args = parser.parse_args()
    raise SystemExit(main(args.input_dir, args.output_dir, args.as_of))
