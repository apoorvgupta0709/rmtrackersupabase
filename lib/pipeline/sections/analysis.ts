/**
 * Section 9 — stock analysis, and the SAP-against-RFD reconciliation behind it.
 *
 * Ported from `refresh_dashboard.py` L2680–3029. An inventory view of the *whole* PLANT
 * STOCKS sheet, deliberately wider than the approved coverage sources the customer and
 * long-length trackers use. Plant is a filter rather than a grouping level, and rows run
 * oldest stock first.
 *
 * The reconciliation is the part that decides what comes off the books:
 *
 *  - **Reconcile on quantity, not on presence.** A material can appear in RFD and still be
 *    overstated in SAP — 3910648 holds 6,123 nos at 4731 against 3,000 in RFD — so calling
 *    the whole line "backed" would leave 3,123 nos on the books that are not there.
 *  - **Compare weight, never the piece count.** SAP holds 4731 in kilograms and repeats
 *    that figure in `NOS`, so piece-for-piece is units against kilograms: the same code is
 *    6.123 MT against 6.321 MT — backed in full, not short by half.
 *  - **One RFD line can name several SAP codes**, so its weight is shared between them in
 *    proportion to what SAP holds. The same physical stock can never back two materials at
 *    once and inflate the covered figure.
 *  - **Matched and unmatched always add back to what SAP holds**, so both columns can be
 *    totalled. Where RFD holds *more* than SAP the excess is stated in words rather than
 *    shown as a negative — there is no SAP tonnage behind it to write off or to keep.
 *  - **The plant test in `rfdSplit` is load-bearing.** The same code is stocked elsewhere,
 *    and keying on the material alone gave an 0789 row 4731's verdict and scaled its
 *    tonnage by 4731's SAP total.
 */

import { pyRound } from "../format.ts";
import { kahanSum, pairwiseSum } from "../numeric.ts";
import { firstUnique, fmtNos, isNa, pyStr, utcDayIso, toUtcDay, validBucket } from "../normalise.ts";
import type { Row } from "../source.ts";
import { HIGH_AGE_DAYS } from "./stock.ts";
import type { StockResult, StockRow } from "./stock.ts";
import type { WipResult } from "./wip.ts";

export type AnalysisResult = {
  stockAnalysis: { ctl: Row[]; ll: Row[]; source_coverage: Row[] };
  details: Record<string, Row[]>;
  stockUnmapped: Row[];
  /** Headline tallies the QC summary carries. */
  rfdUnbackedMt: number;
  rfdUnbackedMaterials: number;
  rfdPartlyBackedMaterials: number;
};

type Reconciliation = {
  verdict: string;
  explanation: string;
  sap_mt: number;
  rfd_mt: number;
  matched_mt: number;
  unmatched_mt: number;
};

export function stockAnalysis(
  stock: StockResult,
  wip: WipResult,
  asOf: string,
): AnalysisResult {
  const rows = stock.allStock;

  /* ---- SAP against RFD, per 4731 CTL material ----------------------------- */

  const is4731Ctl = (s: StockRow) =>
    s.plant === "4731" && pyStr(s.row["CTL/LL"] ?? "").trim().toUpperCase() === "CTL";

  const sapMt = new Map<string, number>();
  for (const s of rows.filter(is4731Ctl)) {
    if (s.material_key === null) continue;
    sapMt.set(s.material_key, (sapMt.get(s.material_key) ?? 0) + s.stock_mt);
  }

  const rfdMtByMaterial = new Map<string, number>();
  const rfdNosByMaterial = new Map<string, number>();
  const shared = new Set<string>();

  for (const r of stock.rfd.filter((x) => x.stock_nos > 0)) {
    const listed = r.backed_materials !== null
      ? r.backed_materials.split("|")
      : (r.material_key !== null ? [r.material_key] : []);
    const codes = listed.filter((c) => sapMt.has(c));
    if (codes.length === 0) continue;
    if (codes.length > 1) for (const c of codes) shared.add(c);

    const weights = new Map(codes.map((c) => [c, sapMt.get(c) ?? 0]));
    const total = [...weights.values()].reduce((a, b) => a + b, 0);
    for (const code of codes) {
      // With no weight anywhere to go on, split evenly rather than dropping it.
      const share = total > 0 ? (weights.get(code) ?? 0) / total : 1 / codes.length;
      rfdMtByMaterial.set(code, (rfdMtByMaterial.get(code) ?? 0) + r.stock_mt * share);
      rfdNosByMaterial.set(code, (rfdNosByMaterial.get(code) ?? 0) + r.stock_nos * share);
    }
  }

  const reconcile = (material: string): Reconciliation => {
    const sap = sapMt.get(material) ?? 0;
    const rfd = rfdMtByMaterial.get(material) ?? 0;
    const nos = rfdNosByMaterial.get(material) ?? 0;
    const note = shared.has(material) ? " (RFD line shared with another code)" : "";
    const matched = Math.min(sap, rfd);
    const gap = sap - rfd;

    let verdict: string;
    let explanation: string;
    if (rfd <= 0) {
      verdict = "Not in RFD";
      explanation = `RFD holds nothing against this code - write off ${f3(sap)} MT${note}`;
    } else if (gap > 0.01) {
      // Weights run to the kilogram, so under 10 kg is rounding, not a shortfall.
      verdict = "Short in RFD";
      explanation = `RFD backs ${f3(rfd)} of ${f3(sap)} MT `
        + `(${fmtNos(nos)} nos) - write off ${f3(gap)} MT${note}`;
    } else if (gap < -0.01) {
      verdict = "RFD holds more";
      explanation = `Fully backed - RFD holds ${f3(rfd)} MT (${fmtNos(nos)} nos) `
        + `against ${f3(sap)} MT in SAP, ${f3(-gap)} MT more than SAP shows${note}`;
    } else {
      verdict = "Match";
      explanation = `SAP and RFD agree - ${f3(sap)} MT (${fmtNos(nos)} nos)${note}`;
    }
    return {
      verdict, explanation, sap_mt: sap, rfd_mt: rfd,
      matched_mt: matched, unmatched_mt: Math.max(sap - matched, 0),
    };
  };

  const byMaterial = new Map<string, Reconciliation>();
  for (const material of sapMt.keys()) byMaterial.set(material, reconcile(material));

  // Written onto the rows the analysis then groups.
  for (const s of rows) {
    s.rfd_status = is4731Ctl(s) && s.material_key !== null
      ? byMaterial.get(s.material_key)?.explanation ?? null
      : null;
  }

  let rfdUnbackedMt = 0;
  let rfdUnbackedMaterials = 0;
  let rfdPartlyBackedMaterials = 0;
  for (const [material, sap] of sapMt) {
    const rfd = rfdMtByMaterial.get(material) ?? 0;
    const gap = Math.max(0, sap - rfd);
    if (gap <= 0.01) continue;
    rfdUnbackedMaterials += 1;
    rfdUnbackedMt += gap;
    if (rfd > 0) rfdPartlyBackedMaterials += 1;
  }

  /* ---- the analysis rows --------------------------------------------------- */

  const asOfDay = toUtcDay(asOf)!;
  const details: Record<string, Row[]> = {};

  /** A row's share of its material's reconciliation — blank where none applies. */
  const rfdSplit = (plant: string | null, material: string | null, rowMt: number): Row => {
    const entry = plant === "4731" && material !== null ? byMaterial.get(material) : undefined;
    if (entry === undefined) {
      return {
        rfd_verdict: null, rfd_explanation: null,
        rfd_matched_mt: null, rfd_unmatched_mt: null,
      };
    }
    const share = entry.sap_mt ? rowMt / entry.sap_mt : 0;
    return {
      rfd_verdict: entry.verdict,
      rfd_explanation: entry.explanation,
      rfd_matched_mt: pyRound(entry.matched_mt * share, 3),
      rfd_unmatched_mt: pyRound(entry.unmatched_mt * share, 3),
    };
  };

  const build = (frame: StockRow[], prefix: string): Row[] => {
    const grouped = groupBy(frame, (s) => [
      s.plant, s.material_key, pick(s.row["Material Description"]), pick(s.row["CUSTOMER NAME"]),
    ]);

    const aggregated = grouped.map(([parts, group]) => ({
      parts,
      group,
      stock_mt: sum(group.map((s) => s.stock_mt)),
      stock_nos: sum(group.map((s) => s.stock_nos)),
      // `all` over the flag: a group is weight-labelled only if every row is.
      nos_is_weight: group.every((s) => s.nos_is_weight),
      batches: new Set(group.map((s) => s.row.BATCH).filter((b) => !isNa(b))).size,
      high_age_mt: sum(group.map((s) => (s.is_high_age ? s.stock_mt : 0))),
      // The ageing distribution, banded on the same month-end ageing the high-age
      // judgment uses so the bands and the verdict can never disagree. Same Kahan sums
      // as every other tonnage here.
      age_0_30_mt: sum(group.map((s) => (s.ageing_days_month_end <= 30 ? s.stock_mt : 0))),
      age_31_60_mt: sum(group.map((s) =>
        (s.ageing_days_month_end > 30 && s.ageing_days_month_end <= 60 ? s.stock_mt : 0))),
      age_61_180_mt: sum(group.map((s) =>
        (s.ageing_days_month_end > 60 && s.ageing_days_month_end <= 180 ? s.stock_mt : 0))),
      age_over_180_mt: sum(group.map((s) => (s.ageing_days_month_end > 180 ? s.stock_mt : 0))),
      oldest_age: Math.max(...group.map((s) => s.ageing_days_month_end)),
      rfd_status: firstUnique(group.map((s) => s.rfd_status ?? null)),
    }));

    // Oldest first, then largest. Stable, so equal pairs keep the grouping's order.
    aggregated.sort((a, b) => (b.oldest_age - a.oldest_age) || (b.stock_mt - a.stock_mt));

    return aggregated.map((agg) => {
      const [plant, material, description, holder] = agg.parts;
      const holderLabel = holder === null ? "Unassigned" : holder;
      const detailKey = `${prefix}|${py(plant)}|${py(material)}|${holderLabel.replace(/\|/g, "/")}`;

      const batchRows = groupBy(agg.group, (s) => [pick(s.row.BATCH), pick(s.row["CUSTOMER NAME"])])
        .map(([parts, group]) => ({
          parts,
          qty: sum(group.map((s) => s.stock_mt)),
          age_me: Math.max(...group.map((s) => s.ageing_days_month_end)),
          age_now: Math.max(...group.map((s) => s.ageing_days)),
        }))
        .sort((a, b) => b.age_me - a.age_me)
        .map((d) => ({
          batch: d.parts[0],
          plant,
          material_code: material,
          description,
          holder: d.parts[1],
          // The date the stock reached its current age.
          ageing_date: utcDayIso(asOfDay - Math.trunc(d.age_now)),
          age_days: Math.trunc(d.age_now),
          age_days_month_end: Math.trunc(d.age_me),
          qty: d.qty,
          unit: "MT",
        }));

      details[detailKey] = batchRows;
      details[`${detailKey}|HIGHAGE`] = batchRows.filter(
        (r) => (r.age_days_month_end as number) > HIGH_AGE_DAYS);

      return {
        plant,
        material_code: material,
        description,
        holder: holderLabel,
        stock_mt: pyRound(agg.stock_mt, 3),
        // Suppressed where the column is kilograms wearing the wrong label.
        stock_nos: agg.nos_is_weight ? null : agg.stock_nos,
        batches: agg.batches,
        high_age_mt: pyRound(agg.high_age_mt, 3),
        age_0_30_mt: pyRound(agg.age_0_30_mt, 3),
        age_31_60_mt: pyRound(agg.age_31_60_mt, 3),
        age_61_180_mt: pyRound(agg.age_61_180_mt, 3),
        age_over_180_mt: pyRound(agg.age_over_180_mt, 3),
        oldest_age_days: Math.trunc(agg.oldest_age),
        rfd_status: isNa(agg.rfd_status) ? null : pyStr(agg.rfd_status),
        // Allocated across a material's rows in proportion to what each holds: repeating
        // the material total on every row would double it in the column subtotal the
        // moment one code is held for two customers.
        ...rfdSplit(plant, material, agg.stock_mt),
        high_age_detail_key: `${detailKey}|HIGHAGE`,
        detail_key: detailKey,
      };
    });
  };

  /* ---- what the coverage views cannot see ---------------------------------- */

  const stockUnmapped: Row[] = groupBy(
    rows.filter((s) => s.bucket === null && s.stock_mt > 0),
    (s) => [s.material_key, pick(s.row["Material Description"]), s.plant,
      pick(s.row["CUSTOMER NAME"]), s.is_long ? "LL" : "CTL"])
    .map(([parts, group]) => ({
      material_code: parts[0],
      description: parts[1],
      plant: parts[2],
      holder: parts[3],
      length_type: parts[4],
      // Kept unrounded for the sort and rounded only on the way out — the aggregate is
      // what pandas orders on, and 0.365585 sorts below 0.366 while both *print* 0.366.
      raw_mt: sum(group.map((s) => s.stock_mt)),
      batches: new Set(group.map((s) => s.row.BATCH).filter((b) => !isNa(b))).size,
    }))
    .sort((a, b) => b.raw_mt - a.raw_mt)
    .map(({ raw_mt, ...rest }) => ({ ...rest, stock_mt: pyRound(raw_mt, 3) }));

  const rfdPositive = stock.rfd.filter((r) => r.stock_nos > 0);
  const positiveStock = rows.filter((s) => s.stock_mt > 0);
  const unmappedStock = rows.filter((s) => s.bucket === null && s.stock_mt > 0);
  const positiveWip = wip.wipRows.filter((w) => w.wip_mt > 0);
  const unmappedWip = wip.wipRows.filter((w) => w.bucket === null && w.wip_mt > 0);
  const unmappedRfd = rfdPositive.filter((r) => !validBucket(r.ctl_bucket));

  // These are `Series.sum()` over the whole frame, not groupby aggregates, so they take
  // numpy's pairwise reduction rather than the Kahan one above.
  const sourceCoverage: Row[] = [
    ["PLANT STOCKS", "stock.xlsx", pairwiseSum(positiveStock.map((s) => s.stock_mt)),
      pairwiseSum(unmappedStock.map((s) => s.stock_mt)), positiveStock.length,
      unmappedStock.length, "SRCGAP|stock"],
    ["WIP ystockn", "wip.xlsx", pairwiseSum(positiveWip.map((w) => w.wip_mt)),
      pairwiseSum(unmappedWip.map((w) => w.wip_mt)), positiveWip.length,
      unmappedWip.length, "SRCGAP|wip"],
    ["RFD 4731", "rfd_4731.xlsx", pairwiseSum(rfdPositive.map((r) => r.stock_mt)),
      pairwiseSum(unmappedRfd.map((r) => r.stock_mt)), rfdPositive.length,
      unmappedRfd.length, "SRCGAP|rfd"],
  ].map(([source, file, totalMt, unmappedMt, rowsTotal, rowsUnmapped, key]) => ({
    source,
    file,
    rows: rowsTotal,
    unmapped_rows: rowsUnmapped,
    total_mt: pyRound(totalMt as number, 3),
    mapped_mt: pyRound((totalMt as number) - (unmappedMt as number), 3),
    unmapped_mt: pyRound(unmappedMt as number, 3),
    unmapped_pct: totalMt
      ? pyRound(100 * (unmappedMt as number) / (totalMt as number), 2) : 0,
    detail_key: key,
  }));

  details["SRCGAP|stock"] = stockUnmapped.map((r) => ({
    source: `${r.length_type} · ${r.holder || "no customer"}`,
    plant: r.plant,
    sku: r.description,
    material_code: r.material_code,
    qty: r.stock_mt,
    unit: "MT",
  }));
  details["SRCGAP|wip"] = wip.wipUnmapped.map((r) => ({
    source: r.reason || "No governed bucket",
    plant: r.plant,
    sku: r.description,
    material_code: r.material_code,
    qty: r.wip_mt,
    unit: "MT",
  }));
  details["SRCGAP|rfd"] = stock.rfdUnrecovered.map((r) => ({
    source: r.reason,
    plant: "4731",
    sku: r.size,
    material_code: r.listed_code,
    qty: r.stock_mt,
    unit: "MT",
  }));

  return {
    stockAnalysis: {
      ctl: build(positiveStock.filter((s) => !s.is_long), "STOCKCTL"),
      ll: build(positiveStock.filter((s) => s.is_long), "STOCKLL"),
      source_coverage: sourceCoverage,
    },
    details,
    stockUnmapped,
    rfdUnbackedMt,
    rfdUnbackedMaterials,
    rfdPartlyBackedMaterials,
  };
}

/* ---- helpers --------------------------------------------------------------- */

const sum = kahanSum;

const pick = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));
const py = (value: unknown): string =>
  (value === null || value === undefined ? "None" : String(value));

/** `f"{x:.3f}"` — rounded half-to-even first, then rendered. */
const f3 = (value: number): string => pyRound(value, 3).toFixed(3);

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
