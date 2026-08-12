"""Where a finished refresh goes.

The pipeline builds one `data.json` payload. Writing it to a file is what it has always
done and still does; this also writes it into the database as a versioned build, which
is what lets a reader be shown only the sections their grants cover.

The split is deliberate. `data.json` is one document and every account downloaded all
6.5 MB of it, so "mes may not see pricing" could only ever be a hidden button. Here the
same payload becomes rows in three tables — sections, scalars, drill-downs — each
carrying a section or prefix that `section_views` maps to a tab. An ungranted section
returns nothing.

A build is written before it is published and published only if the pipeline's own gate
allows it, so a failed refresh leaves yesterday's dashboard standing rather than
replacing it with a broken one.
"""

from __future__ import annotations

from datetime import datetime, timezone

# data.json sections that are already a list of rows: one section table row each.
ROW_SECTIONS = (
    "customer_lines", "customer_summary",
    "megh_tracker", "megh_bop_added", "megh_length_bucketing", "megh_unmapped",
    "ll_tracker",
    "missing_mappings", "stock_unmapped", "rfd_unmapped", "wip_unmapped",
    "sales_summary", "overdue_analysis",
)

# Sections that arrive wrapped in a dict — rows beside the configuration that describes
# them. The rows become a section; the rest becomes a scalar under the same name, so
# nothing about a tab is lost and the front end reads one shape.
WRAPPED_SECTIONS = {
    "transfers":       [("rows", "transfers")],
    "str_plan":        [("rows", "str_plan")],
    "orders":          [("rows", "orders"), ("unmapped", "orders_unmapped")],
    "sku_pricing":     [("rows", "sku_pricing"), ("unpriced", "sku_pricing_unpriced")],
    "code_repository": [("rows", "code_repository")],
    "signoff":         [("unmapped", "signoff_unmapped")],
    "stock_analysis":  [("ctl", "stock_analysis_ctl"), ("ll", "stock_analysis_ll"),
                        ("source_coverage", "stock_source_coverage")],
    "sales_trend":     [("buckets", "trend_buckets"),
                        ("customer_skus", "trend_customer_skus"),
                        ("customer_sku_history", "trend_customer_sku_history"),
                        ("plants", "trend_plants")],
}

# Small enough to read whole, and needed by every tab: the headline cards, the run's
# status, the drill-down column layouts, the bucket dropdown.
SCALAR_KEYS = ("summary", "metadata", "mapping_quality", "detail_columns",
               "governed_buckets", "customer_summary", "megh_reco")

# The pipeline's own QC. Useful for diagnosing a refresh, not for reading a dashboard.
ADMIN_ONLY_SCALARS = ("qc",)


def _detail_prefix(detail_key: str) -> str:
    """`STOCKCTL|4731|3499608|...` -> `STOCKCTL`. The prefix is what a grant is checked against."""
    return detail_key.split("|", 1)[0]


def write_build(client, payload: dict, *, as_of: str, run_url: str | None = None,
                triggered_by: str | None = None, publish: bool = True) -> dict:
    """Write one refresh into the database and return the build row.

    `publish` follows the pipeline's gate: PASS and WARN publish, FAIL does not. A build
    that is written but not published is still there to inspect, which is the point —
    the failure is a thing you can look at rather than a run that vanished.
    """
    metadata = payload.get("metadata", {})
    status = metadata.get("status", "FAIL")

    build = client.insert("dashboard_builds", {
        "as_of": as_of,
        "status": status,
        "warnings": metadata.get("warnings", []),
        "failures": metadata.get("failures", []),
        "run_url": run_url,
        "triggered_by": triggered_by,
    }, returning=True)[0]
    build_id = build["id"]

    sections: list[dict] = []

    def add_rows(section: str, rows) -> None:
        if not isinstance(rows, list):
            return
        sections.extend(
            {"build_id": build_id, "section": section, "seq": i, "row": row}
            for i, row in enumerate(rows)
        )

    for section in ROW_SECTIONS:
        add_rows(section, payload.get(section))

    scalars: list[dict] = [
        {"build_id": build_id, "key": key, "value": payload[key], "admin_only": False}
        for key in SCALAR_KEYS if key in payload
    ] + [
        {"build_id": build_id, "key": key, "value": payload[key], "admin_only": True}
        for key in ADMIN_ONLY_SCALARS if key in payload
    ]

    for source, mappings in WRAPPED_SECTIONS.items():
        block = payload.get(source)
        if not isinstance(block, dict):
            continue
        taken = set()
        for field, section in mappings:
            add_rows(section, block.get(field))
            taken.add(field)
        # Whatever is not rows is configuration the tab needs — the destination plant and
        # target days for the STR plan, the quarter list for pricing, the month list for
        # the trend. Kept beside the rows rather than dropped.
        rest = {k: v for k, v in block.items() if k not in taken}
        if rest:
            scalars.append({"build_id": build_id, "key": source, "value": rest,
                            "admin_only": False})

    # A drill-down key whose value is an empty list writes no rows, so it does not come
    # back — 675 of the 6,013 keys on the 7 August build are like that. Nothing is lost:
    # a query for one returns no rows, which is what an empty list already meant, and the
    # modal shows nothing either way. It does mean the table cannot round-trip
    # `stock_details` key-for-key, so a check that counts keys will read 5,338 and should
    # not treat the difference as missing data.
    details = [
        {"build_id": build_id, "prefix": _detail_prefix(key), "detail_key": key,
         "seq": i, "row": row}
        for key, rows in payload.get("stock_details", {}).items()
        for i, row in enumerate(rows)
    ]

    client.insert("build_sections", sections)
    client.insert("build_scalars", scalars)
    client.insert("detail_rows", details)

    finished = {"finished_at": datetime.now(timezone.utc).isoformat()}
    if publish and status != "FAIL":
        finished["published_at"] = finished["finished_at"]
    updated = client.update("dashboard_builds", f"id=eq.{build_id}", finished,
                            returning=True)

    return {
        **(updated[0] if updated else build),
        "counts": {"sections": len(sections), "scalars": len(scalars),
                   "detail_rows": len(details)},
    }
