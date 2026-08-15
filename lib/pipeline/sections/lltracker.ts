/**
 * Section 6 — the TVSM long-length tracker, at bucket level.
 *
 * Ported from `refresh_dashboard.py` L2277–2437. Two demands meet here: TSL's own schedule
 * for OEM TVS, and the RM tracker's `vsm stock` sheet for what TVSM itself requires.
 *
 *  - **The gap nets each side against its own sales, then adds.** Flooring each component
 *    at zero first is what stops TVS over-dispatch from masking a real VSM gap.
 *  - **Coverage is stock over *total* schedule, times 30**, and is null rather than zero
 *    where there is no demand — a bucket nobody has ordered is "No demand", not "Critical".
 *  - **WIP and transit are appended only if not already there.** The `LL|TVS|<bucket>` key
 *    may already carry them from section 5; adding them twice would double the pool.
 */

import {
  compareNaturalBucket, normBucket, normCode, normNumber, normText, normThickness, toNumber,
} from "../normalise.ts";
import type { Row } from "../source.ts";
import { LL_PLANTS } from "./stock.ts";
import type { StockResult } from "./stock.ts";
import type { WipResult } from "./wip.ts";
import type { SalesMapping } from "./sales.ts";

export type LlResult = {
  rows: Row[];
  details: Record<string, Row[]>;
  metricDetails: Record<string, Row[]>;
};

export function llTracker(
  vsmRows: Row[],
  stock: StockResult,
  wip: WipResult,
  sales: SalesMapping,
): LlResult {
  const tvs = wip.group.filter((g) => g.OEM === "TVS");
  const tslSchedule = sumBy(tvs, (g) => g.bucket as string | null, (g) => g.schedule_mt as number);
  const tslOpen = sumBy(tvs, (g) => g.bucket as string | null, (g) => g.open_balance_mt as number);
  const tslSales = sumBy(
    sales.published.filter((l) => l.OEM === "TVS" && l.bucket !== null),
    (l) => l.bucket, (l) => l.sales_mt);

  const llByPlant = new Map<string, number>();
  for (const s of stock.llStock) {
    if (s.pool_oem !== "TVS" || s.bucket === null || s.plant === null) continue;
    const k = `${s.bucket} ${s.plant}`;
    llByPlant.set(k, (llByPlant.get(k) ?? 0) + s.stock_mt);
  }

  /* ---- the TVSM side ------------------------------------------------------- */

  const vsm = vsmRows
    .map((row) => ({
      row,
      bucket: normBucket(row["key"]),
      vsm_schedule_mt: toNumber(row["VSM Requirement"]) ?? 0,
      vsm_sales_mt: toNumber(row["VSM Sales"]) ?? 0,
      vsm_stock_mt: toNumber(row["VSM Stock"]) ?? 0,
    }))
    .filter((v) => v.bucket !== null);

  const vsmSchedule = sumBy(vsm, (v) => v.bucket, (v) => v.vsm_schedule_mt);
  const vsmSales = sumBy(vsm, (v) => v.bucket, (v) => v.vsm_sales_mt);
  const vsmStock = sumBy(vsm, (v) => v.bucket, (v) => v.vsm_stock_mt);

  const vsmDetails = new Map<string, Row[]>();
  for (const bucket of [...new Set(vsm.map((v) => v.bucket as string))].sort()) {
    vsmDetails.set(bucket, vsm
      .filter((v) => v.bucket === bucket && v.vsm_stock_mt > 0)
      .map((v) => {
        const sku = `${normNumber(v.row["O D"]) ?? ""} x `
          + `${normThickness(v.row["Thk."]) ?? ""} `
          + `${normText(v.row["Grade"]) ?? ""}`;
        return {
          source: "RM Tracker TVSM",
          plant: "TVSM",
          sku: sku.trim() || bucket,
          material_code: normCode(v.row["Column1"]),
          qty: v.vsm_stock_mt,
          unit: "MT",
        };
      }));
  }

  /* ---- one row per bucket -------------------------------------------------- */

  const buckets = [...new Set([...tslSchedule.keys(), ...vsmSchedule.keys()])]
    .sort(compareNaturalBucket);

  const details: Record<string, Row[]> = {};
  const metricDetails: Record<string, Row[]> = {};
  const rows: Row[] = [];

  for (const bucket of buckets) {
    const row: Record<string, unknown> = {
      bucket,
      tsl_schedule_mt: tslSchedule.get(bucket) ?? 0,
      tvsm_schedule_mt: vsmSchedule.get(bucket) ?? 0,
      vsm_schedule_mt: vsmSchedule.get(bucket) ?? 0,
      tsl_sales_mt: tslSales.get(bucket) ?? 0,
      vsm_sales_mt: vsmSales.get(bucket) ?? 0,
      tsl_open_schedule_mt: tslOpen.get(bucket) ?? 0,
      vsm_stock_mt: vsmStock.get(bucket) ?? 0,
      shared_wip_mt: wip.wipByBucket.get(bucket) ?? 0,
      transit_mt: wip.transitByBucket.get(bucket) ?? 0,
    };
    for (const plant of LL_PLANTS) {
      row[`ll_stock_${plant}_mt`] = llByPlant.get(`${bucket} ${plant}`) ?? 0;
    }

    const n = (field: string) => row[field] as number;
    row.total_schedule_mt = n("tsl_schedule_mt") + n("vsm_schedule_mt");
    row.total_sales_mt = n("tsl_sales_mt") + n("vsm_sales_mt");
    row.remaining_schedule_mt = Math.max(n("total_schedule_mt") - n("total_sales_mt"), 0);
    // Each side floored at zero *before* they are added.
    row.tvs_gap_mt = Math.max(n("tsl_schedule_mt") - n("tsl_sales_mt"), 0);
    row.vsm_gap_mt = Math.max(n("vsm_schedule_mt") - n("vsm_sales_mt"), 0);
    row.total_gap_mt = n("tvs_gap_mt") + n("vsm_gap_mt");
    row.tsl_ll_stock_mt = LL_PLANTS.reduce((t, p) => t + n(`ll_stock_${p}_mt`), 0);
    row.available_ll_stock_mt = n("tsl_ll_stock_mt") + n("vsm_stock_mt")
      + n("shared_wip_mt") + n("transit_mt");
    row.stock_detail_key = `LLALL|${bucket}`;

    let base = wip.details[`LL|TVS|${bucket}`] ?? [];
    if (!base.some((d) => d.source === "WIP ystockn")) {
      base = [...base, ...(wip.wipDetailByBucket.get(bucket) ?? [])];
    }
    if (!base.some((d) => d.source === "Transit")) {
      base = [...base, ...(wip.transitDetailByBucket.get(bucket) ?? [])];
    }
    details[row.stock_detail_key as string] = [...base, ...(vsmDetails.get(bucket) ?? [])];

    const demandBase = n("total_schedule_mt");
    const coverage = demandBase > 0 ? n("available_ll_stock_mt") / demandBase * 30 : null;
    row.coverage_days = coverage;
    row.coverage_days_excl_wip = coverage;
    row.coverage_days_incl_wip = coverage;
    row.current_month_shortage_mt = Math.max(
      n("remaining_schedule_mt") - n("available_ll_stock_mt"), 0);
    row.gap_to_30_days_mt = Math.max(demandBase - n("available_ll_stock_mt"), 0);
    row.gap_to_45_days_mt = Math.max(demandBase * 1.5 - n("available_ll_stock_mt"), 0);
    row.risk = coverage === null ? "No demand"
      : coverage < 15 ? "Critical"
        : coverage < 30 ? "Low"
          : coverage < 45 ? "Watch" : "Adequate";

    const card = (source: string, plant: string, materialCode: string | null, qty: unknown,
      unit = "MT") => ({ source, plant, sku: bucket, material_code: materialCode, qty, unit });

    const COVERAGE = "stock ÷ schedule × 30";
    const GAP45 = "max(requirement − stock, 0)";
    metricDetails[`LLSCHEDULE|${bucket}`] = [
      card("Schedule July", "TSL", null, row.tsl_schedule_mt),
      card("RM Tracker TVSM", "TVSM", null, row.tvsm_schedule_mt),
    ];
    metricDetails[`LLSALES|${bucket}`] = [
      card("Sales dump", "TSL", null, row.tsl_sales_mt),
      card("RM Tracker TVSM", "TVSM", null, row.vsm_sales_mt),
    ];
    metricDetails[`LLCOVERAGE|${bucket}`] = [
      card("Total stock", "Formula input", COVERAGE, row.available_ll_stock_mt),
      card("Total schedule", "Formula input", COVERAGE, row.total_schedule_mt),
      card("Coverage", "Calculated", COVERAGE, row.coverage_days, "DAYS"),
    ];
    metricDetails[`LLGAP45|${bucket}`] = [
      card("45-day requirement", "Calculated", "schedule × 1.5", demandBase * 1.5),
      card("Total stock", "Formula input", GAP45, row.available_ll_stock_mt),
      card("Gap to 45 days", "Calculated", GAP45, row.gap_to_45_days_mt),
    ];
    metricDetails[`LLGAP|${bucket}`] = [
      card("TVS schedule", "TSL", "Schedule July, OEM TVS", row.tsl_schedule_mt),
      card("TVS sales", "TSL", "less TVS dispatch", row.tsl_sales_mt),
      card("TVS gap", "Calculated", "max(schedule − sales, 0)", row.tvs_gap_mt),
      card("VSM requirement", "TVSM", "RM Tracker TVSM sheet", row.vsm_schedule_mt),
      card("VSM sales", "TVSM", "less VSM dispatch", row.vsm_sales_mt),
      card("VSM gap", "Calculated", "max(requirement − sales, 0)", row.vsm_gap_mt),
      card("Total gap", "Calculated", "TVS gap + VSM gap", row.total_gap_mt),
    ];

    rows.push(row);
  }

  return { rows, details, metricDetails };
}

function sumBy<T>(
  rows: T[],
  key: (row: T) => string | null,
  value: (row: T) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    out.set(k, (out.get(k) ?? 0) + value(row));
  }
  return out;
}
