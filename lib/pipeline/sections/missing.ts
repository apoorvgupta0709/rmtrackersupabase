/**
 * Section 8 — the two mapping queues, and the sales-order resolution that completes the
 * customer tracker.
 *
 * Ported from `refresh_dashboard.py` L2500–2662.
 *
 *  - **Every scheduled line that reaches no governed bucket is queued, wherever it came
 *    from.** This covered only the supplement at first, so when the owner's workbook
 *    started carrying all the customers the queue silently emptied — the rows were still
 *    unmapped, just no longer looked at.
 *  - **A queue entry that names neither a bucket nor a description is a blank line**, so
 *    the size is written out from whatever dimensions the row does carry.
 *  - **The schedule tonnage used is the *computed* column, not the sheet's own.** A row
 *    whose tonnage the sheet leaves to a formula would otherwise report to the queue as 0 MT.
 *
 * `resolveSo` is the four-level cascade, and **`customer_codes` is an ordered list whose
 * order is the specificity**. Most specific evidence first: this customer's own invoice of
 * this exact material code, then this customer's invoice of the same size, then anyone's
 * invoice of the code, then anyone's of the size. Joining on a single code loses the
 * preference and yields a plausible wrong SO number.
 */

import { fmtG } from "../format.ts";
import { kahanSum } from "../numeric.ts";
import { isNa, normCode, pyStr, toNumber } from "../normalise.ts";
import type { Row } from "../source.ts";
import type { SalesMapping, SoValue } from "./sales.ts";
import { scheduleBuckets } from "./schedule.ts";
import type { MaterialDimension } from "./material.ts";

/** What a size reads as when the row carries nothing to build one from. */
export const LOOKUP_ERROR = "lookup error";

export type MissingResult = {
  missingMappings: Row[];
  /** The schedule groups with their sales order resolved — the customer tracker's rows. */
  group: Record<string, unknown>[];
};

export function missingMappings(
  scheduleRows: Row[],
  groups: Record<string, unknown>[],
  sales: SalesMapping,
  dimension: MaterialDimension,
  scheduleSheet: string,
): MissingResult {
  const rows: Row[] = [];

  /**
   * One queue entry per distinct customer and material, with the tonnage behind it.
   *
   * `astype(str).replace("nan", "")` on the two text columns: a blank arrives as a float
   * NaN and would otherwise read as the string `"nan"` in a column somebody has to act on.
   */
  const addMissing = (
    frame: Row[],
    mappingType: string,
    source: string,
    customerCode: string,
    customer: string,
    materialCode: string,
    description: string,
    reason: string,
    qty?: (row: Row) => number,
  ) => {
    if (frame.length === 0) return;
    const working = frame.map((row) => ({
      _customer_code: customerCode ? normCode(row[customerCode]) : null,
      _customer: customer ? blank(row[customer]) : "",
      _material_code: materialCode ? normCode(row[materialCode]) : null,
      _description: description ? blank(row[description]) : "",
      _qty_mt: qty ? qty(row) : 0,
    }));

    for (const [parts, group] of groupBy(working,
      (w) => [w._customer_code, w._customer, w._material_code, w._description])) {
      rows.push({
        mapping_type: mappingType,
        source,
        customer_code: parts[0],
        customer: parts[1],
        material_code: parts[2],
        description: parts[3],
        reason,
        affected_mt: kahanSum(group.map((w) => w._qty_mt)),
      });
    }
  };

  /* ---- from the sales dump ------------------------------------------------- */

  const transactions = sales.published.filter((l) => l.customer_key !== null);

  // TVSM's own scope: the OEM key's direct answer, plus 943209, which it files as Direct
  // but which supplies TVS.
  const inTvsmScope = (l: (typeof transactions)[number]) =>
    l.oem_key_oem === "TVS" || l.customer_key === "943209";

  addMissing(
    transactions.filter((l) => l.bucket === null && inTvsmScope(l)),
    "Material", "sales.xlsx", "CUSTOMER  CD", "CUSTOMER  NAME",
    "MATERAIL NUMBER", "Material   Description",
    "TVSM/943209 material code has no governed bucket",
    (row) => (toNumber(row["Quantity"]) ?? 0) * 0.001,
  );

  addMissing(
    transactions.filter((l) => l.oem_key_oem === null),
    "Customer", "sales.xlsx", "CUSTOMER  CD", "CUSTOMER  NAME",
    "", "", "Customer code/name is absent from OEM_key_1_rev codes",
    (row) => (row as { sales_mt: number }).sales_mt,
  );

  /* ---- from the schedule --------------------------------------------------- */

  const scheduled = scheduleRows.filter((r) => (toNumber(r["SCHEDULE in nos"]) ?? 0) > 0);

  // The same bucket recovery section 3 applies, so a line queued here is one neither the
  // sheet nor Bucketting could place.
  const unmapped = scheduled
    .filter((row) => scheduleBuckets(row, dimension).bucket === null)
    .map((row) => ({ ...row, "MATERIAL DES": scheduledSize(row) }));

  addMissing(
    unmapped,
    "Schedule", scheduleSheet, "CUSTOMER CODE", "Helper Customer",
    "MATERIAL NO", "MATERIAL DES",
    "Scheduled size has no governed bucket in Bucketting",
    (row) => scheduleMtOf(row),
  );

  // Ordered on the aggregate: `mapping_type` ascending, tonnage descending.
  const missing = [...rows].sort((a, b) => {
    const t = String(a.mapping_type).localeCompare(String(b.mapping_type));
    return t !== 0 ? t : (b.affected_mt as number) - (a.affected_mt as number);
  });

  /* ---- the sales order behind each schedule group -------------------------- */

  const resolveSo = (g: Record<string, unknown>) => {
    const ctl = g.ctl_bucket as string | null;
    const material = g.material_key as string | null;
    const codes = g.customer_codes as string[];

    // Most specific first, and the code order is the specificity.
    if (material) {
      for (const code of codes) {
        const hit = sales.soByCustomerMaterial.get(`${code}|${material}`);
        if (hit) return so(hit, "same customer and material code");
      }
    }
    for (const code of codes) {
      const hit = sales.soByCustomerCtl.get(`${code}|${ctl ?? ""}`);
      if (hit) return so(hit, "same customer and material");
    }
    if (material) {
      const hit = sales.soByMaterial.get(material);
      if (hit) return so(hit, "same material code");
    }
    const hit = ctl === null ? undefined : sales.soByCtl.get(ctl);
    if (hit) return so(hit, "same material");
    return { so_number: null, dispatch_plant: null, so_material: null, so_source: null };
  };

  const resolved: Record<string, unknown>[] = groups.map((g) => ({ ...g, ...resolveSo(g) }));

  // The schedule names its plant by location while the dispatch plan quotes a code. Learn
  // the mapping from the lines whose SO resolved, so a line with no prior invoice still
  // quotes a code rather than a location name.
  const locationPlant = new Map<string, string>();
  for (const [parts, group] of groupBy(
    resolved.filter((g) => g.dispatch_plant !== null),
    (g) => [asKey(g.Plant)])) {
    // `value_counts().idxmax()` — most frequent, and the first of any tie in the order the
    // values were first seen.
    const counts = new Map<string, number>();
    for (const g of group) {
      const v = g.dispatch_plant as string;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = -1;
    for (const [value, count] of counts) {
      if (count > bestCount) { best = value; bestCount = count; }
    }
    if (parts[0] !== null && best !== null) locationPlant.set(parts[0], best);
  }

  const group = resolved.map((g) => ({
    ...g,
    dispatch_plant: g.dispatch_plant
      ?? (isNa(g.Plant) ? null : locationPlant.get(pyStr(g.Plant)) ?? null),
  }));

  return { missingMappings: missing, group };
}

/* ---- helpers --------------------------------------------------------------- */

const so = (hit: SoValue, source: string) => ({
  so_number: hit[0], dispatch_plant: hit[1], so_material: hit[2], so_source: source,
});

/** `astype(str).replace("nan", "")` — a blank cell as an empty string, not `"nan"`. */
const blank = (value: unknown): string => {
  const text = isNa(value) ? "nan" : pyStr(value);
  return text === "nan" ? "" : text;
};

const asKey = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));

/** The size a queued schedule row reads as. */
function scheduledSize(row: Row): string {
  const stated = pyStr(row["MATERIAL DES"] ?? "").trim();
  if (stated && stated.toLowerCase() !== "nan") return stated;

  const od = toNumber(row["ACTUAL OD"]);
  const inner = toNumber(row["ID"]);
  const thk = toNumber(row["TICKNESS"]);
  const length = toNumber(row["LENGTH"]);
  if (od === null || thk === null || length === null) return LOOKUP_ERROR;

  const face = inner === null || inner === 0 ? fmtG(od) : `${fmtG(od)} x ${fmtG(inner)}`;
  const grade = pyStr(row["Grade"] ?? "").trim();
  return `${face} x ${fmtG(thk)} x ${fmtG(length)} mm`
    + (grade && grade.toLowerCase() !== "nan" ? ` ${grade}` : "");
}

/** Section 3's tonnage: the sheet's own figure, or the tube's geometry where it has none. */
function scheduleMtOf(row: Row): number {
  const stated = toNumber(row["SCHEDULE IN MT"]);
  if (stated !== null) return stated;
  const qty = toNumber(row["SCHEDULE in nos"]) ?? 0;
  const od = toNumber(row["ACTUAL OD"]);
  const thk = toNumber(row["TICKNESS"]);
  const length = toNumber(row["LENGTH"]);
  if (od === null || thk === null || length === null) return 0;
  return Math.PI * (od - thk) * thk * length * 7.85 / 1_000_000 * qty / 1000;
}

/** `groupby([...], dropna=False)` in pandas' sorted order, absent last on each level. */
function groupBy<T>(rows: T[], parts: (row: T) => (string | null)[]): [(string | null)[], T[]][] {
  const groups = new Map<string, [(string | null)[], T[]]>();
  for (const row of rows) {
    const p = parts(row);
    const k = JSON.stringify(p);
    (groups.get(k) ?? groups.set(k, [p, []]).get(k)!)[1].push(row);
  }
  return [...groups.values()].sort((a, b) => {
    for (let i = 0; i < Math.max(a[0].length, b[0].length); i += 1) {
      const x = a[0][i] ?? null;
      const y = b[0][i] ?? null;
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? -1 : 1;
    }
    return 0;
  });
}
