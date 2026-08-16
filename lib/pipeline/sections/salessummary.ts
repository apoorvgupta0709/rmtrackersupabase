/**
 * Section 7 — sales summary, classified through `OEM_key_1_rev codes`.
 *
 * Ported from `refresh_dashboard.py` L2450–2498.
 *
 *  - **Rows with no customer code are excluded.** The workbook's own total and summary
 *    rows carry none, and leaving them in makes the summary double-count the file's grand
 *    total as an "Unmapped" transaction.
 *  - **A conversion agent's code is routed to the OEM it converts for**, but the Boiler
 *    material-group override still wins — that is the documented order, and it is why the
 *    mask tests `OEM != "Boiler"` rather than simply overwriting.
 *  - **Anything still unclassified is `Unmapped`,** named rather than dropped, so the
 *    tonnage that reaches no OEM is visible on the tab instead of missing from it.
 */

import { kahanSum } from "../numeric.ts";
import { isNa, pyStr } from "../normalise.ts";
import type { Row } from "../source.ts";
import { CONVERSION_AGENT_OEM_BY_CODE } from "./overdue.ts";
import type { SalesMapping } from "./sales.ts";

export type SalesSummaryResult = {
  summary: Row[];
  /** `SALES|<oem>` cards, one row per customer. */
  metricDetails: Record<string, Row[]>;
};

export function salesSummary(sales: SalesMapping): SalesSummaryResult {
  const transactions = sales.published
    .filter((line) => line.customer_key !== null)
    .map((line) => {
      const conversion = line.customer_key === null
        ? undefined : CONVERSION_AGENT_OEM_BY_CODE[line.customer_key];
      const salesOem = (conversion !== undefined && line.OEM !== "Boiler")
        ? conversion
        : (line.OEM ?? "Unmapped");
      return { line, sales_oem: salesOem };
    });

  /* ---- one row per OEM ----------------------------------------------------- */

  const byOem = groupBy(transactions, (t) => [t.sales_oem]);

  const summary: Row[] = byOem
    .map(([parts, group]) => ({
      OEM: parts[0],
      raw_mt: kahanSum(group.map((t) => t.line.sales_mt)),
      sales_nos: kahanSum(group.map((t) => t.line.sales_nos)),
      sales_m: kahanSum(group.map((t) => t.line.sales_m)),
      customers: new Set(group.map((t) => t.line.customer_key)
        .filter((c) => c !== null)).size,
      transactions: group.length,
    }))
    // Ordered on the aggregate, then rendered — the same distinction section 9 turns on.
    .sort((a, b) => b.raw_mt - a.raw_mt)
    .map(({ raw_mt, ...rest }) => ({
      OEM: rest.OEM,
      sales_mt: raw_mt,
      sales_nos: rest.sales_nos,
      sales_m: rest.sales_m,
      customers: rest.customers,
      transactions: rest.transactions,
      detail_key: `SALES|${rest.OEM}`,
    }));

  /* ---- one card row per customer ------------------------------------------- */

  const metricDetails: Record<string, Row[]> = {};
  const byCustomer = groupBy(transactions,
    (t) => [t.sales_oem, t.line.customer_key, pick(t.line["CUSTOMER  NAME"])]);

  for (const [oemParts] of byOem) {
    const oem = oemParts[0];
    metricDetails[`SALES|${oem}`] = byCustomer
      .filter(([parts]) => parts[0] === oem)
      .map(([parts, group]) => ({
        parts,
        qty: kahanSum(group.map((t) => t.line.sales_mt)),
      }))
      .sort((a, b) => b.qty - a.qty)
      .map((entry) => ({
        source: "Sales dump",
        plant: oem,
        sku: entry.parts[2],
        material_code: entry.parts[1],
        qty: entry.qty,
        unit: "MT",
      }));
  }

  return { summary, metricDetails };
}

/* ---- helpers --------------------------------------------------------------- */

const pick = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));

/** `groupby([...])` in pandas' sorted order, absent last on each level. */
function groupBy<T>(rows: T[], parts: (row: T) => (string | null)[]): [(string | null)[], T[]][] {
  const groups = new Map<string, [(string | null)[], T[]]>();
  for (const row of rows) {
    const p = parts(row);
    const k = JSON.stringify(p);
    (groups.get(k) ?? groups.set(k, [p, []]).get(k)!)[1].push(row);
  }
  return [...groups.values()].sort((a, b) => {
    for (let i = 0; i < a[0].length; i += 1) {
      const x = a[0][i];
      const y = b[0][i];
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? -1 : 1;
    }
    return 0;
  });
}
