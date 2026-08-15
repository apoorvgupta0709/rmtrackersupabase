/**
 * Section 3 — schedule-line facts, joined to sales by customer code and CTL bucket.
 *
 * Ported from `refresh_dashboard.py` L1670–1769. The output feeds the customer tracker, the
 * LL tracker, the mapping queues and the dispatch plan, so it is the third intermediate
 * rather than a section of its own.
 *
 * Four decisions worth not losing:
 *
 *  - **A line with no scheduled quantity is not demand.** The filter is on `> 0`, applied
 *    before anything else, so an empty row cannot reach a group and dilute it.
 *  - **Tonnage is computed when the sheet does not state it**, from the tube's own
 *    geometry: `π · (OD − t) · t · L · 7.85 / 1e6` per piece. The sheet's own figure always
 *    wins where it has one.
 *  - **A missing bucket is recovered from the material code, never invented.** Some schedule
 *    lines carry a code but no Bucket; Bucketting governs that code, so the bucket and its
 *    cut length come from there rather than the demand being dropped. **The sheet's own
 *    value always wins** — recovery only fills a blank.
 *  - **The customer is a *list* of codes, and the list is ordered.** `customer_codes_key`
 *    joins them with a pipe so a group is one customer's whole set, and sales are summed
 *    across all of them. Three shared codes are what once cost Balaji Press Product its
 *    entire history.
 */

import {
  firstUnique, isNa, makeCtlBucket, normBucket, normCode, normText, pyStr, splitCodes,
  toNumber, validBucket,
} from "../normalise.ts";
import type { Row } from "../source.ts";
import type { MaterialDimension } from "./material.ts";
import type { SalesMapping } from "./sales.ts";

/** Density used where the sheet states no tonnage. */
const STEEL_DENSITY = 7.85;

export type ScheduleGroup = {
  OEM: string | null;
  customer_display: string | null;
  customer_codes_key: string;
  bucket: string | null;
  ctl_bucket: string | null;
  uom: string;
  Plant: unknown;
  schedule_qty: number;
  schedule_mt: number | null;
  actual_od: number | null;
  od: number | null;
  inner_d: number | null;
  thickness: number | null;
  ctl_length: number | null;
  material_key: string | null;
  customer_codes: string[];
  sales_qty: number;
  sales_mt: number;
  balance_qty: number;
  balance_mt: number;
  open_balance_mt: number;
  over_dispatch_mt: number;
};

export function scheduleFacts(
  scheduleRows: Row[],
  dimension: MaterialDimension,
  sales: SalesMapping,
  oemMap: Map<string, unknown>,
): ScheduleGroup[] {
  /* ---- per line ----------------------------------------------------------- */

  const lines = scheduleRows
    .map((row) => {
      const scheduleQty = toNumber(row["SCHEDULE in nos"]) ?? 0;

      // Stated tonnage wins; geometry fills the blank.
      const statedMt = toNumber(row["SCHEDULE IN MT"]);
      const actualOd = toNumber(row["ACTUAL OD"]);
      const thickness = toNumber(row["TICKNESS"]);
      const length = toNumber(row["LENGTH"]);
      const derivedMt = (actualOd === null || thickness === null || length === null)
        ? null
        : Math.PI * (actualOd - thickness) * thickness * length
          * STEEL_DENSITY / 1_000_000 * scheduleQty / 1000;

      const customerCodes = splitCodes(row["CUSTOMER CODE"]);

      // The code's own OEM first — read across the whole ledger, so it does not depend on
      // where in the month the refresh runs. Then the helper customer, then the name.
      const fromCodes = firstUnique(customerCodes.map((code) => sales.codeOem.get(code) ?? null));
      const helperKey = normText(row["Helper Customer"]);
      const nameKey = normText(row["CUSTOMER NAME"]);
      const oem = !isNa(fromCodes) ? (fromCodes as string)
        : pick(helperKey === null ? undefined : oemMap.get(helperKey))
          ?? pick(nameKey === null ? undefined : oemMap.get(nameKey));

      const materialKey = normCode(row["MATERIAL NO"]);

      // The sheet's own bucket where it says something, the code's where it does not.
      const ownBucket = normBucket(row["Bucket"]);
      const recovered = materialKey === null
        ? undefined : dimension.materialBucket.get(materialKey);
      const bucket = validBucket(ownBucket) ? ownBucket : (recovered ?? null);

      const ownCtl = normBucket(row["CTL Bucket"]);
      const directCtl = materialKey === null
        ? undefined : dimension.direct.get(materialKey)?.["CTL Bucket"];
      const recoveredCtl = validBucket(directCtl)
        ? (directCtl as string)
        : makeCtlBucket(
          recovered ?? null,
          materialKey === null ? null : dimension.materialLength.get(materialKey) ?? null);
      const ctlBucket = validBucket(ownCtl) ? ownCtl : recoveredCtl;

      return {
        scheduleQty,
        scheduleMt: statedMt ?? derivedMt,
        OEM: oem ?? null,
        customer_display: astypeStr(row["Helper Customer"]).trim(),
        customer_codes: customerCodes,
        customer_codes_key: customerCodes.join("|"),
        bucket,
        ctl_bucket: ctlBucket,
        uom: astypeStr(row["UoM"]).trim().toUpperCase(),
        Plant: row["Plant"],
        material_key: materialKey,
        actual_od: actualOd,
        od: toNumber(row["OD"]),
        inner_d: toNumber(row["ID"]),
        thickness,
        ctl_length: length,
      };
    })
    // Applied after the quantity is read and before anything groups: a line with no
    // scheduled quantity is not demand.
    .filter((line) => line.scheduleQty > 0);

  /* ---- grouped ------------------------------------------------------------ */

  const GROUP_COLS = [
    "OEM", "customer_display", "customer_codes_key", "bucket", "ctl_bucket", "uom", "Plant",
  ] as const;

  const groups = new Map<string, typeof lines>();
  for (const line of lines) {
    const key = JSON.stringify(GROUP_COLS.map((c) => keyOf((line as Record<string, unknown>)[c])));
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(line);
  }

  // `groupby` sorts its keys, level by level, with the absent ones last on each level.
  const ordered = [...groups.entries()].sort((a, b) =>
    compareKeys(JSON.parse(a[0]), JSON.parse(b[0])));

  return ordered.map(([, group]) => {
    const first = group[0];
    const scheduleQty = sum(group.map((l) => l.scheduleQty));
    // `sum` over a column that is entirely absent is 0 in pandas, not null.
    const scheduleMt = sum(group.map((l) => l.scheduleMt ?? 0));
    const customerCodes = first.customer_codes_key.split("|").filter(Boolean);

    // Summed across every one of the customer's codes, for this CTL bucket.
    const salesQty = sumForCodes(sales, customerCodes, first.ctl_bucket,
      first.uom === "M" ? "sales_m" : "sales_nos");
    const salesMt = sumForCodes(sales, customerCodes, first.ctl_bucket, "sales_mt");

    const balanceQty = scheduleQty - salesQty;
    const balanceMt = scheduleMt - salesMt;

    return {
      OEM: first.OEM,
      customer_display: first.customer_display,
      customer_codes_key: first.customer_codes_key,
      bucket: first.bucket,
      ctl_bucket: first.ctl_bucket,
      uom: first.uom,
      Plant: first.Plant,
      schedule_qty: scheduleQty,
      schedule_mt: scheduleMt,
      actual_od: maxOf(group.map((l) => l.actual_od)),
      od: maxOf(group.map((l) => l.od)),
      inner_d: maxOf(group.map((l) => l.inner_d)),
      thickness: maxOf(group.map((l) => l.thickness)),
      ctl_length: maxOf(group.map((l) => l.ctl_length)),
      material_key: (firstUnique(group.map((l) => l.material_key)) ?? null) as string | null,
      customer_codes: customerCodes,
      sales_qty: salesQty,
      sales_mt: salesMt,
      balance_qty: balanceQty,
      balance_mt: balanceMt,
      open_balance_mt: Math.max(balanceMt, 0),
      over_dispatch_mt: Math.max(-balanceMt, 0),
    };
  });
}

/* ---- helpers --------------------------------------------------------------- */

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** `max` skipping absent values; a column that is entirely absent stays absent. */
function maxOf(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return present.length ? Math.max(...present) : null;
}

/**
 * `sum_for_codes` — the customer's whole set of codes, for one CTL bucket.
 *
 * A group with no CTL bucket can match nothing: the lookup is only ever built from lines
 * that had one, so asking is not merely fruitless but would risk colliding with a key
 * whose second half is empty.
 */
function sumForCodes(
  sales: SalesMapping,
  codes: string[],
  ctlBucket: string | null,
  column: "sales_m" | "sales_nos" | "sales_mt",
): number {
  if (ctlBucket === null) return 0;
  let total = 0;
  for (const code of codes) {
    total += sales.salesLookup.get(`${code}|${ctlBucket}`)?.[column] ?? 0;
  }
  return total;
}

const pick = (value: unknown): string | null =>
  isNa(value) ? null : pyStr(value);

/**
 * `Series.astype(str)`, which is not `str()` on the value you think you have.
 *
 * An empty cell in an object column is a float NaN, and `astype(str)` writes it as the
 * *string* `"nan"` — so `helper_customer` and `uom` carry `"nan"` and `"NAN"` for a blank
 * rather than an empty string, and both are grouped on. Rendering them as `""` would merge
 * every blank group into whatever else grouped empty.
 */
const astypeStr = (value: unknown): string =>
  isNa(value) ? "nan" : pyStr(value);

/** A group-key component, with absence distinguishable from any string. */
const keyOf = (value: unknown): string | null =>
  isNa(value) ? null : pyStr(value);

/** Level by level, absent last on each — pandas' `dropna=False` ordering. */
function compareKeys(a: (string | null)[], b: (string | null)[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}
