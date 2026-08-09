"""Parse each customer's August schedule into one common frame.

Every customer sends a different layout, so there is a reader per customer and a single
shape out: helper customer, dimensions, grade, pieces, MT and a material code where the
customer states one. Nothing is mapped to a bucket here — that happens against the
schedule sheet's own rows, which already carry the governed mapping.
"""
import re
import warnings
from pathlib import Path

import pandas as pd

warnings.filterwarnings("ignore")
EX = Path("aug/extracted")
rows = []


def add(customer, od, inner, thk, length, grade, nos, mt=None, code=None, note=None):
    nos = pd.to_numeric(nos, errors="coerce")
    if pd.isna(nos) or nos <= 0:
        return
    rows.append({
        "helper_customer": customer,
        "od": pd.to_numeric(od, errors="coerce"),
        "inner_d": pd.to_numeric(inner, errors="coerce"),
        "thickness": pd.to_numeric(thk, errors="coerce"),
        "length": pd.to_numeric(length, errors="coerce"),
        "grade": None if grade is None or pd.isna(grade) else str(grade).strip(),
        "nos": float(nos),
        "stated_mt": pd.to_numeric(mt, errors="coerce"),
        "material_code": None if code is None or pd.isna(code) else str(code).strip(),
        "source_note": note,
    })


# --- Rajsriya: six plant blocks stacked in one sheet, named in "Invoice To Be Raised".
# PLANT-1/2/4/5/8 are Hosur; the MYSORE block is the Mysore unit and has its own header.
d = pd.read_excel(EX / "rajsriya__TATA STEEL-2026.xlsx", sheet_name="Aug'26", header=None)
def split_face(cell):
    """Rajsriya writes a rectangular section into the OD cell as "40*30" or "19 X 19"."""
    text = str(cell).strip()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*[*xX]\s*(\d+(?:\.\d+)?)", text)
    return (m.group(1), m.group(2)) if m else (cell, None)


for _, r in d.iterrows():
    plant = str(r[15]).strip().upper()
    if plant in ("NAN", ""):
        continue
    customer = ("Rajsriya Automotive Mysore" if plant == "MYSORE"
                else "Rajsriya Automotive Hosur")
    face, second = split_face(r[1])
    add(customer, face, second if second is not None else r[2], r[3], r[4], r[5],
        r[8], r[7], note=f"rajsriya {plant}")

# --- NMPL: two plants, two files, one Helper Customer. Both state a SAP part number,
# which is the strongest key available anywhere in this pack.
# NMPL's "PART NO" is NMPL's own number (3105706, 3100955…), not the Tata material
# code the schedule sheet holds (2363145, 1931824…) — the two ranges never meet. Its
# sizes are in the description instead, so they are read from there. Deferred: the
# reader is defined further down with the other description parsing.
NMPL_FILES = [("nmpl 1__TATA STEEL PLANT I - AUGUST.2026.xlsx", 6, 2, 9, 10),
              ("nmpl hub__TATA TUBES AUG - 2026 - C.xlsx", 8, 2, 10, 11)]

# --- Sandhar Hosur: dimensions and a single August requirement column.
d = pd.read_excel(EX / "sandhar hosur__TATA STEEL AUG - 2026.xlsx",
                  sheet_name="TATA STEEL", header=None)
for _, r in d.iloc[2:].iterrows():
    add("SANDHAR Hosur", r[3], None, r[5], r[6], r[2], r[7], note="sandhar hosur")

# --- Srikam: full dimensions. Its "Tonnage" column is kilograms, not tonnes —
# 30000 pieces at 0.096 kg reads 2,880.63, so it is divided rather than trusted as MT.
d = pd.read_excel(EX / "srikam hitech__TATA STEEL LIMITED.xls",
                  sheet_name="Sheet1", header=None)
for _, r in d.iloc[7:].iterrows():
    kg = pd.to_numeric(r[9], errors="coerce")
    add("Srikam HI-Tech", r[1], r[2], r[3], r[4], r[6], r[8],
        None if pd.isna(kg) else kg / 1000, note="srikam")

# --- Narasipur: a PDF whose text layer reads cleanly. Sizes are written into the
# description, so they are pulled out of it rather than from columns.
from pypdf import PdfReader  # noqa: E402

text = PdfReader(str(EX / "narsipur__TATA Steel Schedule-Aug-2026.pdf")).pages[0].extract_text()
# One size wraps onto a second line ("…/N118 Jupiter" then "CEW-1 30,000 No …"), so the
# lines are rejoined before matching. Quantities are only ever taken as comma-grouped
# numbers: the part codes in brackets are bare digits, and reading "(N112)" as 112 pieces
# is exactly the mistake to avoid.
narsipur_total = 0
joined = re.sub(r"\n(?=\s*(?:CEW|ERW)\b)", " ", text)
for line in joined.splitlines():
    m = re.search(r"Dia\.?\s*(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*[xX]\s*"
                  r"(\d+(?:\.\d+)?)\s*mm", line)
    if not m:
        continue
    tail = line[m.end():]
    qty = re.findall(r"\b(\d{1,3}(?:,\d{3})+)\b", tail)
    if not qty:
        continue
    pieces = int(qty[0].replace(",", ""))
    narsipur_total += pieces
    add("Narasipur Auto Component(P)Ltd", m.group(1), None, m.group(2), m.group(3),
        None, pieces, note="narsipur pdf")
stated = re.search(r"Total\s+([\d,]+)", joined)
if stated:
    want = int(stated.group(1).replace(",", ""))
    assert narsipur_total == want, f"narsipur {narsipur_total:,} vs stated {want:,}"
    print(f"narsipur reconciles to its own total: {narsipur_total:,} pieces\n")


# --- Sandhar Mysore and Sandhar Technology sent no attachment: the schedule is a table
# in the mail body. Their sizes live inside the part description, written six different
# ways between them, so the size reader is shared and every line it cannot read is
# reported rather than dropped.
import olefile  # noqa: E402

NUM = r"(\d+(?:\.\d+)?)"
unreadable = []


def read_size(text):
    """(dim1, dim2, thickness, length) from a part description, or None."""
    t = str(text).replace("\xa0", " ")
    # Rectangular sections state both faces in brackets: "(40 X 25) X T 1.63 X L 561".
    m = re.search(rf"\(\s*{NUM}\s*[xX]\s*{NUM}\s*\)\s*[xX]\s*T\s*{NUM}\s*[xX]\s*L\s*{NUM}", t)
    if m:
        return float(m[1]), float(m[2]), float(m[3]), float(m[4])
    # Round tube, thickness marked by T or THK.
    m = re.search(rf"OD\s*{NUM}\s*[xX]\s*(?:T|THK)\s*{NUM}\s*[xX]\s*L\s*{NUM}", t)
    if m:
        return float(m[1]), 0.0, float(m[2]), float(m[3])
    # Square and rectangular hollows, written H x W or W x B: "SQ H 50 X W 50 X T 1.6
    # X L847", "RECT ERW1 W50 X B30 X T2 X L730".
    m = re.search(rf"[HWB]\s*{NUM}\s*[xX]\s*[WB]\s*{NUM}\s*[xX]\s*T\s*{NUM}"
                  rf"\s*[xX]\s*L\s*{NUM}", t)
    if m:
        return float(m[1]), float(m[2]), float(m[3]), float(m[4])
    # Thickness marked but the length left unlabelled: "OD 42.7 x T 3.5 x 210 MM".
    m = re.search(rf"OD\s*{NUM}\s*[xX]\s*(?:T|THK)\s*{NUM}\s*[xX]\s*{NUM}", t)
    if m:
        return float(m[1]), 0.0, float(m[2]), float(m[3])
    # "TUBE OD 25.4 x2 x 418", "22.23x2.0x865MM", "(22.23 X 2.00 X 905 MM)".
    m = re.search(rf"{NUM}\s*[xX]\s*{NUM}\s*[xX]\s*{NUM}", t)
    if m:
        return float(m[1]), 0.0, float(m[2]), float(m[3])
    return None


def msg_body(name):
    ole = olefile.OleFileIO(f"aug/sched/schedules/{name}.msg")
    for tag in ("1000001F", "1000001E"):
        path = f"__substg1.0_{tag}"
        if ole.exists(path):
            raw = ole.openstream(path).read()
            try:
                out = raw.decode("utf-16-le")
            except Exception:
                out = raw.decode("latin-1", "replace")
            ole.close()
            return out
    ole.close()
    return ""


# NMPL, now that a size can be read from a description. "R/L" is random length —
# the mill's own long length, which the schedule sheet carries as 6000 mm.
for filename, first_row, desc_col, nos_col, mt_col in NMPL_FILES:
    d = pd.read_excel(EX / filename, sheet_name="Sheet1", header=None)
    for _, r in d.iloc[first_row:].iterrows():
        if pd.isna(r[1]):        # each sheet ends with an unlabelled grand total
            continue
        description = str(r[desc_col])
        size = read_size(description)
        if size is None:
            m = re.search(rf"OD\s*{NUM}\s*[xX]\s*T\s*{NUM}\s*[xX]\s*R\s*/\s*L", description)
            size = (float(m[1]), 0.0, float(m[2]), 6000.0) if m else None
        if size is None:
            unreadable.append(("NMPL", r[1], description))
            continue
        dim1, dim2, thk, length = size
        add("NMPL", dim1, dim2 or None, thk, length, None, r[nos_col], r[mt_col],
            note=filename.split("__")[0])

for msg_name, customer, qty_col in (("sandhar auto", "Sandhar Technology", 8),
                                    ("sandhar mysore", "SANDHAR Mysore", 7)):
    total = 0
    for line in msg_body(msg_name).splitlines():
        cells = [c.strip() for c in line.split("\t")]
        if len(cells) <= qty_col or not re.fullmatch(r"\d+", cells[0] or ""):
            continue
        qty = pd.to_numeric(cells[qty_col].replace(",", ""), errors="coerce")
        if pd.isna(qty) or qty <= 0:
            continue
        size = read_size(cells[2])
        if size is None:
            unreadable.append((customer, cells[1], cells[2]))
            continue
        dim1, dim2, thk, length = size
        total += qty
        add(customer, dim1, dim2 or None, thk, length, None, qty,
            code=cells[1], note=f"{msg_name} body")
    print(f"{customer}: {total:,.0f} pieces read from the mail body")
if unreadable:
    print("\nsizes that could not be read from a description:")
    for c, code, desc in unreadable:
        print(f"   {c} | {code} | {desc}")

frame = pd.DataFrame(rows)
frame.to_csv("aug/parsed_schedules.csv", index=False)
print(f"parsed {len(frame)} lines\n")
print(frame.groupby("helper_customer").agg(
    lines=("nos", "size"), nos=("nos", "sum"), stated_mt=("stated_mt", "sum")).to_string())
