/**
 * Does the ported SKU pricing match the pipeline's, row, build-up and refusal?
 *
 * The prices a customer's own reconciliation is checked against, so this compares the
 * published rows, the `PRICEBUILD|` workings behind each quarter, and the unpriced list —
 * a size refused for the right reason matters as much as one priced correctly.
 *
 *     node tools/check_section_pricing.mjs /tmp/port/oracle.json --as-of 2026-08-14
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot, readSalesLedger, readCellGrid } from "../lib/pipeline/source.ts";
import { materialDimension } from "../lib/pipeline/sections/material.ts";
import { salesMapping, oemMapOf } from "../lib/pipeline/sections/sales.ts";
import { scheduleLines } from "../lib/pipeline/sections/schedule.ts";
import { skuPricing, overrideKey } from "../lib/pipeline/sections/pricing.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
const asOf = process.argv.includes("--as-of")
  ? process.argv[process.argv.indexOf("--as-of") + 1] : "2026-08-14";
if (!oraclePath) {
  console.error("Usage: node tools/check_section_pricing.mjs <data.json> [--as-of YYYY-MM-DD]");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => {
      const at = l.indexOf("=");
      return [l.slice(0, at).trim(), l.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: key, Authorization: `Bearer ${key}` };
const sheet = `Schedule ${new Date(`${asOf}T00:00:00Z`)
  .toLocaleString("en-US", { month: "long", timeZone: "UTC" })}`;

const [bucketting, zmat, oemRows, ledger, scheduleRows, erw, cew, assignmentRows, operationRows] =
  await Promise.all([
    readSlot("bucketting", { root, url, key }),
    readSlot("zmat", { root, url, key }),
    readSlot("oem_key", { root, url, key }),
    readSalesLedger({ url, key }),
    readSlot("schedule", { root, url, key, sheet }),
    readCellGrid("contract:ERW", { url, key }),
    readCellGrid("contract:CEW", { url, key }),
    fetch(`${url}/rest/v1/bucket_assignments?select=scope,material_code,assigned_to`, { headers })
      .then((r) => r.json()),
    fetch(`${url}/rest/v1/sku_operations?select=customer,bucket,material_code,length_mm,operations`,
      { headers }).then((r) => r.json()),
  ]);

const dimension = materialDimension(bucketting, zmat, {
  bucket: Object.fromEntries(assignmentRows
    .filter((a) => a.scope === "bucket").map((a) => [a.material_code, a.assigned_to])),
});
const sales = salesMapping(ledger, oemRows, dimension, asOf.slice(0, 7));
const lines = scheduleLines(scheduleRows, dimension, sales, oemMapOf(oemRows));

const overrides = new Map(operationRows.map((o) => [
  overrideKey(o.customer, o.bucket, o.material_code, Number(o.length_mm)),
  o.operations,
]));

const ours = skuPricing(lines, { ERW: erw, CEW: cew }, bucketting, overrides);
const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));

const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const same = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => same(a[k], b[k]));
  }
  if (typeof a === "number" && typeof b === "number") return near(a, b);
  return (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
};

const faults = [];
const summary = [];

for (const [name, mine, theirs] of [
  ["sku_pricing rows", ours.rows, oracle.sku_pricing?.rows ?? []],
  ["unpriced", ours.unpriced, oracle.sku_pricing?.unpriced ?? []],
]) {
  let bad = 0;
  if (mine.length !== theirs.length) {
    faults.push(`${name}: pipeline ${theirs.length}, port ${mine.length}`);
  } else {
    const fields = [...new Set(theirs.flatMap((r) => Object.keys(r)))];
    for (let i = 0; i < theirs.length; i += 1) {
      for (const f of fields) {
        if (!same(theirs[i][f], mine[i][f])) {
          bad += 1;
          if (faults.length < 2000) {
            faults.push(`${name}[${i}].${f} (${theirs[i].bucket}): pipeline `
              + `${JSON.stringify(theirs[i][f])?.slice(0, 110)}, port `
              + `${JSON.stringify(mine[i][f])?.slice(0, 110)}`);
          }
        }
      }
    }
  }
  summary.push(`  ${String(theirs.length).padStart(5)} ${name}${bad ? `  - ${bad} wrong` : ""}`);
}

{
  const theirs = Object.fromEntries(Object.entries(oracle.stock_details ?? {})
    .filter(([k]) => k.startsWith("PRICEBUILD|")));
  const keys = [...new Set([...Object.keys(theirs), ...Object.keys(ours.details)])];
  let bad = 0;
  for (const k of keys) {
    if (!same(theirs[k], ours.details[k])) {
      bad += 1;
      if (faults.length < 2000) {
        faults.push(`${k}: pipeline ${JSON.stringify(theirs[k])?.slice(0, 150)}, `
          + `port ${JSON.stringify(ours.details[k])?.slice(0, 150)}`);
      }
    }
  }
  summary.push(`  ${String(keys.length).padStart(5)} PRICEBUILD| keys${bad ? `  - ${bad} wrong` : ""}`);
}

console.log(`${lines.length} schedule lines, ${erw.length + cew.length} contract rows, `
  + `${operationRows.length} owner override(s), ${ours.corrections} applied.`);
for (const line of summary) console.log(line);

if (faults.length) {
  console.error(`\n${faults.length} difference(s):`);
  for (const fault of faults.slice(0, 20)) console.error(`  - ${fault}`);
  if (faults.length > 20) console.error(`  ... and ${faults.length - 20} more.`);
  process.exit(1);
}
console.log("\nEvery price, build-up line and refusal matches the pipeline.");
