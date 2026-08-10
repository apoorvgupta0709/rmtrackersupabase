/**
 * One table on a tab, with the totals row the sheet would have.
 *
 * Two rules are enforced here rather than left to each view to remember, because both
 * have already been got wrong on this dashboard:
 *
 *  - **A column is totalled only when it says so.** Prices, coverage days, ages and
 *    percentages are rates, and a stock pool shared between customers is counted once
 *    however many rows show it. The old rule was "total every numeric column except a
 *    short list", which is the wrong way round: a new rate column shipped summed.
 *  - **A per-row average is averaged, never added.** A table that closes on an average
 *    month divides the tonnage by the months that actually moved, not by the row count
 *    and not by the window length.
 */

export type Kind =
  | "text" | "mt" | "nos" | "int" | "inr" | "days" | "pct" | "rate" | "money"
  | "bool" | "list";

export type Column = {
  field: string;
  label: string;
  kind?: Kind;
  /** Sum this column in the totals row. Only quantities; never a rate. */
  total?: boolean;
  /** A month column, so the average-month totals rule can find them. */
  month?: boolean;
  wide?: boolean;
};

/** Closes the table on an average month rather than on a window total. */
export type AverageOver = { monthsField: string; avgField: string; totalField: string };

const NUMERIC: Kind[] = ["mt", "nos", "int", "inr", "days", "pct", "rate", "money"];

/** `months.2026-01` reaches into the row's month dict; everything else is a plain key. */
export function get(row: Record<string, unknown>, field: string): unknown {
  if (!field.includes(".")) return row[field];
  const [head, ...rest] = field.split(".");
  const inner = row[head];
  if (inner && typeof inner === "object") {
    return (inner as Record<string, unknown>)[rest.join(".")];
  }
  return undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const fixed = (value: number, dp: number) =>
  value.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function format(value: unknown, kind: Kind = "text"): string {
  if (kind === "bool") return value === true ? "yes" : "—";
  if (kind === "list") {
    const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
    return list.length ? list.join(", ") : "—";
  }
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "yes" : "no";

  if (typeof value === "number") {
    switch (kind) {
      case "mt": return fixed(value, 3);
      case "nos":
      case "int":
      case "inr":
      case "money": return fixed(value, 0);
      case "days": return fixed(value, Number.isInteger(value) ? 0 : 1);
      case "pct": return `${fixed(value, 2)}%`;
      case "rate": return fixed(value, 2);
      default: return fixed(value, Number.isInteger(value) ? 0 : 3);
    }
  }
  return String(value);
}

export default function DataTable({
  title,
  note,
  columns,
  rows,
  averageOver,
  capped,
}: {
  title: string;
  note?: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  averageOver?: AverageOver;
  capped?: number;
}) {
  const isNum = (c: Column) => NUMERIC.includes(c.kind ?? "text");

  const totals: Record<string, number> = {};
  for (const c of columns) {
    if (c.total && isNum(c)) {
      totals[c.field] = rows.reduce((sum, r) => sum + num(get(r, c.field)), 0);
    }
  }

  // Months that moved at all across the visible rows — the denominator the average
  // month is taken over. A window of eight months in which a SKU sold in three is a
  // three-month average, and the totals row must say the same thing the cells do.
  if (averageOver) {
    const monthFields = columns.filter((c) => c.month).map((c) => c.field);
    const moved = monthFields.filter((f) => rows.some((r) => num(get(r, f)) !== 0)).length;
    totals[averageOver.monthsField] = moved;
    totals[averageOver.avgField] = moved ? (totals[averageOver.totalField] ?? 0) / moved : 0;
  }

  return (
    <section style={{ marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, letterSpacing: "-0.015em" }}>{title}</h2>
        <span className="label">
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {note && (
        <p className="hint" style={{ margin: "6px 0 0", maxWidth: 860 }}>
          {note}
        </p>
      )}

      {capped !== undefined && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          Showing the first {rows.length.toLocaleString("en-IN")} rows; this table is
          capped at {capped.toLocaleString("en-IN")} and there are more behind it. The
          totals below cover only what is shown.
        </div>
      )}

      {rows.length === 0 ? (
        <div className="notice" style={{ marginTop: 10 }}>
          Nothing on this table for the published build. That is either an empty queue —
          which is the good outcome — or a tab your account has no grant for, in which
          case the policies returned no rows rather than hiding them.
        </div>
      ) : (
        <div className="sheet scroll-x" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.field} className={isNum(c) ? "num" : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td
                      key={c.field}
                      className={isNum(c) ? "num" : undefined}
                      style={
                        c.wide
                          ? { maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }
                          : undefined
                      }
                      title={c.wide ? String(get(row, c.field) ?? "") : undefined}
                    >
                      {format(get(row, c.field), c.kind)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {columns.map((c, i) => (
                  <td
                    key={c.field}
                    className={isNum(c) ? "num" : undefined}
                    style={{
                      borderTop: "1px solid var(--rule-strong)",
                      fontFamily: "var(--mono)",
                      fontWeight: 600,
                      background: "var(--paper)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {i === 0
                      ? `${rows.length} rows`
                      : c.field in totals
                        ? format(totals[c.field], c.field === averageOver?.monthsField ? "int" : c.kind)
                        : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
