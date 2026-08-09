import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Column = { field: string; label: string; num?: boolean; wide?: boolean };

/**
 * The three ported views.
 *
 * Columns are named here rather than inferred, because these sheets carry forty-odd
 * fields each and only some of them are what anyone reads. The rest are still in the
 * row and still queryable — this decides what is on screen, not what exists.
 *
 * A view whose section returns nothing renders as empty. That is the grants working:
 * the policies refuse the rows, so there is nothing to hide in the markup.
 */
const VIEWS: Record<string, { label: string; section: string; note: string; columns: Column[] }> = {
  customerView: {
    label: "Customer tracker",
    section: "customer_lines",
    note:
      "One row per scheduled size per customer. Pool columns must not be summed across "
      + "customers — stock is shared, so a total would count it more than once.",
    columns: [
      { field: "customer_display", label: "Customer", wide: true },
      { field: "OEM", label: "OEM" },
      { field: "bucket", label: "Bucket", wide: true },
      { field: "ctl_bucket", label: "CTL bucket", wide: true },
      { field: "Plant", label: "Plant" },
      { field: "schedule_mt", label: "Schedule MT", num: true },
      { field: "sales_mt", label: "Sales MT", num: true },
      { field: "balance_mt", label: "Balance MT", num: true },
      { field: "open_balance_mt", label: "Open bal MT", num: true },
      { field: "over_dispatch_mt", label: "Over disp MT", num: true },
      { field: "ctl_stock_pool_mt", label: "CTL stock MT", num: true },
      { field: "ll_stock_pool_mt", label: "LL stock MT", num: true },
      { field: "shared_wip_mt", label: "WIP MT", num: true },
      { field: "history_avg_month_mt", label: "Avg month MT", num: true },
    ],
  },
  llView: {
    label: "Long-length tracker",
    section: "ll_tracker",
    note:
      "Bucket-level coverage for long length. Coverage days and the gap columns are "
      + "computed upstream against the month's schedule.",
    columns: [
      { field: "bucket", label: "Bucket", wide: true },
      { field: "risk", label: "Risk" },
      { field: "total_schedule_mt", label: "Schedule MT", num: true },
      { field: "total_sales_mt", label: "Sales MT", num: true },
      { field: "remaining_schedule_mt", label: "Remaining MT", num: true },
      { field: "available_ll_stock_mt", label: "LL stock MT", num: true },
      { field: "shared_wip_mt", label: "WIP MT", num: true },
      { field: "transit_mt", label: "Transit MT", num: true },
      { field: "coverage_days", label: "Cover days", num: true },
      { field: "gap_to_30_days_mt", label: "Gap 30d MT", num: true },
      { field: "gap_to_45_days_mt", label: "Gap 45d MT", num: true },
      { field: "order_logged_mt", label: "Ordered MT", num: true },
      { field: "signoff_mt", label: "Signed MT", num: true },
      { field: "last_month_sales_mt", label: "Last month MT", num: true },
    ],
  },
  mappingView: {
    label: "Missing mappings",
    section: "missing_mappings",
    note:
      "The queue. Every row here is tonnage the pipeline could not govern, so it is "
      + "tonnage missing from a tracker somewhere. The empty cells are the work.",
    columns: [
      { field: "mapping_type", label: "Type" },
      { field: "source", label: "Source", wide: true },
      { field: "customer_code", label: "Customer code" },
      { field: "customer", label: "Customer", wide: true },
      { field: "material_code", label: "Material code" },
      { field: "description", label: "Description", wide: true },
      { field: "reason", label: "Reason", wide: true },
      { field: "affected_mt", label: "Affected MT", num: true },
    ],
  },
};

function cell(value: unknown, num?: boolean) {
  if (value === null || value === undefined || value === "") return "—";
  if (num && typeof value === "number") {
    return value.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }
  return String(value);
}

export default async function ViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  const spec = VIEWS[view];
  if (!spec) notFound();

  const supabase = await supabaseServer();
  const { data: rows } = await supabase
    .from("build_sections")
    .select("seq,row")
    .eq("section", spec.section)
    .order("seq")
    .limit(1000);

  const records = (rows ?? []).map((r) => r.row as Record<string, unknown>);

  // Totals over the numeric columns, matching how the sheet is read: a column of
  // tonnages adds up, a rate or a day-count does not.
  const NEVER_TOTAL = new Set(["coverage_days", "history_avg_month_mt"]);
  const totals = Object.fromEntries(
    spec.columns
      .filter((c) => c.num && !NEVER_TOTAL.has(c.field))
      .map((c) => [
        c.field,
        records.reduce((sum, r) => sum + (typeof r[c.field] === "number" ? (r[c.field] as number) : 0), 0),
      ]),
  );

  return (
    <>
      <div className="rise" style={{ marginBottom: 16, maxWidth: 760 }}>
        <div className="label">{spec.section}</div>
        <h1 style={{ fontSize: 26, margin: "4px 0 8px", letterSpacing: "-0.025em" }}>
          {spec.label}
        </h1>
        <p className="hint">{spec.note}</p>
      </div>

      {records.length === 0 ? (
        <div className="sheet" style={{ padding: 24, maxWidth: 620 }}>
          <div className="label">Nothing to show</div>
          <p className="hint" style={{ marginTop: 8 }}>
            Either no build is published yet, or this tab is not granted to your account.
            An ungranted tab returns no rows rather than hiding them.
          </p>
        </div>
      ) : (
        <div className="sheet rise scroll-x" style={{ animationDelay: "60ms" }}>
          <table>
            <thead>
              <tr>
                {spec.columns.map((c) => (
                  <th key={c.field} className={c.num ? "num" : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((row, i) => (
                <tr key={i}>
                  {spec.columns.map((c) => (
                    <td
                      key={c.field}
                      className={c.num ? "num" : undefined}
                      style={c.wide ? { maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" } : undefined}
                    >
                      {cell(row[c.field], c.num)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {spec.columns.map((c, i) => (
                  <td
                    key={c.field}
                    className={c.num ? "num" : undefined}
                    style={{
                      borderTop: "1px solid var(--rule-strong)",
                      fontFamily: "var(--mono)",
                      fontWeight: 600,
                      background: "var(--paper)",
                    }}
                  >
                    {i === 0
                      ? `${records.length} rows`
                      : c.field in totals
                        ? cell(totals[c.field], true)
                        : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
