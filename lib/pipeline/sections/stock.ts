/**
 * Section 4 — current stock, the RFD 4731 reconciliation, and the shared pools.
 *
 * Ported from `refresh_dashboard.py` L1779–2108. It augments the schedule groups with the
 * stock behind them and builds the `CTL|` and `LL|` drill-downs.
 *
 * The decisions that carry real money:
 *
 *  - **CTL inventory has exactly two approved sources**: plant-stock CTL rows from 0789,
 *    and RFD quantity from `rfd_4731` for plant 4731. Nothing else counts as customer CTL.
 *  - **`NOS` at 4731 and 8406 is kilograms wearing the wrong label.** SAP holds those two
 *    locations in weight only, so the column repeats KG on every row: 3910648 showed 6,123
 *    "nos" against 3,000 real pieces in RFD. Flagged rather than published as pieces.
 *  - **A long length is the *union* of two signals.** The CTL/LL flag alone is not enough —
 *    rows carrying a length *range* in the description leave `LENGTH` at 0 while correctly
 *    flagged LL — and both must agree before a row is treated as an exact-length CTL cut.
 *  - **Transit rows carry no owning customer**, so they pool at bucket level rather than
 *    being customer-owned.
 *  - **Stock held by the TVS proxy customer belongs to the TVS pool** even though the OEM
 *    key files it as Direct. Kept as `pool_oem`, separate from `OEM`, so the sales-by-OEM
 *    view keeps reporting the key's own answer.
 *  - **`CTL Code` is blank on a quarter of the RFD rows that carry stock** — 15 of 60
 *    positive rows, 32.293 MT on the 28 July file. Keying the reconciliation on that column
 *    alone makes them invisible, which both hides their stock *and* tells the matching SAP
 *    material to write itself off. The row still names its own size, so the material is
 *    recovered from OD, thickness and cut length against what SAP actually holds at 4731.
 */

import { kahanSum } from "../numeric.ts";
import { pyRound } from "../format.ts";
import {
  descriptionShape, firstUnique, isNa, makeCtlBucket, normCode, normDesc, normNumber,
  normOd, normText, normThickness, pyStr, splitCodes, toNumber, validBucket,
} from "../normalise.ts";
import type { Row } from "../source.ts";
import type { MaterialDimension } from "./material.ts";
import type { ScheduleGroup } from "./schedule.ts";

export const LONG_LENGTH_MIN_M = 3.5;
export const HIGH_AGE_DAYS = 60;
export const TVS_PROXY_CUSTOMER_NAMES = new Set(["MEGH STEELS PRIVATE LIMITED TVS A"]);
export const TRANSIT_CUSTOMER_NAME = "TRANSIT STOCK";

/** The plants a long-length pool is reported for. */
export const LL_PLANTS = ["789", "788", "4731", "8406"] as const;

export type StockResult = {
  group: (ScheduleGroup & Record<string, unknown>)[];
  details: Record<string, Row[]>;
  rfdRecovered: Row[];
  rfdUnrecovered: Row[];
  rfdBackedMaterials: string[];
  /** Long-length rows with no owning customer: a shared, bucket-level pool. */
  transitStock: StockRow[];
  /** Long-length, customer-owned rows — the TVS pool is read off these. */
  llStock: StockRow[];
  /** Every stock row, as section 9 reads them. */
  allStock: StockRow[];
  /** Every RFD row after size recovery, as section 9 reconciles them. */
  rfd: RfdRow[];
};

export type RfdRow = {
  row: Row;
  material_key: string | null;
  bucket: string | null;
  length_m: number | null;
  ctl_bucket: string | null;
  stock_nos: number;
  stock_mt: number;
  backed_materials: string | null;
};

export type StockRow = {
  row: Row;
  material_key: string | null;
  description_key: string | null;
  bucket: string | null;
  length_m: number | null;
  ctl_bucket: string | null;
  plant: string | null;
  stock_mt: number;
  stock_nos: number;
  nos_is_weight: boolean;
  ageing_days: number;
  ageing_days_month_end: number;
  is_high_age: boolean;
  is_long: boolean;
  is_transit: boolean;
  flag: string;
  OEM: string | null;
  customer_name_key: string | null;
  /** TVS-proxy stock counts to the TVS pool even where the OEM key files it Direct. */
  pool_oem: string | null;
  /** Filled in by section 9's reconciliation, which runs after this section. */
  rfd_status?: string | null;
};

export function stockPools(
  stockRows: Row[],
  rfdRows: Row[],
  zmat: Row[],
  scheduleGroup: ScheduleGroup[],
  dimension: MaterialDimension,
  oemMap: Map<string, unknown>,
  asOf: string,
): StockResult {
  /* ---- stock, per row ----------------------------------------------------- */

  const monthEndDays = daysToMonthEnd(asOf);

  const stock = stockRows.map((row) => {
    const materialKey = normCode(row["Material"]);
    const descriptionKey = normDesc(row["Material Description"]);
    const bucket = (materialKey === null ? undefined : dimension.materialBucket.get(materialKey))
      ?? (descriptionKey === null ? undefined : dimension.descriptionBucket.get(descriptionKey))
      ?? null;
    const lengthM = toNumber(row["LENGTH"]);
    const stockNos = toNumber(row["NOS"]) ?? 0;
    const kg = toNumber(row["KG"]) ?? 0;
    const customerNameKey = normText(row["CUSTOMER NAME"]);
    const oemRaw = customerNameKey === null ? undefined : oemMap.get(customerNameKey);
    const oem = isNa(oemRaw) ? null : pyStr(oemRaw);
    const ageing = toNumber(row["Ageing days"]) ?? 0;
    const flag = pyStr(row["CTL/LL"] ?? "").toUpperCase().trim();

    return {
      row,
      material_key: materialKey,
      description_key: descriptionKey,
      bucket,
      length_m: lengthM,
      ctl_bucket: makeCtlBucket(bucket, lengthM),
      stock_nos: stockNos,
      // Rounded to three places on both sides, as the original compares them.
      nos_is_weight: pyRound(stockNos, 3) === pyRound(kg, 3) && stockNos > 0,
      stock_mt: toNumber(row["MT"]) ?? 0,
      plant: normCode(row["Plant"]),
      customer_name_key: customerNameKey,
      OEM: oem,
      pool_oem: customerNameKey !== null && TVS_PROXY_CUSTOMER_NAMES.has(customerNameKey)
        ? "TVS" : oem,
      is_transit: customerNameKey === TRANSIT_CUSTOMER_NAME,
      ageing_days: ageing,
      ageing_days_month_end: ageing + monthEndDays,
      is_high_age: ageing + monthEndDays > HIGH_AGE_DAYS,
      flag,
      // The union: neither signal alone can strand stock.
      is_long: flag === "LL" || (lengthM !== null && lengthM >= LONG_LENGTH_MIN_M),
    };
  });

  const ctlStock = stock.filter((s) =>
    !s.is_long && s.flag === "CTL" && s.ctl_bucket !== null && s.plant === "789" && !s.is_transit);
  const llStock = stock.filter((s) => s.is_long && s.bucket !== null && !s.is_transit);
  const transitStock = stock.filter((s) => s.is_long && s.bucket !== null && s.is_transit);

  const ctlPool789Mt = sumBy(ctlStock, (s) => key2(s.pool_oem, s.ctl_bucket), (s) => s.stock_mt);
  const ctlPool789Nos = sumBy(ctlStock, (s) => key2(s.pool_oem, s.ctl_bucket), (s) => s.stock_nos);
  const llPool = sumBy(llStock, (s) => key3(s.pool_oem, s.bucket, s.plant), (s) => s.stock_mt);

  /* ---- RFD 4731 ----------------------------------------------------------- */

  const rfd = rfdRows.map((row) => {
    // Only all-digit codes: `CTL Code` also holds notes such as `6 M CODE`.
    const codes = splitCodes(row["CTL Code"]).filter((c) => /^\d+$/.test(c));
    const materialKey = codes.find((c) =>
      dimension.materialBucket.has(c) || dimension.direct.has(c)) ?? codes[0] ?? null;

    const directRow = materialKey === null ? undefined : dimension.direct.get(materialKey);
    const bucket = pick(directRow?.Bucket)
      ?? (materialKey === null ? null : pick(dimension.materialBucket.get(materialKey)));

    const rfdLength = toNumber(row["CTL "]);
    const lengthM = toNumber(directRow?.Length)
      ?? (materialKey === null ? null : toNumber(dimension.materialLength.get(materialKey)))
      // Above 10 the column is millimetres.
      ?? (rfdLength === null ? null : (rfdLength <= 10 ? rfdLength : rfdLength / 1000));

    const directCtl = directRow?.["CTL Bucket"];
    const ctlBucket = validBucket(directCtl)
      ? (directCtl as string) : makeCtlBucket(bucket, lengthM);

    return {
      row,
      ctl_codes: codes,
      material_key: materialKey,
      bucket,
      length_m: lengthM,
      ctl_bucket: ctlBucket,
      stock_nos: toNumber(row["RFD Qty."]) ?? 0,
      stock_mt: toNumber(row["WEIGHT"]) ?? 0,
      backed_materials: null as string | null,
    };
  });

  // What SAP actually holds at 4731 as a cut length, indexed by physical size.
  const sap4731 = stock.filter((s) =>
    s.plant === "4731"
    && pyStr(s.row["CTL/LL"] ?? "").trim().toUpperCase() === "CTL"
    && s.material_key !== null);

  const dimensionMaterials = new Map<string, Set<string>>();
  for (const s of sap4731) {
    const shape = descriptionShape(s.row["Material Description"]);
    if (shape === null || s.length_m === null) continue;
    const k = sizeKeyOf(shape[0], shape[1], shape[2], s.length_m);
    (dimensionMaterials.get(k) ?? dimensionMaterials.set(k, new Set()).get(k)!)
      .add(s.material_key!);
  }

  const rfdRecovered: Row[] = [];
  for (const r of rfd) {
    if (r.stock_nos <= 0 || validBucket(r.ctl_bucket)) continue;
    if (r.length_m === null) continue;
    const [outer, inner, thickness] = rfdDimensions(r.row);
    const codes = dimensionMaterials.get(sizeKeyOf(outer, inner, thickness, r.length_m));
    if (!codes || codes.size === 0) continue;

    // Several SAP codes can share a size. They are the same physical cut, so all are
    // backed; the pool takes the bucket only when they agree on one.
    const buckets = new Set([...codes]
      .map((c) => dimension.materialBucket.get(c))
      .filter((b): b is string => b !== undefined && b !== null));
    const sortedCodes = [...codes].sort();
    if (r.material_key === null) r.material_key = sortedCodes[0];
    r.backed_materials = sortedCodes.join("|");
    if (buckets.size === 1) {
      const only = [...buckets][0];
      r.bucket = only;
      r.ctl_bucket = makeCtlBucket(only, r.length_m);
    }
    rfdRecovered.push({
      size: `${outer}x${inner}x${thickness}x${Math.round(r.length_m * 1000)}`,
      listed_code: isNa(r.row["CTL Code"]) ? null : pyStr(r.row["CTL Code"]).trim(),
      length_m: pyRound(r.length_m, 3),
      stock_nos: r.stock_nos,
      stock_mt: pyRound(r.stock_mt, 3),
      materials: sortedCodes,
      bucket: buckets.size === 1 ? [...buckets][0] : null,
    });
  }

  const rfdUnrecovered: Row[] = rfd
    .filter((r) => r.stock_nos > 0 && !validBucket(r.ctl_bucket))
    .map((r) => {
      const [outer, inner, thickness] = rfdDimensions(r.row);
      return {
        size: `${outer}x${inner}x${thickness}`
          + (r.length_m === null ? "" : `x${Math.round(r.length_m * 1000)}`),
        listed_code: isNa(r.row["CTL Code"]) ? null : pyStr(r.row["CTL Code"]).trim(),
        matched_materials: r.backed_materials === null
          ? null : r.backed_materials.replace(/\|/g, ", "),
        length_m: r.length_m === null ? null : pyRound(r.length_m, 3),
        stock_nos: r.stock_nos,
        stock_mt: pyRound(r.stock_mt, 3),
        reason: r.backed_materials !== null
          ? "Matched a 4731 material by size, but no governed bucket agrees"
          : isNa(r.row["CTL Code"])
            ? "No CTL Code and no 4731 cut-length material at this size"
            : "CTL Code reaches no governed bucket and no 4731 material matches this size",
      };
    })
    .sort((a, b) => (b.stock_mt as number) - (a.stock_mt as number));

  const rfdStock = rfd.filter((r) => r.stock_nos > 0 && r.ctl_bucket !== null);
  const rfdPoolNos = sumBy(rfdStock, (r) => r.ctl_bucket!, (r) => r.stock_nos);
  const rfdPoolMt = sumBy(rfdStock, (r) => r.ctl_bucket!, (r) => r.stock_mt);

  // Any 4731 CTL material in SAP with no positive RFD quantity is not physically there.
  // A size-recovered row can back several codes at once, so every match counts.
  const backed = new Set<string>();
  for (const r of rfd) {
    if (r.stock_nos <= 0) continue;
    if (r.material_key !== null) backed.add(r.material_key);
    if (r.backed_materials !== null) {
      for (const c of r.backed_materials.split("|")) backed.add(c);
    }
  }

  /* ---- onto the schedule groups ------------------------------------------- */

  const group = scheduleGroup.map((g) => {
    const out: ScheduleGroup & Record<string, unknown> = { ...g };
    for (const plant of LL_PLANTS) {
      out[`ll_stock_${plant}_mt`] = llPool.get(key3(g.OEM, g.bucket, plant)) ?? 0;
    }
    out.ctl_stock_789_nos = ctlPool789Nos.get(key2(g.OEM, g.ctl_bucket)) ?? 0;
    out.ctl_stock_789_mt = ctlPool789Mt.get(key2(g.OEM, g.ctl_bucket)) ?? 0;
    out.ctl_stock_4731_nos = g.ctl_bucket === null ? 0 : rfdPoolNos.get(g.ctl_bucket) ?? 0;
    out.ctl_stock_4731_mt = g.ctl_bucket === null ? 0 : rfdPoolMt.get(g.ctl_bucket) ?? 0;
    out.ctl_stock_pool_nos = (out.ctl_stock_789_nos as number) + (out.ctl_stock_4731_nos as number);
    out.ctl_stock_pool_mt = (out.ctl_stock_789_mt as number) + (out.ctl_stock_4731_mt as number);
    out.ll_stock_pool_mt = LL_PLANTS.reduce(
      (total, p) => total + (out[`ll_stock_${p}_mt`] as number), 0);
    out.ctl_stock_detail_key = `CTL|${py(g.OEM)}|${py(g.ctl_bucket)}`;
    out.ll_stock_detail_key = `LL|${py(g.OEM)}|${py(g.bucket)}`;
    return out;
  });

  /* ---- the drill-downs ----------------------------------------------------- */

  const details: Record<string, Row[]> = {};

  for (const [k, rows] of groupRows(ctlStock,
    (s) => [s.pool_oem, s.ctl_bucket, s.plant, pick(s.row.Material), pick(s.row["Material Description"])],
    (s) => s.stock_nos)) {
    const [oem, ctlBucket] = k;
    const detailKey = `CTL|${py(oem)}|${py(ctlBucket)}`;
    (details[detailKey] ??= []).push(...rows.map((r) => ({
      source: "Plant stock",
      plant: normCode(r.parts[2]),
      sku: isNa(r.parts[4]) ? null : pyStr(r.parts[4]),
      material_code: normCode(r.parts[3]),
      qty: r.qty,
      unit: "NOS",
    })));
  }

  const materialDescription = new Map<string, string>();
  {
    const byCode = new Map<string, unknown[]>();
    for (const z of zmat) {
      const code = normCode(z["Column1"]);
      if (code === null) continue;
      (byCode.get(code) ?? byCode.set(code, []).get(code)!).push(z["MATERIAL DESCRIPTION"]);
    }
    for (const [code, values] of byCode) {
      const only = firstUnique(values);
      if (!isNa(only)) materialDescription.set(code, pyStr(only));
    }
  }

  const rfdDetailByBucket = new Map<string, Row[]>();
  for (const [k, rows] of groupRows(rfdStock,
    (r) => [r.ctl_bucket, r.material_key, pick(r.row.CUSTOMER), pick(r.row["CTL "])],
    (r) => r.stock_nos)) {
    const bucket = k[0] as string;
    rfdDetailByBucket.set(bucket, rows.map((r) => ({
      source: "RFD 4731",
      plant: "4731",
      sku: (r.parts[1] === null ? undefined : materialDescription.get(r.parts[1] as string))
        || `${r.parts[2] || "Unassigned"} · CTL ${normNumber(r.parts[3]) || "–"}`,
      material_code: r.parts[1],
      qty: r.qty,
      unit: "NOS",
    })));
  }

  // Appended to whatever plant stock already put under the key, for every OEM/bucket pair
  // the schedule actually asks about.
  const seenPairs = new Set<string>();
  for (const g of scheduleGroup) {
    const pair = `${py(g.OEM)} ${py(g.ctl_bucket)}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const detailKey = `CTL|${py(g.OEM)}|${py(g.ctl_bucket)}`;
    const extra = g.ctl_bucket === null ? [] : rfdDetailByBucket.get(g.ctl_bucket) ?? [];
    details[detailKey] = [...(details[detailKey] ?? []), ...extra];
  }

  for (const [k, rows] of groupRows(llStock,
    (s) => [s.pool_oem, s.bucket, s.plant, pick(s.row.Material), pick(s.row["Material Description"])],
    (s) => s.stock_mt)) {
    const [oem, bucket] = k;
    const detailKey = `LL|${py(oem)}|${py(bucket)}`;
    (details[detailKey] ??= []).push(...rows.map((r) => ({
      source: "Plant stock",
      plant: normCode(r.parts[2]),
      sku: isNa(r.parts[4]) ? null : pyStr(r.parts[4]),
      material_code: normCode(r.parts[3]),
      qty: r.qty,
      unit: "MT",
    })));
  }

  return {
    group,
    details,
    rfdRecovered,
    rfdUnrecovered,
    rfdBackedMaterials: [...backed].sort(),
    transitStock,
    llStock,
    allStock: stock,
    rfd,
  };
}

/* ---- helpers --------------------------------------------------------------- */

const py = (value: unknown): string => (value === null || value === undefined ? "None" : String(value));
const pick = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));

const key2 = (a: unknown, b: unknown): string => `${py(a)} ${py(b)}`;
const key3 = (a: unknown, b: unknown, c: unknown): string => `${py(a)} ${py(b)} ${py(c)}`;

function sumBy<T>(rows: T[], key: (row: T) => string, value: (row: T) => number): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const k = key(row);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(value(row));
  }
  // Kahan, because these are groupby sums.
  return new Map([...groups].map(([k, vs]) => [k, kahanSum(vs)]));
}

/**
 * `groupby([...], dropna=False).agg(sum)`, yielding `[outer key parts, rows]` in pandas'
 * sorted order — the same shape the drill-downs are built from.
 */
function groupRows<T>(
  rows: T[],
  parts: (row: T) => (string | null)[],
  value: (row: T) => number,
): [ (string | null)[], { parts: (string | null)[]; qty: number }[] ][] {
  const inner = new Map<string, { parts: (string | null)[]; qty: number }>();
  for (const row of rows) {
    const p = parts(row);
    const k = JSON.stringify(p);
    const at = inner.get(k) ?? { parts: p, qty: 0 };
    at.qty += value(row);
    inner.set(k, at);
  }
  const sorted = [...inner.values()].sort((a, b) => compareParts(a.parts, b.parts));

  const outer = new Map<string, [ (string | null)[], typeof sorted ]>();
  for (const entry of sorted) {
    const head = entry.parts.slice(0, 2);
    const k = JSON.stringify(head);
    const at = outer.get(k) ?? [head, [] as typeof sorted];
    at[1].push(entry);
    outer.set(k, at);
  }
  return [...outer.values()];
}

/** Level by level, absent last on each. */
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

/**
 * OD, ID and thickness of an RFD row.
 *
 * A rectangular row puts its two outer dimensions in `Section` (`40X30`) and leaves `OD`
 * holding the equivalent round diameter, so `Section` is the only place the real size
 * appears. A round row has no second dimension, which the rest of the pipeline writes as 0.
 */
function rfdDimensions(row: Row): [string | null, string | null, string | null] {
  const section = pyStr(row.Section ?? "").trim().split(/[Xx*]/);
  if (section.length === 2) {
    const dim1 = toNumber(section[0]);
    const dim2 = toNumber(section[1]);
    if (dim1 !== null && dim2 !== null && dim1 > 0 && dim2 > 0) {
      return [normOd(dim1), normNumber(dim2), normThickness(row.Thickness)];
    }
  }
  return [normOd(row.OD), normNumber(0), normThickness(row.Thickness)];
}

const sizeKeyOf = (a: unknown, b: unknown, c: unknown, length: number): string =>
  `${String(a)} ${String(b)} ${String(c)} ${pyRound(length, 3)}`;

/** Whole days from `as_of` to the last day of that month. */
function daysToMonthEnd(asOf: string): number {
  const [y, m, d] = asOf.split("-").map(Number);
  const end = Date.UTC(y, m, 0);
  return Math.round((end - Date.UTC(y, m - 1, d)) / 86_400_000);
}
