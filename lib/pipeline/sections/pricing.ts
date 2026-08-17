/**
 * Section 14 — SKU pricing off the customer contract.
 *
 * Ported from `refresh_dashboard.py` L4600–4905. Every scheduled SKU is priced as a base
 * price for its size plus the value-added operations it carries.
 *
 * **The join is the size key.** The contract names a size by `Key` —
 * `dimension1-dimension2-thickness`, second dimension empty for a round tube — which is the
 * same shape as the first three parts of a governed Bucket. That is what makes the contract
 * addressable from the schedule at all.
 *
 * `contractRowForSize` is the four-stage narrowing, and it is more than a dictionary lookup
 * for two reasons the original names: **a drawn CEW line states its bore where the contract
 * states nothing**, and **a 38.1 ERW 2 has no `-HST` row so it prices off the plain one**.
 * Each stage keeps its previous candidates when narrowing would empty them — the
 * `filtered or candidates` idiom — so a filter can prefer but never eliminate.
 *
 * Two precision decisions that a customer's own reconciliation is checked against:
 *
 *  - **`kg_per_m` to six decimals, not four.** The contract quotes a weight like 5.269825
 *    and it multiplies a rate in thousands, so a fourth-decimal truncation shows up in the
 *    paisa. The column renders to two either way.
 *  - **The base is published, not recovered.** The browser reprices a corrected SKU from it,
 *    and a base recovered by subtracting the operations back out of the total is out by up
 *    to a hundredth of a paisa — enough to make the page and the build disagree.
 *
 * And **the owner's correction overrides the flags rather than filling in where they are
 * silent**: every SKU where this view disagreed with a customer's reconciliation was a case
 * where the flags said something and it was wrong, so a fallback would have corrected none.
 */

import { fmtG, pyRound } from "../format.ts";
import { kahanSum, pairwiseSum } from "../numeric.ts";
import {
  compareNaturalBucket, isNa, normBucket, normCode, pyStr, pyStrFloat, sizeKey, toNumber,
  validBucket,
} from "../normalise.ts";
import type { Row } from "../source.ts";
import { LONG_LENGTH_MIN_M } from "./stock.ts";
import type { ScheduleLine } from "./schedule.ts";

export const PRICING_QUARTERS = ["Q3 FY26", "Q4 FY26", "Q1 FY27"] as const;

/** Value-added operations, in INR per tonne. */
export const PRICING_OPERATION_RATES: Record<string, number> = {
  "Angle cut": 200,
  "Chamferring": 700,
  "Fin cut": 250,
  "Annealing ERW": 1000,
  "Annealing CEW": 1250,
};

/** How far a stated bore may sit from `dim1 - 2t` and still be the same round size. */
export const PRICING_BORE_TOLERANCE_MM = 0.6;

/** Where each contract sheet keeps what, by column offset — it has no header row. */
export const PRICING_SHEETS = {
  ERW: {
    typeCol: 0, keyCol: 6, weightCol: 7,
    quarters: { "Q3 FY26": [66, 67], "Q4 FY26": [69, 70], "Q1 FY27": [72, 73] },
  },
  CEW: {
    typeCol: 1, keyCol: 8, weightCol: 9,
    quarters: { "Q3 FY26": [62, 63], "Q4 FY26": [65, 66], "Q1 FY27": [68, 69] },
  },
} as const;

type ContractRow = {
  route: string;
  contract_type: string;
  key: string;
  variant: string | null;
  kg_per_m: number | null;
  prices: Record<string, { per_ton: number | null; per_m: number | null; delta: number | null }>;
};

export type PricingResult = {
  rows: Row[];
  unpriced: Row[];
  details: Record<string, Row[]>;
  corrections: number;
  available: boolean;
  note: string | null;
};

/* ---- the contract index ---------------------------------------------------- */

export function contractIndex(
  grids: Record<string, unknown[][]>,
): Map<string, ContractRow[]> {
  const index = new Map<string, ContractRow[]>();

  for (const [route, spec] of Object.entries(PRICING_SHEETS)) {
    const grid = grids[route];
    if (!grid || grid.length === 0) continue;

    // Rows 0-2 are the three header bands: quarter group, sub-group, column name.
    for (const row of grid.slice(3)) {
      const parsed = sizeKey(row[spec.keyCol]);
      if (parsed === null) continue;
      const [dim1, dim2, thickness, parts] = parsed;

      const prices: ContractRow["prices"] = {};
      for (const [quarter, [tonCol, metreCol]] of Object.entries(spec.quarters)) {
        // The quarter's increase sits immediately left of its per-tonne price on both
        // sheets, and is read rather than inferred by subtracting one quarter from
        // another — which would be wrong wherever a correction column sits between.
        prices[quarter] = {
          per_ton: toNumber(row[tonCol]),
          per_m: toNumber(row[metreCol]),
          delta: toNumber(row[tonCol - 1]),
        };
      }
      if (!Object.values(prices).some((p) => p.per_m !== null)) continue;

      const key = sizeIndexKey(dim1, dim2, thickness);
      (index.get(key) ?? index.set(key, []).get(key)!).push({
        route,
        contract_type: pyStr(row[spec.typeCol] ?? "").trim().toUpperCase(),
        key: pyStr(row[spec.keyCol] ?? "").trim(),
        // `-HST` and `-ST` mark the high-strength and structural variants of a size that
        // also has a plain row.
        variant: parts.slice(3).join("-").trim().toUpperCase() || null,
        kg_per_m: toNumber(row[spec.weightCol]),
        prices,
      });
    }
  }
  return index;
}

/** The contract row that prices a size, and how it was reached. */
export function contractRowForSize(
  index: Map<string, ContractRow[]>,
  dim1: number,
  dim2: number,
  thickness: number,
  grade: string | null,
): [ContractRow | null, string | null] {
  const wanted = (grade ?? "").trim().toUpperCase();
  let candidates = index.get(sizeIndexKey(dim1, dim2, thickness));
  let via = "size";

  if ((!candidates || candidates.length === 0) && dim2
    && Math.abs(dim1 - 2 * thickness - dim2) <= PRICING_BORE_TOLERANCE_MM) {
    // A drawn tube's bucket names its bore where the contract names nothing, so a bucket
    // whose second dimension is the bore prices off the round key.
    candidates = index.get(sizeIndexKey(dim1, 0, thickness));
    via = "size, bore ignored";
  }
  if (!candidates || candidates.length === 0) return [null, null];

  // Each stage prefers, and keeps what it had when preferring would leave nothing.
  const route = wanted.startsWith("CEW") ? "CEW" : "ERW";
  let scoped = keepOrAll(candidates, (c) => c.route === route);

  const wantedStkm = wanted.includes("STKM");
  scoped = keepOrAll(scoped, (c) => c.contract_type.includes("STKM") === wantedStkm);

  // The contract's high-strength band is headed "High strength / HST 370/ERW2", so ERW 2
  // is priced off the HST variant wherever the size has one.
  const wantedHst = wanted.includes("HST") || wanted.includes("ERW 2");
  scoped = keepOrAll(scoped, (c) => (c.variant === "HST") === wantedHst);

  return [scoped[0], via];
}

/** The contract row that prices a governed bucket. */
export function contractRowFor(
  index: Map<string, ContractRow[]>,
  bucket: unknown,
): [ContractRow | null, string | null] {
  const parsed = sizeKey(bucket);
  if (parsed === null) return [null, null];
  const [dim1, dim2, thickness, parts] = parsed;
  const grade = (parts.length > 4 ? parts.slice(3, -1).join("-") : parts[3] ?? "")
    .trim().toUpperCase();
  return contractRowForSize(index, dim1, dim2, thickness, grade);
}

/* ---- the section ----------------------------------------------------------- */

export function skuPricing(
  lines: ScheduleLine[],
  grids: Record<string, unknown[][]>,
  bucketting: Row[],
  overrides: Map<string, string[]>,
): PricingResult {
  const available = Object.values(grids).some((g) => g && g.length > 0);
  if (!available) {
    return {
      rows: [], unpriced: [], details: {}, corrections: 0,
      available: false, note: "No contract price sheet was supplied.",
    };
  }

  const index = contractIndex(grids);

  // Annealing is a property of the material, not of the schedule line: Bucketting carries
  // it in `Annealed`, and the description names it as an `-AN-` segment for codes
  // Bucketting does not govern.
  const annealed = new Set(bucketting
    .filter((r) => pyStr(r["Annealed"] ?? "").trim().toUpperCase() === "AN")
    .map((r) => normCode(r["Material Codes"]))
    .filter((c): c is string => c !== null));

  const priced = lines.filter((l) => validBucket(l.bucket));
  const unpricedLines = lines.filter((l) => !validBucket(l.bucket));

  const unpriced: Row[] = groupBy(unpricedLines,
    (l) => [l.customer_display, pick(l.row["Bucket"])])
    .map(([parts, group]) => ({
      customer: parts[0],
      bucket: normBucket(parts[1]),
      reason: "No governed bucket in Schedule July",
      schedule_mt: pyRound(kahanSum(group.map((l) => l.scheduleMt ?? 0)), 3),
      lines: group.length,
    }));

  /* ---- one row per customer, material and cut length ----------------------- */

  const skuGroups = groupBy(priced, (l) => [
    l.customer_display, l.bucket, l.ctl_bucket, l.material_key,
    pick(l.row["MATERIAL DES"]), numKey(l.row["LENGTH"]), l.uom,
  ]);

  const details: Record<string, Row[]> = {};
  const rows: Row[] = [];
  const noContract = new Map<string, Row>();
  let corrections = 0;

  for (const [parts, group] of skuGroups) {
    const bucket = parts[1];
    const customer = parts[0];
    const materialKey = parts[3];
    const scheduleMt = kahanSum(group.map((l) => l.scheduleMt ?? 0));

    const [match, via] = contractRowFor(index, bucket);
    if (match === null) {
      const key = `${customer} ${bucket}`;
      const at = noContract.get(key) ?? {
        customer, bucket,
        reason: "Size is not in the contract price sheet",
        schedule_mt: 0, lines: 0,
      };
      at.schedule_mt = (at.schedule_mt as number) + scheduleMt;
      at.lines = (at.lines as number) + 1;
      noContract.set(key, at);
      continue;
    }

    const kgPerM = match.kg_per_m;
    const description = parts[4] === null ? null : parts[4].trim();
    const lengthMm = toNumber(parts[5]);
    const lengthM = lengthMm === null ? null : lengthMm / 1000;
    const isLong = lengthM !== null && lengthM >= LONG_LENGTH_MIN_M;
    const lengthWritten = lengthM === null ? null : pyRound(lengthM * 1000, 1);

    let operations: Record<string, number> = {};
    if (group.some((l) => flag(l.row["FC/NFC"], (v) => v === "FC" || v === "FIN CUT"))) {
      operations["Fin cut"] = PRICING_OPERATION_RATES["Fin cut"];
    }
    if (group.some((l) => flag(l.row["Chamferring "], (v) => v.startsWith("CHAM")))) {
      operations["Chamferring"] = PRICING_OPERATION_RATES["Chamferring"];
    }
    if (group.some((l) => flag(l.row["Angle Cut"], (v) => v === "AG"))) {
      operations["Angle cut"] = PRICING_OPERATION_RATES["Angle cut"];
    }
    if ((materialKey !== null && annealed.has(materialKey))
      || (description ?? "").toUpperCase().includes("-AN-")) {
      const label = `Annealing ${match.route}`;
      operations[label] = PRICING_OPERATION_RATES[label];
    }

    // Overrides replace the whole set — see the note at the top of this file.
    if (lengthWritten !== null) {
      const corrected = overrides.get(overrideKey(customer, bucket, materialKey, lengthWritten));
      if (corrected !== undefined) {
        operations = Object.fromEntries(corrected
          .filter((name) => name in PRICING_OPERATION_RATES)
          .map((name) => [name, PRICING_OPERATION_RATES[name]]));
        corrections += 1;
      }
    }

    const operationsPerM = kgPerM
      ? pairwiseSum(Object.values(operations).map((rate) => rate * kgPerM / 1000))
      : 0;

    const row: Row = {
      customer,
      material_code: materialKey,
      description,
      bucket,
      ctl_bucket: parts[2],
      contract_key: match.key,
      contract_type: match.contract_type,
      route: match.route,
      matched_via: via,
      length_mm: lengthWritten,
      kind: isLong ? "LL" : "CTL",
      unit: isLong ? "INR/m" : "INR/nos",
      kg_per_m: kgPerM === null ? null : pyRound(kgPerM, 6),
      operations: Object.keys(operations).sort(),
      operations_per_m: pyRound(operationsPerM, 4),
      schedule_mt: pyRound(scheduleMt, 3),
      schedule_qty: kahanSum(group.map((l) => l.scheduleQty)),
    };

    for (const quarter of PRICING_QUARTERS) {
      const base = match.prices[quarter] ?? {};
      const perM = base.per_m ?? null;
      if (perM === null) {
        row[quarter] = null;
        row[`${quarter} per m`] = null;
        row[`${quarter} base per m`] = null;
        continue;
      }
      row[`${quarter} base per m`] = pyRound(perM, 6);
      const totalPerM = perM + operationsPerM;
      row[`${quarter} per m`] = pyRound(totalPerM, 4);
      row[`${quarter} base per ton`] = base.per_ton ?? null;
      row[quarter] = isLong ? pyRound(totalPerM, 2)
        : (lengthM !== null ? pyRound(totalPerM * lengthM, 2) : null);
    }

    // A long length is quoted by the metre, so its per-piece column is priced at one metre
    // and the two read the same number rather than the piece column sitting empty.
    const priceLength = isLong ? 1 : lengthM;
    const detailKeys: Record<string, string> = {};

    for (const quarter of PRICING_QUARTERS) {
      const base = match.prices[quarter] ?? {};
      const basePerM = base.per_m ?? null;
      if (basePerM === null || priceLength === null) continue;

      const build: Row[] = [{
        operation: `Base price · ${match.key} · ${quarter}`,
        inr_per_mt: base.per_ton ?? null,
        kg_per_m: kgPerM,
        inr_per_m: pyRound(basePerM, 4),
        length_m: pyRound(priceLength, 4),
        qty: pyRound(basePerM * priceLength, 4),
        unit: "INR",
      }];
      for (const name of Object.keys(operations).sort()) {
        const rate = operations[name];
        build.push({
          operation: name,
          inr_per_mt: rate,
          kg_per_m: kgPerM,
          inr_per_m: pyRound(rate * (kgPerM ?? 0) / 1000, 4),
          length_m: pyRound(priceLength, 4),
          qty: pyRound(rate * (kgPerM ?? 0) / 1000 * priceLength, 4),
          unit: "INR",
        });
      }

      // The bucket is part of the key, not decoration. Without it, code 3768904 at 878 mm
      // — which Metalman schedules as both a 1.6 and a 2.5 wall — wrote two build-ups to
      // one key, and the 1.6 row opened the 2.5's working: a different weight, a different
      // contract row and a price 44% higher, with nothing on screen to say so.
      // Interpolated the way Python interpolates them. The two are not the same kind of
      // value: the material code is a *string* from `norm_code` and prints as itself, but
      // when it is absent it is a float NaN and prints `nan`; the length is a float
      // throughout and prints with its point.
      const key = `PRICEBUILD|${row.customer}|${row.bucket}`
        + `|${isNa(row.material_code) ? "nan" : pyStr(row.material_code)}`
        + `|${pyStrFloat(row.length_mm)}|${quarter}`;
      details[key] = build;
      detailKeys[quarter] = key;
    }

    row.detail_keys = detailKeys;
    row.detail_key = detailKeys[PRICING_QUARTERS[PRICING_QUARTERS.length - 1]] ?? null;
    row.price_length_m = priceLength === null ? null : pyRound(priceLength, 4);
    rows.push(row);
  }

  // Only the first list rounds. The `no_contract` entries accumulate a raw float and are
  // extended onto the end unrounded — the two halves of this list are published to
  // different precisions, and matching that is the difference between agreeing and nearly
  // agreeing.
  const allUnpriced = [...unpriced, ...noContract.values()];

  rows.sort((a, b) =>
    cmp(a.customer as string | null, b.customer as string | null)
    || compareNaturalBucket(a.bucket, b.bucket)
    || ((a.length_mm as number ?? 0) - (b.length_mm as number ?? 0)));
  allUnpriced.sort((a, b) => (b.schedule_mt as number) - (a.schedule_mt as number));

  return { rows, unpriced: allUnpriced, details, corrections, available: true, note: null };
}

/* ---- helpers --------------------------------------------------------------- */

const sizeIndexKey = (dim1: number, dim2: number, thickness: number): string =>
  `${dim1}|${dim2}|${thickness}`;

/** `[c for c in scoped if test(c)] or scoped` — prefer, but never eliminate. */
function keepOrAll<T>(rows: T[], test: (row: T) => boolean): T[] {
  const kept = rows.filter(test);
  return kept.length ? kept : rows;
}

const flag = (value: unknown, test: (v: string) => boolean): boolean =>
  test(pyStr(value ?? "").trim().toUpperCase());

const pick = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));
const numKey = (value: unknown): string | null => {
  const n = toNumber(value);
  return n === null ? null : String(n);
};

/**
 * `customer|bucket|material code|length in mm`, written the way the browser writes it.
 *
 * The length goes through `float` on both sides before printing, so `189` from a build and
 * `189.0` from a Postgres `numeric` are the same key rather than two.
 */
export const overrideKey = (
  customer: string | null,
  bucket: string | null,
  materialCode: string | null,
  lengthMm: number,
): string => `${customer}|${bucket}|${materialCode ?? ""}|${fmtG(lengthMm)}`;

const cmp = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
};

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
      const r = cmp(a[0][i] ?? null, b[0][i] ?? null);
      if (r !== 0) return r;
    }
    return 0;
  });
}
