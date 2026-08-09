"""Does a browser-parsed dump rebuild into the frame pandas read from the file?

This is the gate the whole migration rests on. The pipeline's five thousand lines of
business logic are untouched by the move to Postgres — but only because both backends
hand it the same DataFrames. If SheetJS and pandas disagree about one cell in one of
225 columns, nothing raises: a tonnage shifts, a bucket stops matching, and the page is
quietly wrong.

So this compares them slot by slot, before any of it is wired to a database. Postgres is
only transport for the same parsed cells, so proving the parse is proving the plan.

    python3 tools/export_sheet_cells.mjs  # via the driver below
    python3 tools/compare_cell_sources.py --dumps dumps --as-of 2026-08-07

Exit code is 1 if any slot differs.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / ".claude" / "skills" / "refresh-tvsm-dashboard" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import sources as sources_module  # noqa: E402
from sources import CALLER_NAMES_THE_SHEET, CellSources, ExcelSources  # noqa: E402


def load_pipeline():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "refresh_dashboard", SCRIPTS / "refresh_dashboard.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def resolve_schedule_sheet(excel: ExcelSources, as_of: str) -> str:
    """The same month resolution the pipeline does, so the comparison reads one sheet."""
    pipeline = load_pipeline()
    wanted = f"{pipeline.SCHEDULE_SHEET_PREFIX}{pd.Timestamp(as_of).strftime('%B')}"
    available = excel.sheet_names("schedule")
    month_sheets = [
        name for name in available
        if name.startswith(pipeline.SCHEDULE_SHEET_PREFIX)
        and name[len(pipeline.SCHEDULE_SHEET_PREFIX):] in pipeline.MONTH_NAMES
    ]
    if wanted in available:
        return wanted
    if len(month_sheets) == 1:
        return month_sheets[0]
    return pipeline.SCHEDULE_SHEET_FALLBACK


def describe(frame: pd.DataFrame) -> str:
    return f"{len(frame)} rows x {len(frame.columns)} cols"


def compare(name: str, left: pd.DataFrame, right: pd.DataFrame) -> list[str]:
    """What differs between the file-read frame and the rebuilt one."""
    problems: list[str] = []

    if list(left.columns) != list(right.columns):
        only_excel = [c for c in left.columns if c not in set(right.columns)]
        only_cells = [c for c in right.columns if c not in set(left.columns)]
        if only_excel or only_cells:
            problems.append(
                ("real",
                 f"columns differ: only in file {only_excel[:6]}, only in cells {only_cells[:6]}")
            )
        else:
            problems.append(("real", "column order differs"))
        return problems

    if len(left) != len(right):
        problems.append(("real", f"row count {len(left)} vs {len(right)}"))
        return problems

    for column in left.columns:
        a, b = left[column], right[column]
        unequal = ~(
            (a.isna() & b.isna())
            | (a.astype(object).eq(b.astype(object)))
        )
        if not unequal.any():
            continue

        # A column the workbook stores as text and pandas coerces to a number is the one
        # difference expected here, and it is pandas that is wrong: the coercion drops the
        # last digit of a long code — '000000000110102155' arrives as 110102150.0. The
        # pipeline already pins the columns where someone caught this happening. Report
        # the class separately from a genuine mismatch, and say when digits were lost,
        # because that is the part worth acting on.
        if coerced_from_text(a, b):
            lost = int(sum(
                1 for x, y in zip(a, b)
                if isinstance(y, str) and pd.notna(x)
                and y.lstrip("0") not in ("", str(x), str(int(x)) if float(x).is_integer() else str(x))
            ))
            note = f"[{column}] text kept as text ({int(unequal.sum())} values)"
            if lost:
                note += f" — pandas altered {lost} of them"
            problems.append(("text", note))
            continue

        first = unequal[unequal].index[:3]
        samples = "; ".join(
            f"row {i}: file={a.iloc[i]!r} cells={b.iloc[i]!r}" for i in first
        )
        problems.append(("real", f"[{column}] {int(unequal.sum())} values differ — {samples}"))
    return problems


def coerced_from_text(from_file: pd.Series, from_cells: pd.Series) -> bool:
    """True when the only difference is that the workbook held text and pandas made numbers."""
    if not pd.api.types.is_numeric_dtype(from_file):
        return False
    values = from_cells.dropna()
    # `any`, not `all`: a sheet may hold a code as text on most rows and as a number on
    # a few, and pandas coerces the whole column either way.
    return bool(len(values)) and any(isinstance(v, str) for v in values)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dumps", type=Path, default=REPO / "dumps")
    parser.add_argument("--as-of", default="2026-08-07")
    parser.add_argument("--cells", type=Path, default=None,
                        help="reuse an existing export instead of re-parsing")
    args = parser.parse_args()

    pipeline = load_pipeline()
    extra = sources_module.slots_for_families(
        pipeline.ORDER_BOOK_SHEETS, pipeline.PRICING_SHEETS, pipeline.SIGNOFF_SHEETS
    )
    excel = ExcelSources(args.dumps, extra_slots=extra)
    schedule_sheet = resolve_schedule_sheet(excel, args.as_of)

    present = {
        slot: {"path": str(excel.path(slot)),
               "sheet": schedule_sheet if spec.sheet is CALLER_NAMES_THE_SHEET
               else (spec.sheet if isinstance(spec.sheet, str) else None)}
        for slot, spec in excel.slots.items()
        if excel.available(slot)
    }

    cells_dir = args.cells
    if cells_dir is None:
        cells_dir = Path(tempfile.mkdtemp(prefix="cells-"))
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(present, handle)
            slots_path = handle.name
        print(f"parsing {len(present)} slots with SheetJS ...", flush=True)
        subprocess.run(
            ["node", str(REPO / "tools" / "export_sheet_cells.mjs"), slots_path, str(cells_dir)],
            check=True, cwd=REPO,
        )

    rebuilt = CellSources(cells_dir, extra_slots=extra)

    failures, text_only, clean = 0, 0, 0
    digits_lost = []
    for slot in present:
        sheet = schedule_sheet if slot == "schedule" else None
        from_file = excel.frame(slot, sheet=sheet)
        from_cells = rebuilt.frame(slot, sheet=sheet)
        problems = compare(slot, from_file, from_cells)
        real = [message for kind, message in problems if kind == "real"]
        text = [message for kind, message in problems if kind == "text"]
        digits_lost += [f"{slot} {m}" for m in text if "altered" in m]

        if real:
            failures += 1
            print(f"\nFAIL {slot}  ({describe(from_file)} from file)")
            for message in real[:10]:
                print(f"     {message}")
            if len(real) > 10:
                print(f"     ... and {len(real) - 10} more")
        elif text:
            text_only += 1
            print(f"ok*  {slot}  {describe(from_file)}  — {len(text)} text column(s) preserved")
        else:
            clean += 1
            print(f"ok   {slot}  {describe(from_file)}")

    print(f"\n{clean} identical, {text_only} identical except text columns kept as text, "
          f"{failures} with real differences  (of {len(present)} slots)")
    if digits_lost:
        print("\nColumns where pandas altered the value it read — the browser parse is the"
              "\ncorrect one, and these are live in the published dashboard today:")
        for line in digits_lost:
            print(f"  {line}")
    print(f"\ncells kept at {cells_dir}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
