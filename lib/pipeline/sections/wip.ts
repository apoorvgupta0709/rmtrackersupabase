/**
 * Section 5 — WIP as a shared long-length source, plus the customer summary.
 *
 * Ported from `refresh_dashboard.py` L2122–2263.
 *
 *  - **The dump ends with a plant subtotal and a grand total**, both carrying no material
 *    code and each repeating the file's entire tonnage. Dropped before anything else, or
 *    they treble the apparent WIP.
 *  - **The code is trusted only where it does not contradict the description.** A material
 *    code whose governed bucket disagrees with its own description cannot be relied on —
 *    the dump reuses one code across physically different materials — so the description
 *    maps first and the code fills the gap only when the two agree.
 *  - **Every unresolved row says *why*,** so the queue is actionable rather than a list.
 *  - **Pool columns are not summed on the customer summary.** They are a max visible pool
 *    and require allocation before they become customer-owned stock; summing them would
 *    count one physical pile once per customer that can see it.
 */

import { kahanSum } from "../numeric.ts";
import { pyRound } from "../format.ts";
import {
  compareNaturalBucket, firstUnique, isNa, normCode, normDesc, pyStr, shapeMatchesBucket,
  toNumber, validBucket,
} from "../normalise.ts";
import type { Row } from "../source.ts";
import type { MaterialDimension } from "./material.ts";
import type { StockResult } from "./stock.ts";

export type WipResult = {
  group: Record<string, unknown>[];
  details: Record<string, Row[]>;
  wipUnmapped: Row[];
  governedBuckets: string[];
  customerSummary: Row[];
  /** Read again by the LL tracker, which appends them under its own key. */
  wipByBucket: Map<string, number>;
  transitByBucket: Map<string, number>;
  wipDetailByBucket: Map<string, Row[]>;
  transitDetailByBucket: Map<string, Row[]>;
  /** Every WIP row, for section 9's source-coverage tally. */
  wipRows: { bucket: string | null; wip_mt: number }[];
};

export function wipAndSummary(
  wipRows: Row[],
  bucketting: Row[],
  stock: StockResult,
  dimension: MaterialDimension,
): WipResult {
  /* ---- WIP, per row -------------------------------------------------------- */

  const wip = wipRows
    // The subtotal and grand total carry no material code. Dropped first, or they treble.
    .filter((row) => !isNa(row["Material No"]))
    .map((row) => {
      const materialKey = normCode(row["Material No"]);
      const descriptionKey = normDesc(row["Material Description"]);
      const codeBucket = (materialKey === null
        ? undefined : dimension.materialBucket.get(materialKey)) ?? null;
      const fromDescription = (descriptionKey === null
        ? undefined : dimension.descriptionBucket.get(descriptionKey)) ?? null;

      const codeTrusted = shapeMatchesBucket(row["Material Description"], codeBucket);
      const bucket = codeBucket ?? fromDescription ?? (codeTrusted ? codeBucket : null);

      const lengthM = (descriptionKey === null
        ? undefined : dimension.descriptionLength.get(descriptionKey))
        ?? (materialKey === null ? undefined : dimension.materialLength.get(materialKey))
        ?? null;

      return {
        row,
        material_key: materialKey,
        description_key: descriptionKey,
        code_bucket: codeBucket,
        code_trusted: codeTrusted,
        bucket,
        length_m: toNumber(lengthM),
        wip_mt: (toNumber(row["Total Stock"]) ?? 0) / 1000,
        unmapped_reason: bucket !== null ? null
          : (codeBucket !== null && !codeTrusted
            ? "Code bucket contradicts the description"
            : "No governed mapping for code or description"),
      };
    });

  /* ---- the unresolved queue ------------------------------------------------ */

  const unmappedGroups = groupBy(
    wip.filter((w) => w.bucket === null && w.wip_mt > 0),
    (w) => [w.material_key, pick(w.row["Material Description"]), pick(w.row.Plant),
      w.code_bucket, w.unmapped_reason]);

  const wipUnmapped: Row[] = unmappedGroups
    .map(([parts, rows]) => ({
      material_code: parts[0],
      description: parts[1],
      plant: normCode(parts[2]),
      wip_mt: pyRound(sum(rows.map((r) => r.wip_mt)), 3),
      batches: new Set(rows.map((r) => r.row.Batch)).size,
      code_bucket: parts[3],
      reason: parts[4],
    }))
    // Stable, so equal tonnages keep the grouping's own order.
    .sort((a, b) => (b.wip_mt as number) - (a.wip_mt as number));

  /* ---- the buckets a reader may assign against ----------------------------- */

  const governedBuckets = [...new Set(bucketting
    .map((r) => r["Bucket"])
    .filter((b) => !isNa(b) && validBucket(b))
    .map((b) => pyStr(b)))]
    .sort(compareNaturalBucket);

  /* ---- onto the schedule groups -------------------------------------------- */

  const wipByBucket = sumBy(wip.filter((w) => w.bucket !== null), (w) => w.bucket!, (w) => w.wip_mt);
  const transitByBucket = sumBy(stock.transitStock, (s) => s.bucket!, (s) => s.stock_mt);

  const group = stock.group.map((g) => {
    const sharedWip = g.bucket === null ? 0 : wipByBucket.get(g.bucket) ?? 0;
    const sharedTransit = g.bucket === null ? 0 : transitByBucket.get(g.bucket) ?? 0;
    return {
      ...g,
      shared_wip_mt: sharedWip,
      shared_transit_mt: sharedTransit,
      ll_stock_pool_mt: (g.ll_stock_pool_mt as number) + sharedWip + sharedTransit,
    };
  });

  /* ---- appended to the LL drill-downs -------------------------------------- */

  const details: Record<string, Row[]> = { ...stock.details };

  const wipDetailByBucket = detailsByBucket(
    wip.filter((w) => w.bucket !== null && w.wip_mt > 0),
    (w) => [w.bucket, pick(w.row.Plant), w.material_key, pick(w.row["Material Description"])],
    (w) => w.wip_mt,
    (parts, qty) => ({
      source: "WIP ystockn",
      plant: normCode(parts[1]),
      sku: parts[3],
      material_code: parts[2],
      qty,
      unit: "MT",
    }));

  const transitDetailByBucket = detailsByBucket(
    stock.transitStock.filter((s) => s.stock_mt > 0),
    (s) => [s.bucket, s.plant, s.material_key, pick(s.row["Material Description"])],
    (s) => s.stock_mt,
    (parts, qty) => ({
      // The transit rows keep the plant as the group held it, not re-normalised.
      source: "Transit",
      plant: parts[1],
      sku: parts[3],
      material_code: parts[2],
      qty,
      unit: "MT",
    }));

  const seen = new Set<string>();
  for (const g of stock.group) {
    const pair = `${py(g.OEM)} ${py(g.bucket)}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const key = `LL|${py(g.OEM)}|${py(g.bucket)}`;
    details[key] = [
      ...(details[key] ?? []),
      ...(g.bucket === null ? [] : wipDetailByBucket.get(g.bucket) ?? []),
      ...(g.bucket === null ? [] : transitDetailByBucket.get(g.bucket) ?? []),
    ];
  }

  /* ---- the customer summary ------------------------------------------------ */

  const customerSummary: Row[] = groupBy(
    group as Record<string, unknown>[],
    (g) => [asKey(g.OEM), asKey(g.customer_display)])
    .map(([parts, rows]) => ({
      OEM: parts[0],
      customer_display: parts[1],
      schedule_mt: sum(rows.map((r) => r.schedule_mt as number)),
      sales_mt: sum(rows.map((r) => r.sales_mt as number)),
      balance_mt: sum(rows.map((r) => r.balance_mt as number)),
      open_balance_mt: sum(rows.map((r) => r.open_balance_mt as number)),
      over_dispatch_mt: sum(rows.map((r) => r.over_dispatch_mt as number)),
      // Named `_do_not_sum` and taken as a max, because one physical pile is visible to
      // several customers and adding it up would count it once each.
      ctl_stock_pool_nos_do_not_sum: maxOf(rows.map((r) => r.ctl_stock_pool_nos as number)),
      ctl_stock_pool_mt_do_not_sum: maxOf(rows.map((r) => r.ctl_stock_pool_mt as number)),
      ll_stock_pool_mt_do_not_sum: maxOf(rows.map((r) => r.ll_stock_pool_mt as number)),
      shared_wip_mt_do_not_sum: maxOf(rows.map((r) => r.shared_wip_mt as number)),
      shared_transit_mt_do_not_sum: maxOf(rows.map((r) => r.shared_transit_mt as number)),
      schedule_lines: rows.length,
      unresolved_sales_lines: rows.filter((r) => (r.sales_mt as number) === 0).length,
    }));

  return {
    group, details, wipUnmapped, governedBuckets, customerSummary,
    wipByBucket, transitByBucket, wipDetailByBucket, transitDetailByBucket,
    wipRows: wip,
  };
}

/* ---- helpers --------------------------------------------------------------- */

const sum = kahanSum;
const maxOf = (values: number[]): number | null => {
  const present = values.filter((v) => Number.isFinite(v));
  return present.length ? Math.max(...present) : null;
};
const pick = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));
const asKey = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));
const py = (value: unknown): string =>
  (value === null || value === undefined ? "None" : String(value));

function sumBy<T>(rows: T[], key: (r: T) => string, value: (r: T) => number): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const k = key(row);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(value(row));
  }
  // Kahan, because these are groupby sums.
  return new Map([...groups].map(([k, vs]) => [k, kahanSum(vs)]));
}

/** `groupby([...], dropna=False)` in pandas' sorted order, absent last on each level. */
function groupBy<T>(rows: T[], parts: (row: T) => (string | null)[]): [(string | null)[], T[]][] {
  const groups = new Map<string, [(string | null)[], T[]]>();
  for (const row of rows) {
    const p = parts(row);
    const k = JSON.stringify(p);
    (groups.get(k) ?? groups.set(k, [p, []]).get(k)!)[1].push(row);
  }
  return [...groups.values()].sort((a, b) => compareParts(a[0], b[0]));
}

function detailsByBucket<T>(
  rows: T[],
  parts: (row: T) => (string | null)[],
  value: (row: T) => number,
  render: (parts: (string | null)[], qty: number) => Row,
): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const [p, group] of groupBy(rows, parts)) {
    const bucket = p[0] as string;
    (out.get(bucket) ?? out.set(bucket, []).get(bucket)!)
      .push(render(p, sum(group.map(value))));
  }
  return out;
}

function compareParts(a: (string | null)[], b: (string | null)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}
