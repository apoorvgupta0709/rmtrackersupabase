"""Load parsed cell grids into the uploads tables — what the web uploader will do.

The browser will parse an .xlsx with SheetJS and post the cells; this does the same
thing from a directory of exported grids, so the whole backend can be exercised before
any of the front end exists. The write path it uses — one batch row, rows in chunks,
then supersede — is the one the ingest route will use.

    node tools/export_sheet_cells.mjs slots.json /tmp/cells
    python3 tools/ingest_cells.py /tmp/cells
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / ".claude" / "skills" / "refresh-tvsm-dashboard" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from supabase_rest import SupabaseRest  # noqa: E402


def ingest(client: SupabaseRest, grid: dict, *, uploaded_by: str | None = None) -> dict:
    """One upload: a batch, its rows, then supersede whatever it replaces.

    Written in that order on purpose. The batch is inserted as 'superseded' and only
    promoted once every row is in, so a run that dies halfway leaves the previous upload
    current rather than promoting an empty one — a refresh would otherwise read a dump
    with no rows and publish a dashboard of zeros.
    """
    cells = grid["cells"]
    digest = hashlib.sha256(
        json.dumps(cells, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()

    batch = client.insert("raw_batches", {
        "slot": grid["slot"],
        "sheet": grid.get("sheet"),
        "original_filename": grid.get("source_file", "unknown"),
        "content_sha256": digest,
        "columns": [],          # the grid is raw; naming happens at read time
        "column_types": {},
        "row_count": len(cells),
        "status": "superseded",
        "uploaded_by": uploaded_by,
    }, returning=True)[0]

    client.insert(
        "raw_rows",
        [{"batch_id": batch["id"], "seq": i, "row": row} for i, row in enumerate(cells)],
    )
    client.rpc("supersede_slot", {
        "target_slot": grid["slot"],
        "target_sheet": grid.get("sheet"),
        "new_batch": batch["id"],
    })
    return batch


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("cells", type=Path, help="directory written by export_sheet_cells.mjs")
    parser.add_argument("--only", nargs="*", help="limit to these slots")
    args = parser.parse_args()

    client = SupabaseRest(env_file=REPO / ".env.local")
    files = sorted(p for p in args.cells.glob("*.json") if p.name != "_manifest.json")
    if args.only:
        wanted = set(args.only)
        files = [p for p in files if json.loads(p.read_text())["slot"] in wanted]

    total_rows = 0
    started = time.time()
    for path in files:
        grid = json.loads(path.read_text())
        t0 = time.time()
        ingest(client, grid)
        total_rows += len(grid["cells"])
        print(f"  {grid['slot']:22} {len(grid['cells']):>7,} rows  {time.time()-t0:5.1f}s",
              flush=True)

    elapsed = time.time() - started
    print(f"\n{len(files)} slots, {total_rows:,} rows in {elapsed:.0f}s "
          f"({total_rows/max(elapsed,1):,.0f} rows/s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
