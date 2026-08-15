/**
 * Does the ported stock section build the same pools and drill-downs?
 *
 * Section 4 decides what stock a schedule line is shown as covered by, and the RFD 4731
 * reconciliation decides which SAP materials are told to write themselves off — so this is
 * the section where a disagreement costs money rather than tidiness.
 *
 *     DUMP_STOCK=/tmp/port/stock.json \
 *       ./.venv/bin/python .claude/skills/refresh-tvsm-dashboard/scripts/refresh_from_supabase.py \
 *         --as-of 2026-08-14 --dry-run
 *     node tools/check_section_stock.mjs /tmp/port/stock.json
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot, readSalesLedger } from "../lib/pipeline/source.ts";
import { materialDimension } from "../lib/pipeline/sections/material.ts";
import { salesMapping, oemMapOf } from "../lib/pipeline/sections/sales.ts";
import { scheduleFacts } from "../lib/pipeline/sections/schedule.ts";
import { stockPools } from "../lib/pipeline/sections/stock.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
const asOf = process.argv.includes("--as-of")
  ? process.argv[process.argv.indexOf("--as-of") + 1] : "2026-08-14";
if (!oraclePath) {
  console.error("Usage: node tools/check_section_stock.mjs <stock.json> [--as-of YYYY-MM-DD]");
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

const [bucketting, zmat, oemRows, ledger, scheduleRows, stockRows, rfdRows, assignmentRows] =
  await Promise.all([
    readSlot("bucketting", { root, url, key }),
    readSlot("zmat", { root, url, key }),
    readSlot("oem_key", { root, url, key }),
    readSalesLedger({ url, key }),
    readSlot("schedule", { root, url, key, sheet }),
    readSlot("stock", { root, url, key }),
    readSlot("rfd", { root, url, key }),
    fetch(`${url}/rest/v1/bucket_assignments?select=scope,material_code,assigned_to`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }).then((r) => r.json()),
  ]);

const dimension = materialDimension(bucketting, zmat, {
  bucket: Object.fromEntries(assignmentRows
    .filter((a) => a.scope === "bucket").map((a) => [a.material_code, a.assigned_to])),
});
const oemMap = oemMapOf(oemRows);
const sales = salesMapping(ledger, oemRows, dimension, asOf.slice(0, 7));
const groups = scheduleFacts(scheduleRows, dimension, sales, oemMap);
const ours = stockPools(stockRows, rfdRows, zmat, groups, dimension, oemMap, asOf);

const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));

/* ---- compare --------------------------------------------------------------- */

const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const same = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.every((k) => same(a[k], b[k]));
  }
  if (typeof a === "number" && typeof b === "number") return near(a, b);
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return near(x, y);
  }
  return (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
};

const faults = [];
const summary = [];

// The stock columns added to each schedule group, in order.
const STOCK_FIELDS = [
  "ll_stock_789_mt", "ll_stock_788_mt", "ll_stock_4731_mt", "ll_stock_8406_mt",
  "ctl_stock_789_nos", "ctl_stock_789_mt", "ctl_stock_4731_nos", "ctl_stock_4731_mt",
  "ctl_stock_pool_nos", "ctl_stock_pool_mt", "ll_stock_pool_mt",
  "ctl_stock_detail_key", "ll_stock_detail_key",
];
if (ours.group.length !== oracle.group.length) {
  faults.push(`group rows: pipeline ${oracle.group.length}, port ${ours.group.length}`);
} else {
  let bad = 0;
  for (let i = 0; i < oracle.group.length; i += 1) {
    for (const f of STOCK_FIELDS) {
      if (!same(oracle.group[i][f], ours.group[i][f])) {
        bad += 1;
        if (faults.length < 2000) {
          faults.push(`group[${i}].${f} (${oracle.group[i].customer_display} / `
            + `${oracle.group[i].ctl_bucket}): pipeline `
            + `${JSON.stringify(oracle.group[i][f])}, port ${JSON.stringify(ours.group[i][f])}`);
        }
      }
    }
  }
  summary.push(`  ${String(oracle.group.length).padStart(6)} groups x ${STOCK_FIELDS.length}`
    + ` stock fields${bad ? `  — ${bad} wrong` : ""}`);
}

for (const [name, mine, theirs] of [
  ["details", ours.details, oracle.details],
  ["rfd_recovered", ours.rfdRecovered, oracle.rfd_recovered],
  ["rfd_unrecovered", ours.rfdUnrecovered, oracle.rfd_unrecovered],
  ["rfd_backed_materials", ours.rfdBackedMaterials, oracle.rfd_backed_materials],
]) {
  let bad = 0;
  if (Array.isArray(theirs)) {
    if (mine.length !== theirs.length) {
      faults.push(`${name}: pipeline ${theirs.length} entries, port ${mine.length}`);
      bad += 1;
    } else {
      for (let i = 0; i < theirs.length; i += 1) {
        if (!same(theirs[i], mine[i])) {
          bad += 1;
          if (faults.length < 2000) {
            faults.push(`${name}[${i}]: pipeline ${JSON.stringify(theirs[i])}, `
              + `port ${JSON.stringify(mine[i])}`);
          }
        }
      }
    }
    summary.push(`  ${String(theirs.length).padStart(6)} ${name}${bad ? `  — ${bad} wrong` : ""}`);
  } else {
    const keys = [...new Set([...Object.keys(theirs), ...Object.keys(mine)])];
    for (const k of keys) {
      if (!same(theirs[k], mine[k])) {
        bad += 1;
        if (faults.length < 2000) {
          faults.push(`${name}[${JSON.stringify(k)}]: pipeline `
            + `${JSON.stringify(theirs[k])?.slice(0, 200)}, port `
            + `${JSON.stringify(mine[k])?.slice(0, 200)}`);
        }
      }
    }
    summary.push(`  ${String(keys.length).padStart(6)} ${name} keys${bad ? `  — ${bad} wrong` : ""}`);
  }
}

console.log(`${stockRows.length.toLocaleString("en-US")} stock rows, ${rfdRows.length} RFD rows, `
  + `${groups.length} schedule groups.`);
for (const line of summary) console.log(line);

if (faults.length) {
  console.error(`\n${faults.length} difference(s):`);
  for (const fault of faults.slice(0, 25)) console.error(`  - ${fault}`);
  if (faults.length > 25) console.error(`  … and ${faults.length - 25} more, not shown.`);
  process.exit(1);
}
console.log("\nEvery pool, drill-down and reconciliation matches the pipeline's.");
