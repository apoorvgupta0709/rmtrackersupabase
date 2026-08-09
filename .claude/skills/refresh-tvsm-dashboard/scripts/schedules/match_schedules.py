"""Match each parsed August line to its row in the schedule sheet.

The sheet already holds every one of these customers' sizes with the governed bucket,
the CTL bucket and the material code from July — only the quantity is blank. So the job
is to find the right row and write the quantity into it, never to re-derive a mapping.

Matching is on the sheet's own `OD`/`ID` columns, not `ACTUAL OD`: for a rectangular
section the bucket and the OD/ID cells carry the faces as written (40 x 25) while
`ACTUAL OD` holds the equivalent round diameter (41.28), so matching on it silently
fails for every rectangular line.
"""
import importlib.util
import warnings
from pathlib import Path

import pandas as pd

warnings.filterwarnings("ignore")

# Match on the dimensions the pipeline governs, not the ones the customer typed. The
# schedule sheet holds the governed value — Srikam writes 1.22 thickness where the sheet
# holds 1.2, and 22.2 and 22.23 are the same OD — so raw comparison misses whole
# customers. Reuse the pipeline's own normalisers rather than restating the groupings.
SPEC = importlib.util.spec_from_file_location(
    "refresh", "/home/user/rmtrackerchatgpt/.claude/skills/refresh-tvsm-dashboard/"
    "scripts/refresh_dashboard.py")
refresh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(refresh)

MASTER = "aug/raw/aug0826 rm tracker v1.xlsx"
sheet = pd.read_excel(MASTER, sheet_name="Schedule July", header=2).iloc[:742].copy()
sheet["_row"] = range(len(sheet))
parsed = pd.read_csv("aug/parsed_schedules.csv")


def num(value, digits=2):
    value = pd.to_numeric(value, errors="coerce")
    return None if pd.isna(value) else round(float(value), digits)


def dim_key(od, inner, thk, length):
    od, thk, length = num(od), num(thk), num(length, 0)
    if od is None or thk is None or length is None:
        return None
    return (refresh.norm_od(od), refresh.norm_od(num(inner) or 0.0),
            refresh.norm_thickness(thk), length)


def code_key(value):
    text = str(value).strip()
    # Only SAP codes join; the Sandhar files quote their own part numbers
    # (RMSTLPURE00121, COTUBS02400), which the sheet has never heard of.
    # Codes arrive as ints, floats and strings across the three sources.
    if text.endswith(".0"):
        text = text[:-2]
    return text if text.isdigit() else None


by_dim, by_code, by_face = {}, {}, {}
for _, r in sheet.iterrows():
    customer = str(r["Helper Customer"]).strip()
    key = dim_key(r["OD"], r["ID"], r["TICKNESS"], r["LENGTH"])
    if key:
        by_dim.setdefault((customer, key), []).append(r["_row"])
        # Bore-agnostic index. Narasipur and the Sandhar plants state only OD, wall and
        # length while their rows are bored CEW tubes carrying an ID (25.4-18.4-3.5),
        # so an exact key never meets. Used only where it lands on one row.
        by_face.setdefault((customer, (key[0], key[2], key[3])), []).append(r["_row"])
    code = code_key(r["MATERIAL NO"])
    if code:
        by_code.setdefault((customer, code), []).append(r["_row"])

matched, unmatched = [], []
for _, line in parsed.iterrows():
    customer = line["helper_customer"]
    row = None
    how = None
    code = code_key(line["material_code"]) if pd.notna(line["material_code"]) else None
    if code and (customer, code) in by_code:
        row, how = by_code[(customer, code)][0], "material code"
    else:
        key = dim_key(line["od"], line["inner_d"], line["thickness"], line["length"])
        if key and (customer, key) in by_dim:
            row, how = by_dim[(customer, key)][0], "OD/ID/thickness/length"
        elif key and pd.isna(line["inner_d"]):
            # No bore stated. Accept only a single candidate; two rows differing only by
            # bore are two different tubes and picking one would be a guess.
            hits = by_face.get((customer, (key[0], key[2], key[3])), [])
            if len(hits) == 1:
                row, how = hits[0], "OD/thickness/length, bore not stated"
            elif len(hits) > 1:
                how = f"ambiguous — {len(hits)} rows differ only by bore"
    (matched if row is not None else unmatched).append(
        {**line.to_dict(), "_row": row, "matched_by": how}
    )

matched = pd.DataFrame(matched)
unmatched = pd.DataFrame(unmatched)
matched.to_csv("aug/matched.csv", index=False)
unmatched.to_csv("aug/unmatched.csv", index=False)

print(f"{len(matched)} of {len(parsed)} lines matched a row in the sheet\n")
report = parsed.groupby("helper_customer").agg(lines=("nos", "size"), nos=("nos", "sum"))
report["matched"] = matched.groupby("helper_customer").size() if len(matched) else 0
report["matched_nos"] = matched.groupby("helper_customer")["nos"].sum() if len(matched) else 0
report = report.fillna(0)
report["nos_%"] = (report["matched_nos"] / report["nos"] * 100).round(1)
print(report.to_string())

if len(unmatched):
    print(f"\n{len(unmatched)} lines reached no row "
          f"({unmatched['nos'].sum():,.0f} pieces):")
    cols = ["helper_customer", "od", "inner_d", "thickness", "length",
            "grade", "nos", "material_code"]
    print(unmatched[cols].to_string(index=False))
