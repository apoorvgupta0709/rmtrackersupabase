/**
 * Does the ported sales summary match the pipeline's, row and card?
 *
 * Both halves are published, so the fresh `data.json` is the oracle directly — the summary
 * as its own payload key, and the `SALES|` cards inside `stock_details`.
 *
 *     node tools/check_section_salessummary.mjs /tmp/port/oracle.json --as-of 2026-08-14
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot, readSalesLedger } from "../lib/pipeline/source.ts";
import { materialDimension } from "../lib/pipeline/sections/material.ts";
import { salesMapping } from "../lib/pipeline/sections/sales.ts";
import { salesSummary } from "../lib/pipeline/sections/salessummary.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
const asOf = process.argv.includes("--as-of")
  ? process.argv[process.argv.indexOf("--as-of") + 1] : "2026-08-14";
if (!oraclePath) {
  console.error("Usage: node tools/check_section_salessummary.mjs <data.json> [--as-of YYYY-MM-DD]");
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

const [bucketting, zmat, oemRows, ledger, assignmentRows] = await Promise.all([
  readSlot("bucketting", { root, url, key }),
  readSlot("zmat", { root, url, key }),
  readSlot("oem_key", { root, url, key }),
  readSalesLedger({ url, key }),
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

const sales = salesMapping(ledger, oemRows, dimension, asOf.slice(0, 7, oemAssigned));
const ours = salesSummary(sales);
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

{
  const theirs = oracle.sales_summary ?? [];
  let bad = 0;
  if (ours.summary.length !== theirs.length) {
    faults.push(`sales_summary: pipeline ${theirs.length} rows, port ${ours.summary.length}`);
  } else {
    const fields = [...new Set(theirs.flatMap((r) => Object.keys(r)))];
    for (let i = 0; i < theirs.length; i += 1) {
      for (const f of fields) {
        if (!same(theirs[i][f], ours.summary[i][f])) {
          bad += 1;
          faults.push(`sales_summary[${i}].${f} (${theirs[i].OEM}): pipeline `
            + `${JSON.stringify(theirs[i][f])}, port ${JSON.stringify(ours.summary[i][f])}`);
        }
      }
    }
  }
  summary.push(`  ${String(theirs.length).padStart(5)} sales_summary rows${bad ? `  - ${bad} wrong` : ""}`);
}

{
  // Only the OEM cards this section builds. `SALES|TVSM_RECEIVED`, `SALES|TSL_BILLED` and
  // `SALES|TVS_TOTAL` share the prefix but are built later, by the reconciliation.
  const mine = new Set(ours.summary.map((r) => r.detail_key));
  const theirs = Object.fromEntries(Object.entries(oracle.stock_details ?? {})
    .filter(([k]) => mine.has(k)));
  const keys = [...new Set([...Object.keys(theirs), ...Object.keys(ours.metricDetails)])];
  let bad = 0;
  for (const k of keys) {
    if (!same(theirs[k], ours.metricDetails[k])) {
      bad += 1;
      if (faults.length < 100) {
        faults.push(`${k}: pipeline ${JSON.stringify(theirs[k])?.slice(0, 180)}, `
          + `port ${JSON.stringify(ours.metricDetails[k])?.slice(0, 180)}`);
      }
    }
  }
  summary.push(`  ${String(keys.length).padStart(5)} SALES| cards${bad ? `  - ${bad} wrong` : ""}`);
}

console.log(`${sales.published.length.toLocaleString("en-US")} published sales lines.`);
for (const line of summary) console.log(line);

if (faults.length) {
  console.error(`\n${faults.length} difference(s):`);
  for (const fault of faults.slice(0, 20)) console.error(`  - ${fault}`);
  if (faults.length > 20) console.error(`  ... and ${faults.length - 20} more.`);
  process.exit(1);
}
console.log("\nEvery OEM row and every customer card matches the pipeline.");
