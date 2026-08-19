/**
 * Does the ported sales mapping resolve the same lines the pipeline resolves?
 *
 * The other shared intermediate. Its six lookups decide which customer's tonnage lands on
 * which tracker row, and which sales order a schedule line is offered — none of them is
 * published, so a disagreement surfaces as a figure on a tab rather than as an error.
 *
 *     DUMP_SALES_MAPS=/tmp/sales.json \
 *       ./.venv/bin/python .claude/skills/refresh-tvsm-dashboard/scripts/refresh_from_supabase.py \
 *         --as-of 2026-08-14 --dry-run
 *     node tools/check_section_sales.mjs /tmp/sales.json /tmp/dim.json
 *
 * Every key of every lookup is compared, not a sample.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot, readSalesLedger } from "../lib/pipeline/source.ts";
import { materialDimension } from "../lib/pipeline/sections/material.ts";
import { salesMapping } from "../lib/pipeline/sections/sales.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [salesOracle, dimOracle] = process.argv.slice(2).filter((a) => a.endsWith(".json"));
if (!salesOracle) {
  console.error("Usage: node tools/check_section_sales.mjs <sales maps.json> [<dimension.json>]");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => {
      const at = l.indexOf("=");
      return [l.slice(0, at).trim(), l.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

/* ---- both sides ------------------------------------------------------------ */

const oracle = JSON.parse(readFileSync(salesOracle, "utf8"));

const [bucketting, zmat, oemRows, ledger, assignmentRows] = await Promise.all([
  readSlot("bucketting", { root, url, key }),
  readSlot("zmat", { root, url, key }),
  readSlot("oem_key", { root, url, key }),
  readSalesLedger({ url, key }),
  fetch(`${url}/rest/v1/bucket_assignments?select=scope,material_code,assigned_to`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }).then((r) => r.json()),
]);

const assignments = {
  bucket: Object.fromEntries(assignmentRows
    .filter((a) => a.scope === "bucket").map((a) => [a.material_code, a.assigned_to])),
};

const dimension = materialDimension(bucketting, zmat, assignments);

// The dimension this is built on has its own check; if its dump is to hand, confirm it
// still agrees rather than letting a fault there be reported as a fault here.
if (dimOracle) {
  const dim = JSON.parse(readFileSync(dimOracle, "utf8"));
  const drift = [...dimension.materialBucket].filter(([k, v]) => dim.material_bucket[k] !== v);
  if (drift.length) {
    console.error(`The material dimension disagrees on ${drift.length} code(s) — `
      + "fix that first; this check is downstream of it.");
    process.exit(1);
  }
}

// The OEM queue answers into `oem_map`, and the pipeline applies it there rather than at
// the customer join — so the check has to hand the port the same set the pipeline read,
// or the two would agree only while nobody had answered that queue.
const oemAssigned = {
  oem: Object.fromEntries(assignmentRows.filter((a) => a.scope === "oem" && a.assigned_to)
    .map((a) => [a.material_code, a.assigned_to])),
};

const ours = salesMapping(ledger, oemRows, dimension, oracle.published_month, oemAssigned);

/* ---- compare --------------------------------------------------------------- */

const near = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y)
    && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
};

const same = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.every((k) => same(a[k], b[k]));
  }
  if (typeof a === "number" || typeof b === "number") {
    if (near(a, b)) return true;
  }
  return (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
};

const LOOKUPS = [
  ["sales_lookup", ours.salesLookup],
  ["code_oem", ours.codeOem],
  ["so_by_customer_ctl", ours.soByCustomerCtl],
  ["so_by_ctl_plant", ours.soByCtlPlant],
  ["so_by_ctl", ours.soByCtl],
  ["so_by_customer_material", ours.soByCustomerMaterial],
  ["so_by_material", ours.soByMaterial],
];

const faults = [];
const summary = [];
let comparisons = 0;

if (ours.all.length !== oracle.ledger_rows) {
  faults.push(`ledger_rows: pipeline ${oracle.ledger_rows}, port ${ours.all.length}`);
}
if (ours.published.length !== oracle.published_rows) {
  faults.push(`published_rows: pipeline ${oracle.published_rows}, port ${ours.published.length}`);
}

for (const [name, mine] of LOOKUPS) {
  const theirs = oracle[name] ?? {};
  const keys = [...new Set([...Object.keys(theirs), ...mine.keys()])];
  let bad = 0;
  for (const k of keys) {
    comparisons += 1;
    const inTheirs = k in theirs;
    const inMine = mine.has(k);
    if (inTheirs !== inMine) {
      bad += 1;
      if (faults.length < 3000) {
        faults.push(`${name}[${JSON.stringify(k)}]: only in the ${inTheirs ? "pipeline" : "port"}`);
      }
    } else if (!same(theirs[k], mine.get(k))) {
      bad += 1;
      if (faults.length < 3000) {
        faults.push(`${name}[${JSON.stringify(k)}]: pipeline ${JSON.stringify(theirs[k])}, `
          + `port ${JSON.stringify(mine.get(k))}`);
      }
    }
  }
  summary.push(`  ${String(keys.length).padStart(7)} keys  ${name}${bad ? `  — ${bad} wrong` : ""}`);
}

/* ---- report ---------------------------------------------------------------- */

console.log(`${ledger.length.toLocaleString("en-US")} ledger lines, `
  + `${ours.published.length.toLocaleString("en-US")} in ${oracle.published_month}, `
  + `${oemRows.length} OEM key rows.`);
console.log(`${comparisons.toLocaleString("en-US")} keys compared across ${LOOKUPS.length} lookups:`);
for (const line of summary) console.log(line);

if (faults.length) {
  const byLookup = new Map();
  for (const fault of faults) {
    const at = fault.indexOf("[");
    const name = at === -1 ? fault.split(":")[0] : fault.slice(0, at);
    byLookup.set(name, (byLookup.get(name) ?? 0) + 1);
  }
  console.error(`\n${faults.length} disagreement(s), in ${byLookup.size} lookup(s):`);
  for (const [name, count] of [...byLookup].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(count).padStart(7)}  ${name}`);
  }
  console.error("");
  for (const fault of faults.slice(0, 25)) console.error(`  - ${fault}`);
  if (faults.length > 25) console.error(`  … and ${faults.length - 25} more, not shown.`);
  process.exit(1);
}
console.log("\nEvery key of every lookup resolves exactly as the pipeline resolves it.");
