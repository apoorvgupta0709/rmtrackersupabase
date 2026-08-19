/**
 * Does the ported stock analysis match, row, drill-down and reconciliation?
 *
 *     DUMP_ANALYSIS=/tmp/port/analysis.json ./.venv/bin/python \
 *       .claude/skills/refresh-tvsm-dashboard/scripts/refresh_from_supabase.py \
 *       --as-of 2026-08-14 --dry-run
 *     node tools/check_section_analysis.mjs /tmp/port/analysis.json
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
import { llTracker } from "../lib/pipeline/sections/lltracker.ts";
import { stockAnalysis } from "../lib/pipeline/sections/analysis.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
const asOf = process.argv.includes("--as-of")
  ? process.argv[process.argv.indexOf("--as-of") + 1] : "2026-08-14";
if (!oraclePath) {
  console.error("Usage: node tools/check_section_analysis.mjs <analysis.json> [--as-of YYYY-MM-DD]");
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

const [bucketting, zmat, oemRows, ledger, scheduleRows, stockRows, rfdRows, wipRows, vsmRows, assignmentRows] =
  await Promise.all([
    readSlot("bucketting", { root, url, key }),
    readSlot("zmat", { root, url, key }),
    readSlot("oem_key", { root, url, key }),
    readSalesLedger({ url, key }),
    readSlot("schedule", { root, url, key, sheet }),
    readSlot("stock", { root, url, key }),
    readSlot("rfd", { root, url, key }),
    readSlot("wip", { root, url, key }),
    readSlot("vsm_tvsm", { root, url, key }),
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
llTracker(vsmRows, stock, wip, sales);
const ours = stockAnalysis(stock, wip, asOf);

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
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a); const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return near(x, y);
  }
  return (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
};

const faults = [];
const summary = [];

for (const [name, mine, theirs] of [
  ["stock_analysis.ctl", ours.stockAnalysis.ctl, oracle.stock_analysis.ctl],
  ["stock_analysis.ll", ours.stockAnalysis.ll, oracle.stock_analysis.ll],
  ["source_coverage", ours.stockAnalysis.source_coverage, oracle.stock_analysis.source_coverage],
  ["stock_unmapped", ours.stockUnmapped, oracle.stock_unmapped],
]) {
  let bad = 0;
  if (mine.length !== theirs.length) {
    faults.push(`${name}: pipeline ${theirs.length} rows, port ${mine.length}`);
    bad += 1;
  } else {
    const fields = [...new Set(theirs.flatMap((r) => Object.keys(r)))];
    for (let i = 0; i < theirs.length; i += 1) {
      for (const f of fields) {
        if (!same(theirs[i][f], mine[i][f])) {
          bad += 1;
          if (faults.length < 2000) {
            faults.push(`${name}[${i}].${f} (${theirs[i].material_code ?? theirs[i].source}): `
              + `pipeline ${JSON.stringify(theirs[i][f])}, port ${JSON.stringify(mine[i][f])}`);
          }
        }
      }
    }
  }
  summary.push(`  ${String(theirs.length).padStart(6)} ${name}${bad ? `  \u2014 ${bad} wrong` : ""}`);
}

{
  const keys = [...new Set([...Object.keys(oracle.details), ...Object.keys(ours.details)])];
  let bad = 0;
  for (const k of keys) {
    if (!same(oracle.details[k], ours.details[k])) {
      bad += 1;
      if (faults.length < 2000) {
        faults.push(`details[${JSON.stringify(k)}]: pipeline `
          + `${JSON.stringify(oracle.details[k])?.slice(0, 160)}, port `
          + `${JSON.stringify(ours.details[k])?.slice(0, 160)}`);
      }
    }
  }
  summary.push(`  ${String(keys.length).padStart(6)} detail keys${bad ? `  \u2014 ${bad} wrong` : ""}`);
}

for (const [name, mine, theirs] of [
  ["rfd_unbacked_mt", ours.rfdUnbackedMt, oracle.rfd_unbacked_mt],
  ["rfd_unbacked_materials", ours.rfdUnbackedMaterials, oracle.rfd_unbacked_materials],
  ["rfd_partly_backed_materials", ours.rfdPartlyBackedMaterials, oracle.rfd_partly_backed_materials],
]) {
  if (!same(theirs, mine)) faults.push(`${name}: pipeline ${theirs}, port ${mine}`);
  else summary.push(`  ${String(theirs).padStart(6)} ${name}`);
}

console.log(`${stockRows.length.toLocaleString("en-US")} stock rows reconciled against ${rfdRows.length} RFD rows.`);
for (const line of summary) console.log(line);

if (faults.length) {
  console.error(`\n${faults.length} difference(s):`);
  for (const fault of faults.slice(0, 25)) console.error(`  - ${fault}`);
  if (faults.length > 25) console.error(`  … and ${faults.length - 25} more, not shown.`);
  process.exit(1);
}
console.log("\nEvery analysis row, batch drill-down and reconciliation verdict matches.");
