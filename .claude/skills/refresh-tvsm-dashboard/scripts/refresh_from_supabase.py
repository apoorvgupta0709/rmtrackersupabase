"""The refresh, reading uploads from Supabase and writing a build back.

This is what the GitHub Action runs. `refresh_dashboard.py` is unchanged and does all
the work; this only supplies it a different source of frames and a different place to put
the answer, which is the whole point of the source registry.

    python3 scripts/refresh_from_supabase.py --as-of 2026-08-07

Exit code is 1 when the pipeline's own gate fails, so a red Action means a dashboard that
was deliberately not published rather than one that broke.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import sources as sources_module  # noqa: E402
from sinks import write_build  # noqa: E402
from supabase_rest import SupabaseRest  # noqa: E402


def load_pipeline():
    spec = importlib.util.spec_from_file_location(
        "refresh_dashboard", HERE / "refresh_dashboard.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def is_last_day_of_month(when: date) -> bool:
    return (when + timedelta(days=1)).month != when.month


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", default=None,
                        help="YYYY-MM-DD; defaults to today UTC, as the pipeline does")
    parser.add_argument("--run-url", default=None, help="link back to the Action run")
    parser.add_argument("--dry-run", action="store_true",
                        help="run the pipeline but write no build. Sales batches are "
                             "still absorbed into the ledger: that is an input rather "
                             "than an output, and it is idempotent")
    args = parser.parse_args()

    as_of = args.as_of or datetime.now(timezone.utc).date().isoformat()
    started = time.time()

    client = SupabaseRest(env_file=Path.cwd() / ".env.local")
    pipeline = load_pipeline()
    extra = sources_module.slots_for_families(
        pipeline.ORDER_BOOK_SHEETS, pipeline.PRICING_SHEETS, pipeline.SIGNOFF_SHEETS
    )
    # The dump tables, not the cell grid the uploader stored.
    #
    # Every uploaded dump lands in both: `raw_rows` cell for cell, which is the audit
    # trail, and a named table or view, which is what anyone querying the data reaches
    # for. Reading the second is what makes the four accumulating dumps mean anything —
    # the transfer ledger holds every line back to 8 July where the current upload holds
    # only the month in progress, and zmat holds every code SAP has ever extracted rather
    # than only those still in the newest extract.
    #
    # Proved before it was switched, by `tools/compare_pipeline_backends.py`: the whole
    # of `data.json` is identical between the two backends except for the transfer figures
    # and the transfer drill-downs, which is the gain and not a difference — 220 lines
    # against 255, 1,898 MT against 2,129. `PostgresSources` is still the class this
    # inherits from and still what the comparison harnesses read the other side through.
    source = sources_module.TableSources(client, extra_slots=extra)

    held = sorted(source.batches)
    print(f"as of {as_of}; {len(held)} slots uploaded: {', '.join(held)}", flush=True)

    # Fold every un-absorbed sales batch into the ledger before the pipeline reads it.
    #
    # This has to happen here rather than inside `sales_ledger()`, because a read that
    # quietly writes is worse than an explicit step — but it is exactly the step that is
    # easy to leave out, and leaving it out is not a quiet failure: the ledger reads
    # empty and the pipeline dies on the first sales column it touches. A test asserts
    # this call exists and comes before `pipeline.main`.
    absorbed = source.absorb_sales()
    print(f"absorbed {sum(absorbed.values())} new sales lines "
          f"from {len(absorbed)} batch(es)", flush=True)

    # The pipeline still writes its file outputs — data.json, the CSVs, the QC summary.
    # They are the artefact worth attaching to the run when a build has to be explained.
    output_dir = Path(tempfile.mkdtemp(prefix="refresh-"))
    exit_code = pipeline.main(Path.cwd(), output_dir, as_of, sources=source)
    payload = json.loads((output_dir / "data.json").read_text())
    status = payload.get("metadata", {}).get("status", "FAIL")
    print(f"pipeline finished in {time.time() - started:.0f}s: {status}", flush=True)

    if args.dry_run:
        print(f"dry run; outputs left in {output_dir}")
        return exit_code

    build = write_build(client, payload, as_of=as_of, run_url=args.run_url)
    print(f"build {build['id']}: {build['counts']}", flush=True)

    if build.get("published_at"):
        print("published", flush=True)
        # The last build of a month is the one kept when the rest are pruned. Marked here
        # rather than by a scheduled job, because the run that happens to be the month's
        # last is the only one that knows it is.
        if is_last_day_of_month(date.fromisoformat(as_of)):
            client.update("dashboard_builds", f"id=eq.{build['id']}",
                          {"is_month_end": True})
            print("marked as the month-end build", flush=True)
        # Prune only after a successful publish. A refresh that failed is exactly when
        # the older builds are worth having, so nothing is dropped on the way out of a
        # bad run.
        pruned = client.rpc("prune_builds", {"keep_days": 14})
        uploads = client.rpc("prune_uploads", {"keep_days": 14})
        # The rows behind a superseded batch go a fortnight before the manifest does. They
        # are what the space actually is — 52 MB against a few hundred bytes an upload —
        # and they are spent once the batch is no longer current: every snapshot is read
        # through a view filtered to `status = 'current'`, and every accumulating dump has
        # had its lines folded into a table that outlives the batch. What is kept is the
        # record that the upload happened, which is what somebody asks about later.
        rows = client.rpc("prune_upload_rows", {"keep_days": 1})
        print(f"pruned {pruned} old build(s), {uploads} old upload(s), "
              f"and the rows behind {rows} superseded batch(es)", flush=True)
    else:
        print(f"NOT published — status {status}. Yesterday's build still stands.",
              flush=True)

    print(f"outputs: {output_dir}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
