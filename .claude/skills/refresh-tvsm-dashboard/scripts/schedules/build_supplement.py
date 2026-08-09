"""Build the August schedule supplement for the ten customers the master left blank.

The master's `Schedule July` sheet holds every one of these customers' sizes with the
governed bucket and material code, but with no August quantity. Rather than rewrite that
workbook — round-tripping 58 sheets through openpyxl drops the cached formula values the
pipeline reads elsewhere — the August lines are emitted as their own file with the same
columns. The master's own rows stay at zero and are filtered out by the pipeline's
`schedule_qty > 0` test, so nothing is double counted.

Tonnage is not inherited from July: it is the customer's own stated MT where given, else
Bucketting's kilograms per piece, which is the only figure that is right for rectangular
sections. Where neither exists the cell is left empty and the pipeline's own formula
applies.
"""
import importlib.util
import warnings

import pandas as pd

warnings.filterwarnings("ignore")

SPEC = importlib.util.spec_from_file_location(
    "refresh", "/home/user/rmtrackerchatgpt/.claude/skills/refresh-tvsm-dashboard/"
    "scripts/refresh_dashboard.py")
refresh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(refresh)

MASTER = "aug/raw/aug0826 rm tracker v1.xlsx"
sheet = pd.read_excel(MASTER, sheet_name="Schedule July", header=2).iloc[:742].copy()
bucketting = pd.read_excel(MASTER, sheet_name="Bucketting", header=1, usecols="U:AF")
matched = pd.read_csv("aug/matched.csv")
unmatched = pd.read_csv("aug/unmatched.csv")


def dims(od, inner, thk):
    return (refresh.norm_od(od),
            refresh.norm_od(0 if pd.isna(inner) else inner),
            refresh.norm_thickness(thk))


# Bucketting indexed by governed dimensions, for the sizes that are new this month.
bucketting["_k"] = [dims(o, i, t) for o, i, t
                    in zip(bucketting["OD"], bucketting["ID"], bucketting["Thickness"])]
# Only the candidate buckets are taken from here. `kG/nos` is deliberately not used:
# the column carries two different things. On a cut-length row it is kilograms per
# piece, on a 5.6 m or 6 m row it is kilograms per metre — 25.4 x 3.5 reads 1.889346 for
# both a 0.247 m piece's 0.4667 kg and the 5.6 m row, because the latter is the per-metre
# figure. Reading it as one thing gave a 935 mm piece a 283 mm piece's weight, and
# reading it as the other dragged Narasipur 25 MT light. The pipeline's own formula
# agrees with the trustworthy rows to 0.05% and is what every other tonnage on the
# dashboard already uses, so tonnage the sheet does not state is left to it.
by_dims = {}
for key, group in bucketting.groupby("_k"):
    by_dims[key] = sorted({b for b in group["Bucket"].dropna()})

# Identity columns come from any row the customer already has, so a new size inherits
# the customer's code and name rather than having them retyped.
identity = {}
for customer, group in sheet.groupby(sheet["Helper Customer"].astype(str)):
    first = group.iloc[0]
    identity[customer] = {c: first[c] for c in
                          ("CUSTOMER NAME", "Helper Customer", "CUSTOMER CODE", "Plant")}

out, unresolved = [], []


def size_text(od, inner, thk, length, grade, note):
    """The size written out, for a row that has to be shown on a queue."""
    face = f"{float(od):g}" if pd.isna(inner) or float(inner) == 0 else \
        f"{float(od):g} x {float(inner):g}"
    text = f"{face} x {float(thk):g} x {float(length):g} mm"
    if pd.notna(grade) and str(grade).strip():
        text += f" {str(grade).strip()}"
    return f"{text} — {note}"


def tonnage(stated):
    """The customer's own tonnage where they state one, and nothing invented where not.

    A blank leaves the pipeline's governed formula to compute it, the same way every
    other schedule row on the dashboard is computed. See the note on `kG/nos` above for
    why Bucketting is not consulted.
    """
    if pd.notna(stated) and float(stated) > 0:
        return round(float(stated), 6)
    return None


for _, line in matched.iterrows():
    row = sheet.iloc[int(line["_row"])].to_dict()
    # Weigh the size the sheet says this is, not the one the customer typed. Sandhar
    # writes "40" for a 40 x 25 rectangular section, so keying the weight lookup off the
    # customer's own cells misses Bucketting and falls through to the round-tube
    # formula, which is about 2.4% light on a rectangle.
    row["SCHEDULE in nos"] = float(line["nos"])
    row["SCHEDULE IN MT"] = tonnage(line["stated_mt"])
    row["Customer remarks"] = f"Aug 2026 schedule · {line['source_note']}"
    # A matched row can still reach no bucket — the sheet itself is 95.5% bucketed. Those
    # land on the Missing mappings queue, and some carry no description either, which
    # showed there as a row saying only "lookup error". Write the size out so the queue
    # names what needs governing.
    if pd.isna(row.get("Bucket")) and (
            pd.isna(row.get("MATERIAL DES")) or not str(row.get("MATERIAL DES")).strip()):
        row["MATERIAL DES"] = size_text(
            row["OD"], row["ID"], row["TICKNESS"], row["LENGTH"],
            row.get("Grade"), line["source_note"])
    for blank in ("DISPATCH", "BAL IN NOS", "DISPATCH MT", "BALANCE FOR DISP", "% COMP"):
        if blank in row:
            row[blank] = None
    out.append(row)

for _, line in unmatched.iterrows():
    customer = line["helper_customer"]
    key = dims(line["od"], line["inner_d"], line["thickness"])
    buckets = by_dims.get(key, [])
    row = {c: None for c in sheet.columns}
    row.update(identity.get(customer, {"Helper Customer": customer}))
    row["Helper Customer"] = customer
    row["ACTUAL OD"] = row["OD"] = line["od"]
    row["ID"] = 0 if pd.isna(line["inner_d"]) else line["inner_d"]
    row["TICKNESS"] = line["thickness"]
    row["LENGTH"] = line["length"]
    row["Grade"] = line["grade"]
    row["UoM"] = "NOS"
    # A size with no bucket lands on the Missing mappings tab, where the owner decides
    # what to do with it. Without a description that queue reads as a blank row, so the
    # size is written out in the form the customer sent it.
    row["MATERIAL DES"] = size_text(line["od"], line["inner_d"], line["thickness"],
                                    line["length"], line["grade"], line["source_note"])
    row["SCHEDULE in nos"] = float(line["nos"])
    row["SCHEDULE IN MT"] = tonnage(line["stated_mt"])
    row["Customer remarks"] = f"Aug 2026 schedule · new size · {line['source_note']}"
    if len(buckets) == 1:
        row["Bucket"] = buckets[0]
        row["CTL Bucket"] = refresh.make_ctl_bucket(buckets[0], line["length"] / 1000)
    else:
        # Two or more candidate buckets, or none at all. Left unmapped on purpose: the
        # dashboard reports it on the Missing mappings tab, which is where the owner
        # already works this queue. Guessing would silently pool demand on a wrong size.
        unresolved.append({**line.to_dict(), "candidates": len(buckets)})
    out.append(row)

# Knitvel and `ara` sent no August schedule at all. The owner's instruction is to carry
# July forward rather than show them as zero demand, so their July lines are repeated
# verbatim and labelled as carried over — a placeholder that says it is one.
# Read from a snapshot, not from the previous master: that file is replaced in place
# every month, so by the time this runs the "previous" month is already gone from it.
# dumps/schedule_carry_forward.csv holds exactly the rows being carried and nothing else.
carry = pd.read_csv("aug/carry_forward.csv")
for customer in ("Knitvel", "ara"):
    carried = carry[carry["Helper Customer"].astype(str).eq(customer)]
    for _, row in carried.iterrows():
        row = row.to_dict()
        row["Customer remarks"] = "Carried over from July — no August schedule received"
        for blank in ("DISPATCH", "BAL IN NOS", "DISPATCH MT", "BALANCE FOR DISP", "% COMP"):
            if blank in row:
                row[blank] = None
        out.append(row)
    print(f"{customer}: {len(carried)} July lines carried forward")

supplement = pd.DataFrame(out)[list(sheet.columns)]
supplement.to_excel("aug/schedule_supplement.xlsx", index=False)
pd.DataFrame(unresolved).to_csv("aug/unresolved.csv", index=False)

mapped = supplement["Bucket"].notna()
print(f"supplement rows: {len(supplement)}")
print(f"   with a governed bucket : {int(mapped.sum())}")
print(f"   left unmapped          : {int((~mapped).sum())} "
      f"({len(unresolved)} of them new sizes)")
print(f"   tonnage stated         : {supplement['SCHEDULE IN MT'].notna().sum()} rows")
print()
report = supplement.groupby("Helper Customer").agg(
    rows=("SCHEDULE in nos", "size"),
    nos=("SCHEDULE in nos", "sum"),
    mt=("SCHEDULE IN MT", "sum"),
    unmapped=("Bucket", lambda x: int(x.isna().sum())))
print(report.to_string())
print(f"\nTOTAL {report['nos'].sum():,.0f} pieces, {report['mt'].sum():,.3f} MT")
