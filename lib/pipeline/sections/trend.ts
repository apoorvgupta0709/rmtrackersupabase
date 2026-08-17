/**
 * Section 17a — the past sales trend: what TSL has actually billed to the TVSM chain,
 * month by month.
 *
 * Ported from `refresh_dashboard.py` L5490–5570 and L5619–5740. The Megh sales history in
 * the middle of the same section reads `megh_rows` from section 11 and is not ported here.
 *
 *  - **Two parties are tracked and never merged**: the ancillaries TSL bills directly, and
 *    Megh Steel under 943209, which converts for TVS. The OEM key files 943209 as Direct,
 *    so it is matched on the *code* rather than inferred from the key.
 *  - **The window is the whole ledger, and the ledger's key is what makes that safe.**
 *    There used to be a one-month-one-source rule, because two files covering the same
 *    month would otherwise count it twice — but it deduplicated whole *months*, and cost
 *    real tonnage both ways: on 1 August the daily dump stopped covering July while no
 *    archive yet held it, and the trend silently lost 3,344.836 MT, the most recent
 *    complete month, from a six-month view. Deduplication now happens at the line, so a
 *    partial backfill *merges* into a closed month instead of replacing it.
 *  - **Value adds are a property of the SKU as scheduled**, and only the schedule sheet
 *    states them, so a historical line inherits its own material's flags. A material never
 *    scheduled carries neither flag rather than a guess.
 *  - **The table closes on the average, not the total.** A SKU bought in three months of
 *    eight has a three-month rate, and its eight-month total would read as a monthly one.
 *  - **Tonnage answers half the question.** A cut length is ordered in pieces and a long
 *    length by weight, so every figure is carried in both and the tab can switch.
 */

import { pyRound } from "../format.ts";
import { kahanSum, pairwiseSum } from "../numeric.ts";
import { compareNaturalBucket, isNa, normCode, pyStr, toNumber } from "../normalise.ts";
import type { Row } from "../source.ts";
import type { SalesLine, SalesMapping } from "./sales.ts";
import { LONG_LENGTH_MIN_M } from "./stock.ts";

export const MEGH_TVS_CUSTOMER_CODE = "943209";
export const TREND_SEGMENT_DIRECT = "TVSM ancillaries";
export const TREND_SEGMENT_MEGH = "Megh Steel 943209";

export type TrendResult = {
  months: string[];
  buckets: Row[];
  customerSkus: Row[];
  details: Record<string, Row[]>;
};

type TrendLine = SalesLine & {
  segment: string;
  angle_cut: boolean;
  chamfer: boolean;
  length_type: string;
  customer_display: string | null;
  despatch_plant: string | null;
  customer_group: string | null;
};

export function salesTrend(
  sales: SalesMapping,
  scheduleRows: Row[],
  groups: Record<string, unknown>[],
): TrendResult {
  /* ---- the two segments ---------------------------------------------------- */

  const withMonth = sales.all.filter((l) => l.billing_month !== null);

  const segmentOf = (l: SalesLine): string | null => {
    if (l.customer_key === MEGH_TVS_CUSTOMER_CODE) return TREND_SEGMENT_MEGH;
    return l.oem_key_oem === "TVS" ? TREND_SEGMENT_DIRECT : null;
  };

  /* ---- value-add flags, inherited from the schedule ------------------------ */

  const flags = new Map<string, { angle_cut: boolean; chamfer: boolean }>();
  for (const row of scheduleRows) {
    const key = normCode(row["MATERIAL NO"]);
    if (key === null) continue;
    const at = flags.get(key) ?? { angle_cut: false, chamfer: false };
    if (pyStr(row["Angle Cut"] ?? "").trim().toUpperCase() === "AG") at.angle_cut = true;
    if (pyStr(row["Chamferring "] ?? "").trim().toUpperCase().startsWith("CHAM")) {
      at.chamfer = true;
    }
    flags.set(key, at);
  }

  /* ---- which Helper Customer a SAP code belongs to -------------------------- */

  // The sales file writes a ship-to's own spelling, so one customer arrives under several:
  // Rajsriya under six, Sandhar under four — 26 names for about thirteen customers. A
  // selector offering all 26 asks the reader to know which plant they meant.
  const displaysByCode = new Map<string, Set<string>>();
  for (const g of groups) {
    const display = g.customer_display as string | null;
    for (const code of (g.customer_codes as string[]) ?? []) {
      const at = displaysByCode.get(code) ?? new Set<string>();
      if (display !== null) at.add(display);
      displaysByCode.set(code, at);
    }
  }
  // A code used under more than one Helper Customer cannot be resolved and keeps its raw
  // name: guessing which of two customers a shared code belongs to is worse than showing
  // it under the name the sales file actually used.
  const uniqueDisplayByCode = new Map<string, string>();
  for (const [code, displays] of displaysByCode) {
    if (displays.size === 1) uniqueDisplayByCode.set(code, [...displays][0]);
  }

  const trend: TrendLine[] = withMonth
    .map((l) => {
      const segment = segmentOf(l);
      if (segment === null) return null;
      const flag = l.material_key === null ? undefined : flags.get(l.material_key);
      const display = isNa(l["CUSTOMER  NAME"])
        ? null : nullIfNan(pyStr(l["CUSTOMER  NAME"]).trim());
      return {
        ...l,
        segment,
        angle_cut: flag?.angle_cut ?? false,
        chamfer: flag?.chamfer ?? false,
        length_type: (toNumber(l.length_m) ?? 0) >= LONG_LENGTH_MIN_M ? "LL" : "CTL",
        customer_display: display,
        despatch_plant: normCode(l["DESP P LANT"]),
        customer_group: (l.customer_key === null
          ? undefined : uniqueDisplayByCode.get(l.customer_key)) ?? display,
      };
    })
    .filter((l): l is TrendLine => l !== null);

  const months = [...new Set(trend.map((l) => l.billing_month as string))].sort();

  /* ---- table one: bucket by month ------------------------------------------ */

  const bucketed = trend.filter((l) => l.bucket !== null);
  const byBucket = monthMap(bucketed, (l) => [l.bucket as string], (l) => l.sales_mt, 3);
  const byBucketNos = monthMap(bucketed, (l) => [l.bucket as string], (l) => l.sales_nos, 0);

  const details: Record<string, Row[]> = {};
  const buckets: Row[] = [];

  for (const bucket of [...byBucket.keys()].sort(compareNaturalBucket)) {
    const rows = bucketed.filter((l) => l.bucket === bucket);
    const monthsFor = byBucket.get(bucket)!;

    for (const month of monthsFor.keys()) {
      const slice = rows.filter((l) => l.billing_month === month);
      details[`TRENDBUCKET|${bucket}|${month}`] = [...new Set(slice.map((l) => l.segment))]
        .sort()
        .map((segment) => {
          const group = slice.filter((l) => l.segment === segment);
          return {
            source: segment,
            plant: null,
            sku: bucket,
            material_code: joinDistinct(group.map((l) => l.material_key)),
            customer: joinDistinct(group.map((l) => l.customer_display)),
            // `group[...].sum()` inside a groupby loop is `Series.sum()`, so pairwise.
            nos: pyRound(pairwiseSum(group.map((l) => l.sales_nos)), 0),
            qty: pyRound(pairwiseSum(group.map((l) => l.sales_mt)), 3),
            unit: "MT",
          };
        });
    }

    const monthsNos = byBucketNos.get(bucket) ?? new Map<string, number>();
    // `rows.loc[...].sum()` — a Series again, not a grouped aggregate.
    const inSegment = (segment: string, of: (l: TrendLine) => number) =>
      pairwiseSum(rows.filter((l) => l.segment === segment).map(of));

    buckets.push({
      bucket,
      months: Object.fromEntries(monthsFor),
      months_nos: Object.fromEntries(monthsNos),
      total_mt: pyRound(sumValues(monthsFor), 3),
      total_nos: pyRound(sumValues(monthsNos), 0),
      direct_nos: pyRound(inSegment(TREND_SEGMENT_DIRECT, (l) => l.sales_nos), 0),
      megh_nos: pyRound(inSegment(TREND_SEGMENT_MEGH, (l) => l.sales_nos), 0),
      direct_mt: pyRound(inSegment(TREND_SEGMENT_DIRECT, (l) => l.sales_mt), 3),
      megh_mt: pyRound(inSegment(TREND_SEGMENT_MEGH, (l) => l.sales_mt), 3),
    });
  }

  /* ---- table two: one ancillary at a time, its SKUs month by month ---------- */

  const keyed = trend.filter((l) => l.ctl_bucket !== null);
  const skuMonths = monthMap(keyed,
    (l) => [l.customer_display, l.ctl_bucket as string], (l) => l.sales_mt, 3);
  const skuMonthsNos = monthMap(keyed,
    (l) => [l.customer_display, l.ctl_bucket as string], (l) => l.sales_nos, 0);

  const customerSkus: Row[] = groupBy(keyed,
    (l) => [l.customer_display, l.ctl_bucket as string])
    .map(([parts, group]) => {
      const first = group[0];
      const key = monthMapKey(parts);
      const monthsFor = skuMonths.get(key) ?? new Map<string, number>();
      const monthsNos = skuMonthsNos.get(key) ?? new Map<string, number>();
      const totalMt = pyRound(pairwiseSum(group.map((l) => l.sales_mt)), 3);
      const totalNos = pyRound(pairwiseSum(group.map((l) => l.sales_nos)), 0);
      return {
        customer_group: first.customer_group,
        customer: parts[0],
        sku: parts[1],
        bucket: first.bucket,
        length_m: first.length_m === null ? null : pyRound(first.length_m, 3),
        length_type: first.length_type,
        material_codes: joinDistinct(group.map((l) => l.material_key)),
        segment: first.segment,
        months: Object.fromEntries(monthsFor),
        months_nos: Object.fromEntries(monthsNos),
        total_mt: totalMt,
        total_nos: totalNos,
        // The window total is kept because the average is taken off it, but the table
        // closes on the average.
        months_active: monthsFor.size,
        avg_active_month_mt: monthsFor.size ? pyRound(totalMt / monthsFor.size, 3) : null,
        avg_active_month_nos: monthsFor.size ? pyRound(totalNos / monthsFor.size, 0) : null,
      };
    })
    .sort((a, b) =>
      cmp(a.customer_group as string | null, b.customer_group as string | null)
      || cmp(a.customer as string | null, b.customer as string | null)
      || ((b.total_mt as number) - (a.total_mt as number)));

  return { months, buckets, customerSkus, details };
}

/* ---- helpers --------------------------------------------------------------- */

/** `{key: {month: value}}` for a table that runs months across the columns. */
function monthMap<T extends { billing_month: string | null }>(
  rows: T[],
  key: (row: T) => (string | null)[],
  value: (row: T) => number,
  digits: number,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [parts, group] of groupBy(rows, (r) => [...key(r), r.billing_month])) {
    // `key = key[0] if len(key) == 1 else key` — a one-part key is the bare value, not a
    // tuple, so a single-key map is looked up by the value itself.
    const outer = monthMapKey(parts.slice(0, -1));
    const month = parts[parts.length - 1] as string;
    const at = out.get(outer) ?? new Map<string, number>();
    at.set(month, pyRound(kahanSum(group.map(value)), digits));
    out.set(outer, at);
  }
  return out;
}

/** The lookup key for a `month_map`: the bare value where there is one, the tuple otherwise. */
const monthMapKey = (parts: (string | null)[]): string =>
  (parts.length === 1 ? String(parts[0]) : JSON.stringify(parts));

/** `sum(months.values())` — Python's builtin over the month cells, not a pandas sum. */
const sumValues = (map: Map<string, number>): number => pairwiseSum([...map.values()]);

/** Distinct, sorted, comma-joined — or null where there is nothing to join. */
const joinDistinct = (values: (string | null)[]): string | null => {
  const distinct = [...new Set(values.filter((v): v is string => !isNa(v)))].sort();
  return distinct.length ? distinct.join(", ") : null;
};

const nullIfNan = (text: string): string | null => (text === "nan" ? null : text);

const cmp = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
};

/** `groupby([...])` in pandas' sorted order, absent last on each level. */
function groupBy<T>(rows: T[], parts: (row: T) => (string | null)[]): [(string | null)[], T[]][] {
  const groups = new Map<string, [(string | null)[], T[]]>();
  for (const row of rows) {
    const p = parts(row);
    const k = JSON.stringify(p);
    (groups.get(k) ?? groups.set(k, [p, []]).get(k)!)[1].push(row);
  }
  return [...groups.values()].sort((a, b) => {
    for (let i = 0; i < Math.max(a[0].length, b[0].length); i += 1) {
      const r = cmp(a[0][i] ?? null, b[0][i] ?? null);
      if (r !== 0) return r;
    }
    return 0;
  });
}
