/**
 * Do the mapping queues and the resolved customer tracker match the pipeline's?
 *
 *            .claude/skills/refresh-tvsm-dashboard/scripts/refresh_from_supabase.py \
 *       --as-of 2026-08-14 --dry-run
 *     node tools/check_section_missing.mjs /tmp/port/oracle.json --as-of 2026-08-14
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
const asOf = process.argv.includes("--as-of")
  ? process.argv[process.argv.indexOf("--as-of") + 1] : "2026-08-14";
if (!oraclePath) {
  console.error("Usage: node tools/check_section_missing.mjs <data.json> [--as-of YYYY-MM-DD]");
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
const oemMap = oemMapOf(oemRows);
const sales = salesMapping(ledger, oemRows, dimension, asOf.slice(0, 7));
const groups = scheduleFacts(scheduleRows, dimension, sales, oemMap);
const stock = stockPools(stockRows, rfdRows, zmat, groups, dimension, oemMap, asOf);
const wip = wipAndSummary(wipRows, bucketting, stock, dimension);
const ours = missingMappings(scheduleRows, wip.group, sales, dimension, sheet);

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

// Section 16b appends 39 "Order sign-off" entries to the same queue, and section 17 adds
// three `history_*` columns to the tracker. Neither belongs to section 8, so both are
// scoped out here rather than counted as differences — and named, so the exclusion is not
// silent.
const LATER_QUEUE = "Order sign-off";
const LATER_FIELDS = ["history_avg_month_mt", "history_months_active", "history_detail_key"];
const theirQueue = (oracle.missing_mappings ?? []).filter((r) => r.mapping_type !== LATER_QUEUE);
console.log(`Scoped out: ${(oracle.missing_mappings ?? []).length - theirQueue.length} `
  + `"${LATER_QUEUE}" queue entries (section 16b) and `
  + `${LATER_FIELDS.length} tracker columns (section 17).`);

for (const [name, mine, theirs, only] of [
  ["missing_mappings", ours.missingMappings, theirQueue, null],
  ["customer_lines", ours.group, oracle.customer_lines ?? [], "published"],
]) {
  let bad = 0;
  if (mine.length !== theirs.length) {
    faults.push(`${name}: pipeline ${theirs.length} rows, port ${mine.length}`);
  } else {
    const fields = [...new Set(theirs.flatMap((r) => Object.keys(r)))]
      .filter((f) => f !== "customer_codes" && !LATER_FIELDS.includes(f));
    for (let i = 0; i < theirs.length; i += 1) {
      for (const f of fields) {
        if (!same(theirs[i][f], mine[i][f])) {
          bad += 1;
          if (faults.length < 2000) {
            faults.push(`${name}[${i}].${f}: pipeline ${JSON.stringify(theirs[i][f])}, `
              + `port ${JSON.stringify(mine[i][f])}`);
          }
        }
      }
    }
  }
  summary.push(`  ${String(theirs.length).padStart(6)} ${name}${bad ? `  - ${bad} wrong` : ""}`);
}

console.log(`${scheduleRows.length} schedule rows, ${ours.group.length} tracker rows.`);
for (const line of summary) console.log(line);

if (faults.length) {
  console.error(`\n${faults.length} difference(s):`);
  for (const fault of faults.slice(0, 25)) console.error(`  - ${fault}`);
  if (faults.length > 25) console.error(`  … and ${faults.length - 25} more, not shown.`);
  process.exit(1);
}
console.log("\nEvery queue entry and every resolved tracker row matches the pipeline.");
