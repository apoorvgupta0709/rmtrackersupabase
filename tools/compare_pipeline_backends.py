"""Run the whole pipeline off the cell grid and off the dump tables, and diff the answers.

The frame-level harness — `tools/compare_table_sources.py` — asks whether two reads agree
cell for cell. This asks the only question that decides anything: whether the dashboard
they build is the same dashboard.

They are different questions, and the second is the one worth failing on. A view types a
column once, from what that column *means*, where a read of the file types it every
morning from whatever the extract happened to hold — so a quantity that arrives as the
text `6` on Tuesday and the number 6 on Wednesday is one column to a table and two to a
reader. Most of that difference dies in the first `pd.to_numeric` the pipeline applies,
and this is what proves which parts of it do.

    python3 tools/compare_pipeline_backends.py --as-of 2026-08-14

Prints every path in `data.json` whose value differs, and exits 1 if any does.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import warnings
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = REPO_ROOT / ".claude" / "skills" / "refresh-tvsm-dashboard" / "scripts"
sys.path.insert(0, str(SCRIPTS))

warnings.filterwarnings("ignore")

import sources as sources_module  # noqa: E402
from supabase_rest import SupabaseRest  # noqa: E402


def load_pipeline():
    spec = importlib.util.spec_from_file_location(
        "refresh_dashboard", SCRIPTS / "refresh_dashboard.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(pipeline, source, as_of: str) -> dict:
    output = Path(tempfile.mkdtemp(prefix="backend-"))
    pipeline.main(REPO_ROOT, output, as_of, sources=source)
    return json.loads((output / "data.json").read_text())


# Keys whose value is a fact about the run rather than about the business, and which are
# therefore expected to differ between two runs of it.
INCIDENTAL = {"generated_at", "duration_seconds", "source_files", "run_url", "build_id"}


def differences(left, right, path: str = "") -> list[str]:
    """Every leaf of these two payloads that does not match, by path."""
    if isinstance(left, dict) and isinstance(right, dict):
        faults = []
        for key in sorted(set(left) | set(right)):
            if key in INCIDENTAL:
                continue
            here = f"{path}.{key}" if path else str(key)
            if key not in left:
                faults.append(f"{here}: only on the table run")
            elif key not in right:
                faults.append(f"{here}: only on the grid run")
            else:
                faults += differences(left[key], right[key], here)
        return faults
    if isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            return [f"{path}: {len(left)} entries off the grid, {len(right)} off the table"]
        faults = []
        for index, (a, b) in enumerate(zip(left, right)):
            faults += differences(a, b, f"{path}[{index}]")
        return faults
    if isinstance(left, (int, float)) and isinstance(right, (int, float)) \
            and not isinstance(left, bool) and not isinstance(right, bool):
        # A figure that has been through JSON and back can land a bit off the double the
        # reader produced. A difference at the fifteenth digit is not what this is for.
        if abs(float(left) - float(right)) <= 1e-9 * max(1.0, abs(left), abs(right)):
            return []
    if left != right:
        return [f"{path}: {left!r} off the grid, {right!r} off the table"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", default=None)
    parser.add_argument("--limit", type=int, default=60,
                        help="how many differing paths to print")
    args = parser.parse_args()
    as_of = args.as_of or datetime.now(timezone.utc).date().isoformat()

    client = SupabaseRest(env_file=REPO_ROOT / ".env.local")
    pipeline = load_pipeline()
    extra = sources_module.slots_for_families(
        pipeline.ORDER_BOOK_SHEETS, pipeline.PRICING_SHEETS, pipeline.SIGNOFF_SHEETS
    )

    # Absorb first, once, so both runs read the same ledger. Otherwise the first run folds
    # in whatever is outstanding and the second reads a fuller table — a difference that
    # would look like a backend disagreement and is nothing of the kind.
    grid = sources_module.PostgresSources(client, extra_slots=extra)
    grid.absorb_sales()

    print("running the pipeline off the cell grid…", flush=True)
    on_grid = run(pipeline, grid, as_of)
    print("running the pipeline off the dump tables…", flush=True)
    on_tables = run(
        pipeline, sources_module.TableSources(client, extra_slots=extra), as_of
    )

    faults = differences(on_grid, on_tables)
    if not faults:
        print("\nidentical: every figure in data.json agrees")
        return 0
    print(f"\n{len(faults)} difference(s):")
    for fault in faults[:args.limit]:
        print(f"  {fault}")
    if len(faults) > args.limit:
        print(f"  … and {len(faults) - args.limit} more")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
