"""Fold a material-master extract into zmat.xlsx.

ZMAT is the single material master. When an extract arrives covering descriptions the
standing dump does not carry, its rows are merged in here and the extract is discarded —
rather than kept beside zmat as a second source that has to be read, filtered and
reasoned about on every run.

Only descriptions zmat lacks are appended. Filtering on the material code instead looks
equivalent and is not: an extract lists several codes per description, so a description
zmat already resolves would gain a second code, the description-to-code lookup would see
the ambiguity and return nothing, and every line that resolved through that description
would lose its code.

    python3 scripts/merge_material_mapping.py \
        --zmat dumps/zmat.xlsx --mapping /path/to/material_mapping.xlsx

Both `--zmat` targets must be updated together — `dumps/zmat.xlsx` and
`assets/masters/zmat.xlsx` are byte-identical by test — and
`config/master_manifest.json` needs the new checksum, which the script prints.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

import pandas as pd

DESCRIPTION = "MATERIAL DESCRIPTION"
# The extract names the material number outright; zmat holds it in `Column1`.
CODE_IN_MAPPING = "MATERIAL NUMBER"
CODE_IN_ZMAT = "Column1"


def normalise_description(value):
    if pd.isna(value):
        return None
    return re.sub(r"\s+", " ", str(value).strip().upper())


def align_columns(mapping: pd.DataFrame, zmat: pd.DataFrame) -> pd.DataFrame:
    """Give the extract zmat's columns, matching on name and never on position.

    The two files hold the same 24 columns in a *different order*, and disagree on two
    names: pandas disambiguates a repeated header as `WEIGHT/METRE OF MATERIAL.1` where
    zmat writes `WEIGHT/METRE OF MATERIAL2`. Renaming by position looks like it handles
    that and instead silently transposes the file — descriptions into the code column,
    plants into the material type. So rename only what genuinely differs, then reorder,
    and refuse to guess if anything is still unmatched.
    """
    mapping = mapping.rename(columns={
        CODE_IN_MAPPING: CODE_IN_ZMAT,
        "WEIGHT/METRE OF MATERIAL.1": "WEIGHT/METRE OF MATERIAL2",
        "WEIGHT/NUMBER OF MATERIAL.1": "WEIGHT/NUMBER OF MATERIAL2",
    })
    unmatched = [c for c in zmat.columns if c not in mapping.columns]
    surplus = [c for c in mapping.columns if c not in zmat.columns]
    if unmatched or surplus:
        raise SystemExit(
            "cannot align the extract to zmat by column name.\n"
            f"  missing from the extract: {unmatched}\n"
            f"  present only in the extract: {surplus}\n"
            "Add the rename to align_columns rather than matching by position — the "
            "two files order their columns differently, so position is not a fallback."
        )
    # Reorder to zmat's own column order. Concatenation aligns on name, so this is
    # cosmetic for the merge itself and load-bearing for anyone opening the file.
    return mapping[list(zmat.columns)]


def main(zmat_path: Path, mapping_path: Path, dry_run: bool) -> int:
    zmat = pd.read_excel(zmat_path, sheet_name="Sheet1", dtype={CODE_IN_ZMAT: str})
    mapping = pd.read_excel(mapping_path, dtype={CODE_IN_MAPPING: str})
    mapping = align_columns(mapping, zmat)

    known = set(zmat[DESCRIPTION].map(normalise_description).dropna())
    fresh = mapping[~mapping[DESCRIPTION].map(normalise_description).isin(known)]
    print(f"\nzmat: {len(zmat):,} rows")
    print(f"extract: {len(mapping):,} rows, "
          f"{mapping[DESCRIPTION].map(normalise_description).nunique()} descriptions")
    print(f"new to zmat: {len(fresh):,} rows, "
          f"{fresh[DESCRIPTION].map(normalise_description).nunique()} descriptions")
    if fresh.empty:
        print("\nNothing to add — every description is already in zmat.")
        return 0
    for description, group in fresh.groupby(DESCRIPTION):
        codes = sorted({str(c) for c in group[CODE_IN_ZMAT].dropna()})
        print(f"  {description}  codes={', '.join(codes)}  plants={len(group)}")
    if dry_run:
        print("\nDry run — zmat not written.")
        return 0

    merged = pd.concat([zmat, fresh], ignore_index=True)
    merged.to_excel(zmat_path, sheet_name="Sheet1", index=False)
    digest = hashlib.sha256(zmat_path.read_bytes()).hexdigest()
    print(f"\nWrote {zmat_path} — {len(merged):,} rows, {zmat_path.stat().st_size:,} bytes")
    print(f"sha256 {digest}")
    print("Put that checksum in config/master_manifest.json and copy the same file to "
          "every other zmat.xlsx in the repository.")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zmat", type=Path, required=True)
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    sys.exit(main(args.zmat, args.mapping, args.dry_run))
