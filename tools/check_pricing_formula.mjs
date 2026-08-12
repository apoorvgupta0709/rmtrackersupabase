/**
 * Does the browser price a SKU the way the pipeline does?
 *
 * The contract formula is written twice — in Python, where the build is computed, and in
 * `app/dashboard/[view]/pricing.ts`, where a reader who corrects a SKU's operations sees
 * the price move without waiting for a refresh. Two implementations of the same arithmetic
 * is exactly the arrangement that drifts, and it drifts silently: the page would show one
 * number, tomorrow's build another, and both would look right on their own.
 *
 * So this runs the TypeScript against the pipeline's own output. For every priced SKU and
 * every quarter it recomputes the price from the row's published figures, and it rebuilds
 * the price build-up and compares it line for line with the `PRICEBUILD` rows the pipeline
 * wrote. Anything that disagrees by more than half a paisa is a failure.
 *
 *     node tools/check_pricing_formula.mjs [data.json]
 *
 * Node strips the TypeScript types on import, so there is no build step and no second copy
 * of the module to go stale.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { basePerM, buildUp, priceFor, skuKey } = await import(
  resolve(here, "../app/dashboard/[view]/pricing.ts")
);

const path = process.argv[2] ?? resolve(here, "../data.json");
const data = JSON.parse(readFileSync(path, "utf8"));

const pricing = data.sku_pricing ?? {};
const rows = pricing.rows ?? [];
const quarters = pricing.quarters ?? [];
const rates = pricing.operation_rates_inr_per_ton ?? {};
const details = data.stock_details ?? {};

if (!rows.length) {
  console.error("No priced SKUs in this build, so there is nothing to check.");
  process.exit(1);
}

const near = (a, b, tolerance) =>
  a === null || a === undefined || b === null || b === undefined
    ? a === b || (a ?? null) === (b ?? null)
    : Math.abs(Number(a) - Number(b)) <= tolerance;

/**
 * How closely a build-up line can be expected to match, which depends on what the build
 * published.
 *
 * A build that carries `<q> base per m` and a six-decimal `kg/m` gives this side the same
 * inputs the pipeline had, so the only difference left is the pipeline's own rounding to
 * four decimals — half of that is the whole tolerance. An older build makes the base be
 * recovered by subtracting two separately rounded figures and hands over a weight already
 * truncated to four decimals, and those errors carry through the multiplication. Checking
 * an old build at the strict tolerance would report hundreds of disagreements about
 * arithmetic that is in fact identical.
 */
const precise = rows.some((row) =>
  quarters.some((q) => row[`${q} base per m`] !== undefined && row[`${q} base per m`] !== null),
);
const LINE_TOLERANCE = precise ? 5.1e-5 : 1e-3;
// Half a paisa on a build that hands over the same inputs; a whole one where the base has
// to be recovered by subtraction, which can move the last place the price is quoted in.
const PRICE_TOLERANCE = precise ? 0.005 : 0.01;

const faults = [];
let pricesChecked = 0;
let buildUpsChecked = 0;
let keysChecked = 0;
let legacyBuildUps = 0;

for (const row of rows) {
  const key = skuKey(row);
  if (key === null) {
    // A SKU with no length cannot be keyed, and so cannot be corrected. That is a
    // deliberate limit, not a fault — but it must stay rare enough to notice.
    faults.push(`no override key for ${row.customer} / ${row.material_code}`);
    continue;
  }
  keysChecked += 1;

  for (const quarter of quarters) {
    const published = row[quarter];
    if (published === null || published === undefined) continue;

    const recomputed = priceFor(row, quarter, row.operations ?? [], rates);
    pricesChecked += 1;
    if (!near(recomputed, published, PRICE_TOLERANCE)) {
      faults.push(
        `${row.customer} / ${row.bucket} / ${quarter}: `
        + `page ${recomputed} vs build ${published}`,
      );
    }

    // The base and the operations have to add back up to the published per-metre figure.
    // Tolerance is the rounding of those published fields — both are written to four
    // decimals, so the identity can only be expected to hold to about a ten-thousandth.
    const base = basePerM(row, quarter);
    const perM = row[`${quarter} per m`];
    if (base !== null && !near(base + (row.operations_per_m ?? 0), perM, 2e-4)) {
      faults.push(
        `${row.customer} / ${row.bucket} / ${quarter}: base ${base} + operations `
        + `${row.operations_per_m} does not close on ${perM}`,
      );
    }

    /**
     * Only compare the build-up where the stored key names the bucket.
     *
     * A build published before the bucket joined the key cannot be checked this way, and
     * not because of rounding: on such a build the key genuinely points at another SKU's
     * working wherever a customer schedules one material code at one length under two
     * buckets. Reporting that here every run would be reporting a defect in a frozen
     * oracle, which is not what this check is for. The price comparison and the key
     * uniqueness check above still run against it.
     */
    const stored = details[row.detail_keys?.[quarter]];
    if (!stored) continue;
    if (!String(row.detail_keys[quarter]).includes(`|${row.bucket}|`)) {
      legacyBuildUps += 1;
      continue;
    }
    const rebuilt = buildUp(row, quarter, row.operations ?? [], rates);
    buildUpsChecked += 1;
    if (rebuilt.length !== stored.length) {
      faults.push(
        `${row.bucket} / ${quarter}: build-up has ${rebuilt.length} lines, `
        + `the build wrote ${stored.length}`,
      );
      continue;
    }
    for (let i = 0; i < stored.length; i++) {
      for (const field of ["inr_per_mt", "kg_per_m", "inr_per_m", "length_m", "qty"]) {
        if (!near(rebuilt[i][field], stored[i][field], LINE_TOLERANCE)) {
          faults.push(
            `${row.bucket} / ${quarter} / line ${i + 1} / ${field}: `
            + `page ${rebuilt[i][field]} vs build ${stored[i][field]}`,
          );
        }
      }
      if (rebuilt[i].operation !== stored[i].operation) {
        faults.push(
          `${row.bucket} / ${quarter} / line ${i + 1}: `
          + `page "${rebuilt[i].operation}" vs build "${stored[i].operation}"`,
        );
      }
    }
  }
}

/**
 * The override key has to read the same in both languages or a correction saved in the
 * browser would simply never be found by the refresh — no error, no warning, the price
 * back where it started the next morning. JavaScript writes an integral length without a
 * decimal point; Python's `:g` does the same, and this states the shape both must produce.
 */
const sample = rows.find((row) => Number.isInteger(Number(row.length_mm)));
if (sample) {
  const expected = [
    sample.customer, sample.bucket, sample.material_code ?? "", Number(sample.length_mm),
  ].join("|");
  if (skuKey(sample) !== expected || skuKey(sample).endsWith(".0")) {
    faults.push(`override key is written as ${skuKey(sample)}, expected ${expected}`);
  }
}

/**
 * And the key has to name exactly one SKU.
 *
 * It did not before the bucket was part of it: Metalman schedules code 3768904 at 878 mm
 * as both a 1.6 and a 2.5 wall, and the two wrote different build-ups to the same
 * `PRICEBUILD` key, so the 1.6 row opened the 2.5's working — a different weight, a
 * different contract row, a price 44% higher, and nothing on screen to say so.
 */
const byKey = new Map();
for (const row of rows) {
  const key = skuKey(row);
  if (key === null) continue;
  const shape = JSON.stringify([
    row.contract_key, row.kg_per_m, row.operations, ...quarters.map((q) => row[q]),
  ]);
  const held = byKey.get(key);
  if (held === undefined) byKey.set(key, shape);
  else if (held !== shape) faults.push(`two different SKUs share the key ${key}`);
}

if (faults.length) {
  console.error(`${faults.length} disagreement(s) between the page and the build:`);
  for (const fault of faults.slice(0, 25)) console.error(`  ${fault}`);
  if (faults.length > 25) console.error(`  … and ${faults.length - 25} more`);
  process.exit(1);
}

console.log(
  `The page and the build agree: ${pricesChecked} prices, `
  + `${buildUpsChecked} build-ups, ${keysChecked} keyable SKUs`
  + `${precise ? "" : " (no published base per m, so checked to a tenth of a paisa)"}`
  + `${legacyBuildUps ? `; ${legacyBuildUps} build-ups skipped, their keys predate the bucket` : ""}.`,
);
