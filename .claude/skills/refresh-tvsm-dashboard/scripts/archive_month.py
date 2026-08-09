#!/usr/bin/env python3
"""Move a closed month's dumps into `dumps/YYYY-MM/`, leaving the current month on top.

`dumps/` is meant to answer one question at a glance: what is this month built from.
Left alone it answers a different one — what has ever been sent — because each day
overwrites the file before it and the month boundary passes unmarked. So when a month
closes, its final set moves down a level and the top stays current.

    python3 archive_month.py --dumps dumps --month 2026-07
    python3 archive_month.py --dumps dumps --month 2026-07 --dry-run

Three kinds of file are deliberately left where they are:

  * **Trend sources** — `sales_q4.xlsx`, `sales_q1.xlsx`, `sales_<mon>.xlsx`. A closed
    month's sales dump is archived *by being renamed* into a trend source, and the
    pipeline still reads it every day. Moving it into a month folder would silently
    drop that month out of the six-month trend, which is exactly the failure the
    archive naming exists to prevent.
  * **Masters** — `zmat.xlsx`, `contract.xlsx`. Not month-specific; they change when
    the owner approves a new one, not when the calendar turns. The schedule workbook is
    *not* one of these: it is the month's own and archives with it.
  * **`README.md` and `deliverables/`** — the folder's own documentation and outputs.

Nothing is copied: files move, so a file cannot exist in two places and drift.
"""
from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

# Read every day regardless of which month sent them. `rm_tracker_model.xlsx` is not
# here on purpose: the schedule workbook belongs to its month and is replaced when the
# next one arrives, so it archives with the rest — July's went down as
# `july0626_rm_tracker_v1.xlsx`, the name it was sent under.
KEEP_AT_TOP = {"README.md", "zmat.xlsx", "contract.xlsx"}
KEEP_PATTERNS = (
    re.compile(r"^sales_q\d\.xlsx$"),                       # quarterly trend extracts
    re.compile(r"^sales_[a-z]{3}\.xlsx$"),                  # archived monthly trend source
)
KEEP_DIRECTORIES = {"deliverables"}
MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def stays(name: str) -> bool:
    return name in KEEP_AT_TOP or any(p.match(name) for p in KEEP_PATTERNS)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dumps", type=Path, default=Path("dumps"))
    parser.add_argument("--month", required=True, help="the month being closed, YYYY-MM")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not MONTH.match(args.month):
        raise SystemExit(f"--month must be YYYY-MM, got {args.month!r}")
    dumps = args.dumps.resolve()
    if not dumps.is_dir():
        raise SystemExit(f"{dumps} is not a directory")
    target = dumps / args.month
    if target.exists() and any(target.iterdir()):
        raise SystemExit(
            f"{target} already holds files. Archiving twice would overwrite the month "
            "that is already there; move or remove it first."
        )

    moving, keeping = [], []
    for entry in sorted(dumps.iterdir()):
        if entry.is_dir():
            if entry.name not in KEEP_DIRECTORIES and not MONTH.match(entry.name):
                keeping.append((entry.name, "directory, left alone"))
            continue
        if stays(entry.name):
            keeping.append((entry.name, "read every day"))
        else:
            moving.append(entry)

    for name, why in keeping:
        print(f"  keep   {name:36} {why}")
    for entry in moving:
        print(f"  move   {entry.name:36} -> {args.month}/")
    if not moving:
        print("\nNothing to archive.")
        return 0

    if args.dry_run:
        print(f"\nDry run: {len(moving)} file(s) would move into {target}")
        return 0

    target.mkdir(parents=True, exist_ok=True)
    for entry in moving:
        shutil.move(str(entry), str(target / entry.name))
    print(f"\nMoved {len(moving)} file(s) into {target}")
    print("The next refresh writes this month's files into dumps/ afresh.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
