/**
 * The contract price formula, in one place.
 *
 * It is written down three times on this tab — in the price column, in the build-up the
 * column opens, and in the PO rate the quarterly calculation quotes — and the pipeline
 * writes it a fourth time in Python. Three of those four are here, so a reader who
 * changes a SKU's operations sees the same number in all three places at once. The fourth
 * is `refresh_dashboard.py`, which recomputes from the same stored override at the next
 * refresh; a test compares the two.
 *
 *     operation INR/m = rate INR per tonne x contract kg/m / 1000
 *     price per m     = contract base price per m for the quarter + sum(operation INR/m)
 *     LL  price       = price per m                    quoted INR / m
 *     CTL price       = price per m x length in metres quoted INR / piece
 *
 * The weight is the contract's own kg/m and never a recomputed one, which is what makes
 * the result reproduce the customer's reconciliation to the paisa.
 */

export type PriceRow = Record<string, unknown>;

export type OperationRates = Record<string, number>;

const n = (value: unknown): number | null => {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
};

/**
 * The key an override is recorded against: the SKU, as the price build-up names it.
 *
 * Four parts, and the bucket is one of them for a reason. Metalman schedules code 3768904
 * at 878 mm as both a 1.6 and a 2.5 wall, so the other three do not identify a SKU — they
 * identify two, with different weights, different contract rows and prices 44% apart.
 *
 * Both sides of the length comparison run through `Number`, because it arrives as a JSON
 * number from the build and as a Postgres `numeric` from the override table, and `189` and
 * `189.0` are the same length written two ways.
 */
export function skuKey(row: PriceRow): string | null {
  const length = n(row.length_mm);
  if (length === null) return null;
  return [
    String(row.customer ?? ""),
    String(row.bucket ?? ""),
    String(row.material_code ?? ""),
    length,
  ].join("|");
}

export function poKey(row: PriceRow, quarter: string): string | null {
  const key = skuKey(row);
  return key === null ? null : `${key}|${quarter}`;
}

/** What the build says this SKU carries, before anyone corrected it. */
export function publishedOperations(row: PriceRow): string[] {
  return Array.isArray(row.operations) ? (row.operations as string[]) : [];
}

export function operationsPerM(
  operations: string[],
  rates: OperationRates,
  kgPerM: unknown,
): number {
  const kg = n(kgPerM);
  if (kg === null) return 0;
  return operations.reduce((sum, op) => sum + ((rates[op] ?? 0) * kg) / 1000, 0);
}

/**
 * The contract's base price per metre for the quarter.
 *
 * Published on the row, and taken from there. The fallback subtracts the operations back
 * out of the total, which is what a build written before that field existed leaves us —
 * and is why the field exists: both halves are rounded separately, so the recovered base
 * is out by up to a hundredth of a paisa and the build-up then disagrees with the
 * pipeline's in the fourth decimal.
 */
export function basePerM(row: PriceRow, quarter: string): number | null {
  const published = n(row[`${quarter} base per m`]);
  if (published !== null) return published;
  const withOperations = n(row[`${quarter} per m`]);
  if (withOperations === null) return null;
  return withOperations - (n(row.operations_per_m) ?? 0);
}

/** The length a price is quoted over: one metre for a long length, its own for a piece. */
export function priceLength(row: PriceRow): number | null {
  return n(row.price_length_m);
}

/** The unit price for a quarter, given whatever set of operations the SKU is carrying. */
export function priceFor(
  row: PriceRow,
  quarter: string,
  operations: string[],
  rates: OperationRates,
): number | null {
  const base = basePerM(row, quarter);
  const length = priceLength(row);
  if (base === null || length === null) return null;
  return (base + operationsPerM(operations, rates, row.kg_per_m)) * length;
}

/** One line of the price build-up, in the shape `PRICEBUILD` rows are published in. */
export type BuildUpLine = {
  operation: string;
  inr_per_mt: number | null;
  kg_per_m: number | null;
  inr_per_m: number;
  length_m: number;
  qty: number;
  unit: string;
};

/**
 * The build-up, recomputed — the ladder, with a rung per operation.
 *
 * Used only where the reader has changed the operations: with no override the panel shows
 * the pipeline's own rows, so an untouched SKU is always reading the published working
 * and not a browser's re-derivation of it.
 */
export function buildUp(
  row: PriceRow,
  quarter: string,
  operations: string[],
  rates: OperationRates,
): BuildUpLine[] {
  const base = basePerM(row, quarter);
  const length = priceLength(row);
  if (base === null || length === null) return [];
  const kg = n(row.kg_per_m);

  // Unrounded. The panel formats every cell it renders, and the pipeline's own rows go
  // through the same formatter, so rounding here would add a second rounding step that
  // only this side has — and Python rounds half to even where JavaScript rounds half up,
  // which is enough to make the two disagree in the fourth decimal for no reason.
  const lines: BuildUpLine[] = [
    {
      operation: `Base price · ${String(row.contract_key ?? "")} · ${quarter}`,
      inr_per_mt: n(row[`${quarter} base per ton`]),
      kg_per_m: kg,
      inr_per_m: base,
      length_m: length,
      qty: base * length,
      unit: "INR",
    },
  ];
  for (const name of [...operations].sort()) {
    const rate = rates[name] ?? 0;
    const perM = (rate * (kg ?? 0)) / 1000;
    lines.push({
      operation: name,
      inr_per_mt: rate,
      kg_per_m: kg,
      inr_per_m: perM,
      length_m: length,
      qty: perM * length,
      unit: "INR",
    });
  }
  return lines;
}

/**
 * The PO rate for a billing line, in the unit it was billed in.
 *
 * The contract quotes a tube by the metre; SAP bills it by the piece, the metre or the
 * kilogram depending on the sales unit on the order. Quoting a per-metre price against a
 * kilogram quantity is how a CN/DN claim comes out an order of magnitude wrong, so the
 * conversion happens here and the document states the unit it used.
 */
export function rateInSalesUnit(
  perM: number,
  salesUnit: string,
  lengthM: number | null,
  kgPerM: number | null,
): number | null {
  switch (String(salesUnit ?? "").trim().toUpperCase()) {
    case "M":   return perM;
    case "NOS": return lengthM ? perM * lengthM : null;
    case "KG":  return kgPerM ? perM / kgPerM : null;
    default:    return null;
  }
}
