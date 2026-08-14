"""Read every slot twice — off the cell grid and off its table — and compare the frames.

The refresh used to read the raw grid the uploader stored, cell for cell, and rebuild each
frame in Python. It now reads the dump tables instead. That is only safe if the two agree,
and "agree" has to mean something stricter than "looks about right": the pipeline addresses
its columns by the file's own header, sums them, joins on them and divides by them, so a
column that arrives as text where it used to be a float does not raise — it publishes a
different number.

So this compares them properly: column names in order, dtypes, shape, and every cell.

    python3 tools/compare_table_sources.py            # every slot
    python3 tools/compare_table_sources.py stock wip  # named slots only

The two backends are *not* expected to hold the same rows for an accumulating slot, and
that is the entire point of the change: `tsl_transfers` holds every line back to 8 July
where the current upload holds the month in progress. So for those, the table's rows are
matched to the grid's on the table's own key and compared there, and the extra rows are
reported as the gain rather than as a difference.

Exit code is 1 if anything differs, so this can gate a refresh.
"""

from __future__ import annotations

import sys
import warnings
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = REPO_ROOT / ".claude" / "skills" / "refresh-tvsm-dashboard" / "scripts"
sys.path.insert(0, str(SCRIPTS))

warnings.filterwarnings("ignore")

import pandas as pd  # noqa: E402

import sources as sources_module  # noqa: E402
from supabase_rest import SupabaseRest  # noqa: E402


def every_slot() -> dict:
    """Every declared read, the three multi-sheet families expanded."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "refresh_dashboard", SCRIPTS / "refresh_dashboard.py"
    )
    pipeline = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pipeline)
    slots = dict(sources_module.SLOTS)
    slots.update(sources_module.slots_for_families(
        pipeline.ORDER_BOOK_SHEETS, pipeline.PRICING_SHEETS, pipeline.SIGNOFF_SHEETS,
    ))
    return slots


def cells_differ(left, right) -> bool:
    """Is this one cell different, treating every flavour of missing as the same thing?

    `None`, `NaN` and `NaT` all mean the cell was empty, and which one a frame holds is
    decided by its dtype rather than by the file. Comparing them naively reports every
    blank cell in the sheet as a difference and buries the real ones.

    Floats are compared to a tolerance, because a number that has been through JSON and
    back can land a bit off the double the reader produced — and a difference at the
    fifteenth digit is not what this is looking for.
    """
    left_missing = left is None or (isinstance(left, float) and pd.isna(left)) or left is pd.NaT
    right_missing = right is None or (isinstance(right, float) and pd.isna(right)) or right is pd.NaT
    try:
        left_missing = left_missing or pd.isna(left)
        right_missing = right_missing or pd.isna(right)
    except (TypeError, ValueError):
        pass
    if left_missing or right_missing:
        return bool(left_missing) != bool(right_missing)
    if isinstance(left, float) and isinstance(right, float):
        return abs(left - right) > 1e-9 * max(1.0, abs(left), abs(right))
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return abs(float(left) - float(right)) > 1e-9 * max(1.0, abs(left), abs(right))
    return left != right


def compare_frames(grid: pd.DataFrame, table: pd.DataFrame, *, limit: int = 5) -> list[str]:
    """Every way these two frames differ, most structural first."""
    faults: list[str] = []

    grid_columns, table_columns = list(grid.columns), list(table.columns)
    if grid_columns != table_columns:
        only_grid = [c for c in grid_columns if c not in table_columns]
        only_table = [c for c in table_columns if c not in grid_columns]
        if only_grid or only_table:
            faults.append(f"columns differ: only on the grid {only_grid!r}, "
                          f"only on the table {only_table!r}")
        else:
            faults.append("columns are the same set in a different order: "
                          f"grid {grid_columns[:6]!r}… table {table_columns[:6]!r}…")
        return faults

    if len(grid) != len(table):
        faults.append(f"{len(grid)} rows off the grid, {len(table)} off the table")

    for column in grid_columns:
        if str(grid[column].dtype) != str(table[column].dtype):
            faults.append(f"{column!r}: dtype {grid[column].dtype} off the grid, "
                          f"{table[column].dtype} off the table")

    shared = min(len(grid), len(table))
    for column in grid_columns:
        left, right = grid[column].to_list()[:shared], table[column].to_list()[:shared]
        wrong = [i for i in range(shared) if cells_differ(left[i], right[i])]
        if wrong:
            shown = ", ".join(
                f"row {i}: {left[i]!r} vs {right[i]!r}" for i in wrong[:limit]
            )
            faults.append(f"{column!r}: {len(wrong)} of {shared} cells differ — {shown}")
    return faults


def keyed(frame: pd.DataFrame, spec) -> pd.DataFrame | None:
    """A frame indexed by the key its table is keyed on, for matching row to row."""
    if not spec.key or spec.key_from is None:
        return None
    keyed_frame = spec.key_from(frame.copy())
    if keyed_frame.empty:
        return None
    return keyed_frame.set_index(list(spec.key))


def compare_slot(slot: str, grid_source, table_source) -> tuple[list[str], str]:
    """One slot, both ways. Returns the faults and a one-line note about what was read."""
    spec = sources_module.table_for(slot)
    on_grid = grid_source.available(slot)
    on_table = table_source.available(slot)
    if not on_grid and not on_table:
        return [], "not uploaded"
    if on_grid != on_table:
        return ([f"available on the grid: {on_grid}; on the table: {on_table}"], "")

    sheet = None
    if grid_source.spec(slot).sheet is sources_module.CALLER_NAMES_THE_SHEET:
        sheets = grid_source.sheet_names(slot)
        if not sheets:
            return [], "no sheet uploaded"
        sheet = sheets[0]

    grid = grid_source.frame(slot, sheet=sheet)
    table = table_source.frame(slot, sheet=sheet)

    if spec.mode == "snapshot":
        return compare_frames(grid, table), f"{len(grid)} rows, exact"

    # An accumulating table holds more than the current upload, which is the gain rather
    # than a fault. Compare the rows they share, on the table's own key, and say how many
    # the table adds.
    grid_keyed, table_keyed = keyed(grid, spec), keyed(table, spec)
    if grid_keyed is None or table_keyed is None:
        return compare_frames(grid, table), f"{len(grid)} rows, unkeyed"

    if "row_digest" in spec.key and len(grid_keyed) == len(table):
        # zmat, and only zmat. Its key's third part is a digest of the row's own content,
        # which is computed from the *stored* form of every cell — so it is stable for the
        # table, which always digests the frame it absorbed, and not reproducible from the
        # frame read back, where a column that was mixed int and float on the sheet comes
        # back float throughout and digests differently. Matching on it would call 23,772
        # rows missing that are all present.
        #
        # Nothing is lost by comparing positionally instead: `zmat_keys` deduplicates in
        # frame order and the table is read back in `source_seq` order, so equal lengths
        # mean the two are already row for row.
        left = grid_keyed.reset_index(drop=True)[list(grid.columns)]
        return (compare_frames(left, table[list(grid.columns)]),
                f"{len(grid)} rows in the upload, {len(table)} in the table, "
                f"row for row in sheet order")

    shared = grid_keyed.index.intersection(table_keyed.index)
    missing = grid_keyed.index.difference(table_keyed.index)
    faults = []
    if len(missing):
        faults.append(
            f"{len(missing)} row(s) in the current upload are NOT in the table — "
            f"absorption has not caught up, e.g. {list(missing[:3])}"
        )
    left = grid_keyed.loc[shared].sort_index().reset_index()
    right = table_keyed.loc[shared].sort_index().reset_index()
    # The key columns the comparison added are not part of either read.
    left = left[[c for c in grid.columns]]
    right = right[[c for c in grid.columns]]
    faults += compare_frames(left, right)
    return faults, (f"{len(grid)} rows in the upload, {len(table)} in the table "
                    f"(+{len(table) - len(shared)}), {len(shared)} compared")


def drift(grid_source) -> int:
    """Which view columns are typed numeric while the live upload holds padded text.

    The one failure a view has that no read can undo. A column is typed here from a file
    in `dumps/`, once; `dumps/yf65.xlsx` writes the accounting document number as a
    number, so the view was written `dump_numeric` — and the uploaded `yf65.XLSX` writes
    the same column as `0071029066`. The padding is gone in SQL. It reached the page as
    `DP 36388067` against a true `DP 0036388067`, in a document people paste into a mail.

    Nothing about that is loud. The view keeps working, the column keeps a plausible
    value, and the only way to see it is to ask this question of every column of every
    slot, which is what this does. Anything it names belongs in
    `generate_dump_views.TEXT_COLUMNS`.
    """
    found = 0
    for slot, entry in sorted(sources_module.dump_columns().items()):
        if entry["storage"] != "view":
            continue
        try:
            sheet = None
            if grid_source.spec(slot).sheet is sources_module.CALLER_NAMES_THE_SHEET:
                names = grid_source.sheet_names(slot)
                sheet = names[0] if names else None
            frame = (grid_source.frame(slot, sheet=sheet) if sheet
                     else grid_source.frame(slot))
        except Exception as error:                        # noqa: BLE001
            print(f"  {slot}: {type(error).__name__}: {error}")
            continue
        for column in entry["columns"]:
            if column.get("kind") != "numeric" or column["header"] not in frame.columns:
                continue
            if column.get("sql_kind") == "text":
                # A plant or a material number. `kind` says what the column holds and
                # `sql_kind` says the view already projects it as text for the
                # canonicaliser to work on, so the padding is right there in `_raw`.
                continue
            padded = [
                value for value in frame[column["header"]].dropna()
                if isinstance(value, str) and value.strip().startswith("0")
                and value.strip() != "0"
            ]
            if padded:
                found += 1
                print(f"  {slot:16} {column['header']!r:26} -> {column['column']:24} "
                      f"{len(padded):5} padded, e.g. {padded[:2]}")
    if not found:
        print("  no view column typed numeric holds padded text in the current uploads")
    return 1 if found else 0


def main() -> int:
    wanted = [arg for arg in sys.argv[1:] if arg != "--drift"]
    client = SupabaseRest(env_file=REPO_ROOT / ".env.local")
    extra = every_slot()
    grid_source = sources_module.PostgresSources(client, extra_slots=extra)
    table_source = sources_module.TableSources(client, extra_slots=extra)

    if "--drift" in sys.argv[1:]:
        return drift(grid_source)

    slots = sorted(sources_module.dump_columns())
    if wanted:
        slots = [slot for slot in slots if slot in wanted]

    failed = 0
    for slot in slots:
        try:
            faults, note = compare_slot(slot, grid_source, table_source)
        except Exception as error:                        # noqa: BLE001
            faults, note = [f"{type(error).__name__}: {error}"], ""
        if faults:
            failed += 1
            print(f"\n✗ {slot}  {note}")
            for fault in faults:
                print(f"    {fault}")
        else:
            print(f"✓ {slot:16} {note}")

    print(f"\n{len(slots) - failed} of {len(slots)} slots read identically both ways")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
