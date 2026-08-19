/**
 * Does the ported sales trend match the pipeline's?
 *
 * Section 17a only — the trend tables proper. The Megh sales history in the middle of the
 * same section reads `megh_rows` from section 11 and is not ported yet, so `MEGHSALES|`
 * keys and the `history_*` columns are out of scope here and are named below.
 *
 *     node tools/check_section_trend.mjs /tmp/port/oracle.json --as-of 2026-08-14
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot, readSalesLedger } from "../lib/pipeline/source.ts";
import { materialDimension } from "../lib/pipeline/sections/material.ts";
import { salesMapping, oemMapOf } from "../lib/pipeline/sections/sales.ts";
import { scheduleFacts } from "../lib/pipeline/sections/schedule.ts";
import { stockPools } from "../lib/pipeline/sections/stock.ts";
import { wipAndSummary } from "../lib/pipeline/sections/wip.ts";
import { missingMappings } from "../lib/pipeline/sections/missing.ts";
import { salesTrend } from "../lib/pipeline/sections/trend.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
const asOf = process.argv.includes("--as-of")
  ? process.argv[process.argv.indexOf("--as-of") + 1] : "2026-08-14";
if (!oraclePath) {
  console.error("Usage: node tools/check_section_trend.mjs <data.json> [--as-of YYYY-MM-DD]");
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
const sheet = `Schedule ${new Date(`${asOf}T00:00:00Z`)
  .toLocaleString("en-US", { month: "long", timeZone: "UTC" })}`;

const [bucketting, zmat, oemRows, ledger, scheduleRows, stockRows, rfdRows, wipRows, assignmentRows] =
  await Promise.all([
    readSlot("bucketting", { root, url, key }),
    readSlot("zmat", { root, url, key }),
    readSlot("oem_key", { root, url, key }),
    readSalesLedger({ url, key }),
    readSlot("schedule", { root, url, key, sheet }),
    readSlot("stock", { root, url, key }),
    readSlot("rfd", { root, url, key }),
    readSlot("wip", { root, url, key }),
    fetch(`${url}/rest/v1/bucket_assignments?select=scope,material_code,assigned_to`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }).then((r) => r.json()),
  ]);

const dimension = materialDimension(bucketting, zmat, {
  bucket: Object.fromEntries(assignmentRows
    .filter((a) => a.scope === "bucket").map((a) => [a.material_code, a.assigned_to])),
});
// The OEM queue answers into `oem_map`, and the pipeline applies it there rather than at
// the customer join — so the check has to hand the port the same set the pipeline read,
// or the two would agree only while nobody had answered that queue.
const oemAssigned = {
  oem: Object.fromEntries(assignmentRows.filter((a) => a.scope === "oem" && a.assigned_to)
    .map((a) => [a.material_code, a.assigned_to])),
};

const oemMap = oemMapOf(oemRows, oemAssigned);
const sales = salesMapping(ledger, oemRows, dimension, asOf.slice(0, 7, oemAssigned));
const groups = scheduleFacts(scheduleRows, dimension, sales, oemMap);
const stock = stockPools(stockRows, rfdRows, zmat, groups, dimension, oemMap, asOf);
const wip = wipAndSummary(wipRows, bucketting, stock, dimension);
const resolved = missingMappings(scheduleRows, wip.group, sales, dimension, sheet).group;
const ours = salesTrend(sales, scheduleRows, resolved);

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

console.log("Scoped out: MEGHSALES| keys and the history_* columns (section 17b, waits on S11).");

for (const [name, mine, theirs] of [
  ["trend_months", ours.months, oracle.sales_trend?.months ?? []],
  ["trend_buckets", ours.buckets, oracle.sales_trend?.buckets ?? []],
  ["trend_customer_skus", ours.customerSkus, oracle.sales_trend?.customer_skus ?? []],
]) {
  let bad = 0;
  if (mine.length !== theirs.length) {
    faults.push(`${name}: pipeline ${theirs.length}, port ${mine.length}`);
  } else if (name === "trend_months") {
    for (let i = 0; i < theirs.length; i += 1) {
      if (!same(theirs[i], mine[i])) {
        bad += 1;
        faults.push(`${name}[${i}]: pipeline ${theirs[i]}, port ${mine[i]}`);
      }
    }
  } else {
    const fields = [...new Set(theirs.flatMap((r) => Object.keys(r)))];
    for (let i = 0; i < theirs.length; i += 1) {
      for (const f of fields) {
        if (!same(theirs[i][f], mine[i][f])) {
          bad += 1;
          if (faults.length < 2000) {
            faults.push(`${name}[${i}].${f} (${theirs[i].bucket ?? theirs[i].sku}): pipeline `
              + `${JSON.stringify(theirs[i][f])?.slice(0, 120)}, port `
              + `${JSON.stringify(mine[i][f])?.slice(0, 120)}`);
          }
        }
      }
    }
  }
  summary.push(`  ${String(theirs.length).padStart(5)} ${name}${bad ? `  - ${bad} wrong` : ""}`);
}

{
  const theirs = Object.fromEntries(Object.entries(oracle.stock_details ?? {})
    .filter(([k]) => k.startsWith("TRENDBUCKET|")));
  const keys = [...new Set([...Object.keys(theirs), ...Object.keys(ours.details)])];
  let bad = 0;
  for (const k of keys) {
    if (!same(theirs[k], ours.details[k])) {
      bad += 1;
      if (faults.length < 2000) {
        faults.push(`${k}: pipeline ${JSON.stringify(theirs[k])?.slice(0, 170)}, `
          + `port ${JSON.stringify(ours.details[k])?.slice(0, 170)}`);
      }
    }
  }
  summary.push(`  ${String(keys.length).padStart(5)} TRENDBUCKET| keys${bad ? `  - ${bad} wrong` : ""}`);
}

console.log(`${sales.all.length.toLocaleString("en-US")} ledger lines over ${ours.months.length} months.`);
for (const line of summary) console.log(line);

if (faults.length) {
  console.error(`\n${faults.length} difference(s):`);
  for (const fault of faults.slice(0, 20)) console.error(`  - ${fault}`);
  if (faults.length > 20) console.error(`  ... and ${faults.length - 20} more.`);
  process.exit(1);
}
console.log("\nEvery trend row, month cell and bucket drill-down matches the pipeline.");
