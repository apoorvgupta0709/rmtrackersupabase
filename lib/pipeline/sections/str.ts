/**
 * Section 13 — the stock transfer plan for Hosur EPA (8406).
 *
 * Ported from `refresh_dashboard.py` L4180–4597. 8406 is an external processing agent for
 * the Hosur ancillary cluster: it receives tube from the sending plants and cuts it to the
 * customer's lengths on site.
 *
 *  - **Cover is held at bucket level, and the plan is stated per bucket rather than per
 *    customer**, because a single STR line serves whichever plan customer draws on it first.
 *    That is also why long lengths already standing at 8406 count towards it.
 *  - **Everything on the road counts**, because a line in transit will be on the ground
 *    before the fifteen days are out.
 *  - **The transfer dump is authoritative for what is inbound.** PLANT STOCKS books the same
 *    pipeline at the receiving plant, so the two overlap almost completely at batch level —
 *    40 of 41 transit batches at 8406 on the 27 July set — and only the batches the transfer
 *    dump does not already carry are added, or the tonnage doubles.
 *  - **An ambiguous customer code can never move stock into the plan.** The schedule names a
 *    customer by Helper Customer and the dumps name it by SAP code, so the two are bridged
 *    through the sales dump — and any code the schedule uses under more than one Helper
 *    Customer is dropped rather than guessed.
 *  - **The allocation offers long lengths first, finished goods before mother tubes, and the
 *    largest holding first inside each**, so the plan asks for as few STR lines as it can and
 *    asks for the most usable stock first. 8406 cuts to order, so a long length serves any of
 *    the customer's lengths while a cut length only serves its own.
 */

import { pyRound } from "../format.ts";
import { kahanSum, pairwiseSum } from "../numeric.ts";
import { compareNaturalBucket, isNa, normCode, pyStr, utcDayIso, toUtcDay, validBucket } from "../normalise.ts";
import type { Row } from "../source.ts";
import type { MaterialDimension } from "./material.ts";
import type { SalesMapping } from "./sales.ts";
import type { StockResult, StockRow } from "./stock.ts";
import type { WipResult } from "./wip.ts";
import type { TransfersResult } from "./transfers.ts";
import { LONG_LENGTH_MIN_M } from "./stock.ts";

export const STR_DESTINATION_PLANT = "8406";
export const STR_SOURCE_PLANTS = ["789", "788", "4731"] as const;
/** Days of forward cover the plan holds at the destination plant. */
export const STR_TARGET_DAYS = 15;
export const STR_CUSTOMERS = [
  "NMPL",
  "Rajsriya Automotive Hosur",
  "Rajsriya Automotive Mysore",
  "SANDHAR Hosur",
  "SANDHAR Mysore",
] as const;

export type StrResult = {
  rows: Row[];
  details: Record<string, Row[]>;
  unmappedDestStock: Row[];
  unbucketed: Row[];
  wipUnresolved: Row[];
};

type SourceLine = {
  plant: string | null;
  plant_label: string | null;
  material_code: string | null;
  description: string | null;
  holder: string | null;
  source: string;
  remark: string;
  from_wip: boolean;
  is_long: boolean;
  qty: number;
  str_qty: number;
};

export function strPlan(
  groups: Record<string, unknown>[],
  stock: StockResult,
  wip: WipResult,
  transfers: TransfersResult,
  sales: SalesMapping,
  dimension: MaterialDimension,
  fgCodeForMotherTube: (descriptionKey: string | null, plant: string | null, bucket: string | null)
    => [string | null, string | null],
  plantLabel: (code: string | null) => string | null,
  asOf: string,
): StrResult {
  /* ---- bridging the schedule's names to the dumps' codes ------------------- */

  const displayByCode = new Map<string, string | null>();
  const ambiguous = new Set<string>();
  for (const g of groups) {
    for (const code of (g.customer_codes as string[]) ?? []) {
      if (!displayByCode.has(code)) displayByCode.set(code, g.customer_display as string | null);
      else if (displayByCode.get(code) !== g.customer_display) ambiguous.add(code);
    }
  }
  for (const code of ambiguous) displayByCode.delete(code);

  // `dict(zip(...))` — a repeated name keeps the last code the sales dump gives it.
  const codeByCustomerName = new Map<string, string>();
  for (const line of sales.published) {
    if (line.customer_name_key === null || line.customer_key === null) continue;
    codeByCustomerName.set(line.customer_name_key, line.customer_key);
  }

  const planCustomers = new Set<string>(STR_CUSTOMERS);

  /* ---- what is already at the destination --------------------------------- */

  const destStock = stock.allStock
    .filter((s) => s.plant === STR_DESTINATION_PLANT && s.stock_mt > 0)
    .map((s) => {
      const code = s.customer_name_key === null
        ? null : codeByCustomerName.get(s.customer_name_key) ?? null;
      return { ...s, customer_code: code, plan_customer: code === null ? null : displayByCode.get(code) ?? null };
    });

  const unmappedDestStock: Row[] = groupBy(
    destStock.filter((s) => s.plan_customer === null && !s.is_transit),
    (s) => [pick(s.row["CUSTOMER NAME"]), s.customer_code])
    .map(([parts, group]) => ({
      customer_name: parts[0],
      customer_code: parts[1],
      raw_mt: kahanSum(group.map((s) => s.stock_mt)),
    }))
    .sort((a, b) => b.raw_mt - a.raw_mt)
    .map(({ raw_mt, ...rest }) => ({ ...rest, stock_mt: pyRound(raw_mt, 3) }));

  const destOwned = destStock.filter((s) =>
    s.plan_customer !== null && planCustomers.has(s.plan_customer));
  const destOwnedPool = sumBy(destOwned, (s) => s.bucket, (s) => s.stock_mt);

  const inbound = transfers.available
    ? transfers.lines.filter((l) => l.dest_plant === STR_DESTINATION_PLANT && l.in_transit)
    : [];
  const inboundTransit = sumBy(inbound, (l) => l.bucket, (l) => l.qty_mt);

  // Only the transit batches the transfer dump does not already carry — see the note above.
  const inboundBatches = new Set(inbound
    .map((l) => l.row.BATCH).filter((b) => !isNa(b)).map((b) => pyStr(b)));
  const destTransitRows = destStock.filter((s) =>
    s.is_transit && !inboundBatches.has(pyStr(s.row.BATCH)));
  const destTransitPool = sumBy(destTransitRows, (s) => s.bucket, (s) => s.stock_mt);

  /* ---- what the sending plants could raise an STR on ----------------------- */

  const sourceAvailability = new Map<string, SourceLine[]>();
  const wipUnresolved: Row[] = [];

  const sourceStock = stock.allStock.filter((s) =>
    (STR_SOURCE_PLANTS as readonly string[]).includes(s.plant ?? "")
    && s.stock_mt > 0 && !s.is_transit && s.bucket !== null);

  for (const [parts, group] of groupBy(sourceStock, (s) => [
    s.bucket, s.plant, s.material_key, pick(s.row["Material Description"]),
    pick(s.row["CUSTOMER NAME"]),
    // The same union rule as the stock view: the flag alone strands rows whose description
    // carries a length range and leaves LENGTH at zero.
    (s.flag === "LL" || (s.length_m !== null && s.length_m >= LONG_LENGTH_MIN_M)) ? "True" : "False",
  ])) {
    const isLong = parts[5] === "True";
    push(sourceAvailability, parts[0] as string, {
      plant: parts[1],
      plant_label: plantLabel(parts[1]),
      material_code: parts[2],
      description: parts[3],
      holder: parts[4],
      source: "Plant stock",
      remark: isLong ? "" : "Cut length only",
      from_wip: false,
      is_long: isLong,
      qty: pyRound(kahanSum(group.map((s) => s.stock_mt)), 3),
      str_qty: 0,
    });
  }

  // A mother tube cannot be transferred under its own PTM code, so it is offered under the
  // finished-goods code that shares its description, carrying a remark saying where it came
  // from.
  const wipSource = wip.wipRows.filter((w) =>
    w.bucket !== null && w.wip_mt > 0
    && (STR_SOURCE_PLANTS as readonly string[]).includes(normCode(w.row.Plant) ?? ""));

  for (const [parts, group] of groupBy(wipSource, (w) => [
    w.bucket, normCode(w.row.Plant), w.description_key, pick(w.row["Material Description"]),
  ])) {
    const qty = pyRound(kahanSum(group.map((w) => w.wip_mt)), 3);
    const [fgCode, fgDescription] = fgCodeForMotherTube(parts[2], parts[1], parts[0]);
    if (fgCode === null) {
      wipUnresolved.push({
        plant: parts[1], bucket: parts[0], description: parts[3], wip_mt: qty,
      });
      continue;
    }
    push(sourceAvailability, parts[0] as string, {
      plant: parts[1],
      plant_label: plantLabel(parts[1]),
      material_code: fgCode,
      description: fgDescription,
      holder: null,
      source: "WIP ystockn",
      remark: `From WIP: ${parts[3]}`,
      from_wip: true,
      is_long: true,
      qty,
      str_qty: 0,
    });
  }

  // Long lengths first, finished goods before mother tubes, largest holding first.
  for (const lines of sourceAvailability.values()) {
    lines.sort((a, b) =>
      Number(!a.is_long) - Number(!b.is_long)
      || Number(a.from_wip) - Number(b.from_wip)
      || (b.qty - a.qty)
      || cmp(a.material_code ?? "", b.material_code ?? ""));
  }

  /* ---- the plan, per bucket ------------------------------------------------ */

  const daysInMonth = daysInMonthOf(asOf);
  const planScope = groups.filter((g) =>
    planCustomers.has(g.customer_display as string));

  const unbucketed: Row[] = groupBy(
    planScope.filter((g) => !validBucket(g.bucket)),
    (g) => [g.customer_display as string | null])
    .map(([parts, group]) => ({
      customer: parts[0],
      raw_mt: kahanSum(group.map((g) => g.schedule_mt as number)),
      lines: group.length,
    }))
    .sort((a, b) => b.raw_mt - a.raw_mt)
    .map(({ raw_mt, ...rest }) => ({
      customer: rest.customer, schedule_mt: pyRound(raw_mt, 3), lines: rest.lines,
    }));

  const planLines = groupBy(
    planScope.filter((g) => validBucket(g.bucket)),
    (g) => [g.bucket as string | null])
    .map(([parts, group]) => ({
      bucket: parts[0],
      schedule_mt: kahanSum(group.map((g) => g.schedule_mt as number)),
      sales_mt: kahanSum(group.map((g) => g.sales_mt as number)),
      open_balance_mt: kahanSum(group.map((g) => g.open_balance_mt as number)),
      cut_lengths: [...new Set(group
        .map((g) => g.ctl_length as number | null)
        .filter((v): v is number => v !== null && v > 0)
        .map((v) => pyRound(v, 3)))].sort((a, b) => a - b),
      customers: [...new Set(group.map((g) => g.customer_display as string))].sort(),
    }));

  // Buckets the plan customers hold at 8406 but have no schedule against.
  const scheduled = new Set(planLines.map((l) => l.bucket));
  for (const bucket of destOwnedPool.keys()) {
    if (bucket !== null && !scheduled.has(bucket)) {
      planLines.push({
        bucket, schedule_mt: 0, sales_mt: 0, open_balance_mt: 0,
        cut_lengths: [], customers: [],
      });
    }
  }

  const details: Record<string, Row[]> = {};
  const rows: Row[] = [];
  const asOfDay = toUtcDay(asOf)!;

  for (const line of planLines) {
    const bucket = line.bucket;
    const scheduleMt = line.schedule_mt;
    const dailyMt = daysInMonth ? scheduleMt / daysInMonth : 0;
    const requirementMt = STR_TARGET_DAYS * dailyMt;
    const ownedMt = (bucket === null ? 0 : destOwnedPool.get(bucket)) ?? 0;
    const transitMt = ((bucket === null ? 0 : inboundTransit.get(bucket)) ?? 0)
      + ((bucket === null ? 0 : destTransitPool.get(bucket)) ?? 0);
    const atDest = ownedMt + transitMt;
    if (scheduleMt <= 0 && atDest <= 0) continue;

    const coverageDays = dailyMt > 0 ? atDest / dailyMt : null;
    const requiredMt = Math.max(0, requirementMt - atDest);

    /* ---- the waterfall --------------------------------------------------- */

    const available = (bucket === null ? [] : sourceAvailability.get(bucket)) ?? [];
    let outstanding = requiredMt;
    const strLines: SourceLine[] = available.map((source) => {
      // Drained largest-ready-holding first. Once the requirement is met every remaining
      // line still appears, allocated nothing — the plan shows what it *could* have drawn
      // on as well as what it asks for.
      const take = outstanding > 0 ? Math.min(source.qty, outstanding) : 0;
      outstanding = Math.max(0, outstanding - take);
      return { ...source, str_qty: pyRound(take, 3) };
    });
    const sourceMt = pairwiseSum(available.map((l) => l.qty));

    /* ---- the drill-downs -------------------------------------------------- */

    const destKey = `STRDEST|${bucket}`;
    details[destKey] = groupBy(
      destOwned.filter((s) => s.bucket === bucket),
      (s) => [pick(s.row.BATCH), s.material_key, pick(s.row["Material Description"]),
        pick(s.row["CUSTOMER NAME"])])
      .map(([parts, group]) => ({
        parts,
        qty: kahanSum(group.map((s) => s.stock_mt)),
        age_now: Math.max(...group.map((s) => s.ageing_days)),
        age_me: Math.max(...group.map((s) => s.ageing_days_month_end)),
      }))
      .sort((a, b) => b.qty - a.qty)
      .map((d) => ({
        batch: d.parts[0],
        plant: STR_DESTINATION_PLANT,
        material_code: d.parts[1],
        description: d.parts[2],
        holder: d.parts[3],
        ageing_date: utcDayIso(asOfDay - Math.trunc(d.age_now)),
        age_days: Math.trunc(d.age_now),
        age_days_month_end: Math.trunc(d.age_me),
        qty: d.qty,
        unit: "MT",
      }));

    if (transfers.available && inbound.length > 0) {
      details[destKey].push(...groupBy(
        inbound.filter((l) => l.bucket === bucket),
        (l) => [pick(l.row.BATCH), l.source_plant, l.document, l.material_key])
        .map(([parts, group]) => ({ parts, qty: kahanSum(group.map((l) => l.qty_mt)) }))
        .sort((a, b) => b.qty - a.qty)
        .map((d) => ({
          batch: d.parts[0],
          plant: d.parts[1],
          material_code: d.parts[3],
          description: d.parts[2],
          holder: "In transit to 8406",
          ageing_date: null,
          age_days: null,
          age_days_month_end: null,
          qty: d.qty,
          unit: "MT",
        })));
    }

    details[destKey].push(...groupBy(
      destTransitRows.filter((s) => s.bucket === bucket),
      (s) => [pick(s.row.BATCH), s.material_key, pick(s.row["Material Description"])])
      .map(([parts, group]) => ({ parts, qty: kahanSum(group.map((s) => s.stock_mt)) }))
      .sort((a, b) => b.qty - a.qty)
      .map((d) => ({
        batch: d.parts[0],
        plant: STR_DESTINATION_PLANT,
        material_code: d.parts[1],
        description: d.parts[2],
        holder: "In transit, no matching transfer line",
        ageing_date: null,
        age_days: null,
        age_days_month_end: null,
        qty: d.qty,
        unit: "MT",
      })));

    const sourceDetail = (lines: SourceLine[]): Row[] => lines.map((l) => ({
      plant: l.plant,
      material_code: l.material_code,
      description: l.description,
      holder: l.holder,
      source: l.source,
      remark: l.remark,
      str_qty: l.str_qty,
      qty: l.qty,
      unit: "MT",
    }));

    const sourceKey = `STRSOURCE|${bucket}`;
    details[sourceKey] = sourceDetail(strLines);

    // Each sending plant on its own, because an STR is raised on one plant and a planner
    // needs to see which of the three can actually supply the gap.
    const sourceByPlant: Record<string, Row> = {};
    for (const plant of STR_SOURCE_PLANTS) {
      const plantLines = strLines.filter((l) => l.plant === plant);
      const plantKey = `STRSOURCE|${bucket}|${plant}`;
      details[plantKey] = sourceDetail(plantLines);
      sourceByPlant[plant] = {
        stock_mt: pyRound(pairwiseSum(plantLines.map((l) => l.qty)), 3),
        str_qty_mt: pyRound(pairwiseSum(plantLines.map((l) => l.str_qty)), 3),
        detail_key: plantKey,
      };
    }

    const risk = coverageDays === null ? "No schedule"
      : coverageDays < STR_TARGET_DAYS ? "Short"
        : coverageDays < 2 * STR_TARGET_DAYS ? "Watch" : "Covered";

    rows.push({
      bucket,
      customers: line.customers,
      cut_lengths: line.cut_lengths,
      schedule_mt: pyRound(scheduleMt, 3),
      sales_mt: pyRound(line.sales_mt, 3),
      balance_mt: pyRound(line.open_balance_mt, 3),
      daily_mt: pyRound(dailyMt, 4),
      requirement_mt: pyRound(requirementMt, 3),
      owned_8406_mt: pyRound(ownedMt, 3),
      in_transit_mt: pyRound(transitMt, 3),
      stock_8406_mt: pyRound(atDest, 3),
      coverage_days: coverageDays === null ? null : pyRound(coverageDays, 1),
      str_required_mt: pyRound(requiredMt, 3),
      str_allocated_mt: pyRound(pairwiseSum(strLines.map((l) => l.str_qty)), 3),
      str_shortfall_mt: pyRound(outstanding, 3),
      source_stock_mt: pyRound(sourceMt, 3),
      source_plants: [...STR_SOURCE_PLANTS],
      source_by_plant: sourceByPlant,
      risk,
      stock_detail_key: destKey,
      source_detail_key: sourceKey,
      str_lines: strLines.filter((l) => l.str_qty > 0).map((l) => ({
        plant: l.plant,
        plant_label: l.plant_label,
        material_code: l.material_code,
        description: l.description,
        source: l.source,
        remark: l.remark,
        from_wip: l.from_wip,
        available_mt: l.qty,
        qty_mt: l.str_qty,
      })),
    });
  }

  rows.sort((a, b) =>
    ((b.str_required_mt as number) - (a.str_required_mt as number))
    || compareNaturalBucket(a.bucket, b.bucket));
  wipUnresolved.sort((a, b) => (b.wip_mt as number) - (a.wip_mt as number));

  return { rows, details, unmappedDestStock, unbucketed, wipUnresolved };
}

/* ---- helpers --------------------------------------------------------------- */

const pick = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));

const cmp = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  (map.get(key) ?? map.set(key, []).get(key)!).push(value);
}

function sumBy<T>(
  rows: T[],
  key: (row: T) => string | null,
  value: (row: T) => number,
): Map<string | null, number> {
  const groups = new Map<string | null, number[]>();
  for (const row of rows) {
    const k = key(row);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(value(row));
  }
  return new Map([...groups].map(([k, vs]) => [k, kahanSum(vs)]));
}

/** Days in the month `as_of` falls in — `month_end.day`. */
function daysInMonthOf(asOf: string): number {
  const [y, m] = asOf.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
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
