/**
 * Does the ported schedule grouping produce the same rows the pipeline produces?
 *
 * The third intermediate: the customer tracker, the LL tracker, the mapping queues and the
 * dispatch plan are all built on it, so a wrong group here is a wrong figure on four tabs
 * with nothing to say so. Row for row, field for field, in order — the order matters
 * because `build_sections.seq` is a sort position downstream.
 *
 *     DUMP_SCHEDULE_GROUP=/tmp/port/schedule.json \
 *       ./.venv/bin/python .claude/skills/refresh-tvsm-dashboard/scripts/refresh_from_supabase.py \
 *         --as-of 2026-08-14 --dry-run
 *     node tools/check_section_schedule.mjs /tmp/port/schedule.json
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot, readSalesLedger } from "../lib/pipeline/source.ts";
import { materialDimension } from "../lib/pipeline/sections/material.ts";
import { salesMapping, oemMapOf } from "../lib/pipeline/sections/sales.ts";
import { scheduleFacts } from "../lib/pipeline/sections/schedule.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
const asOf = process.argv.includes("--as-of")
  ? process.argv[process.argv.indexOf("--as-of") + 1] : "2026-08-14";
if (!oraclePath) {
  console.error("Usage: node tools/check_section_schedule.mjs <schedule.json> [--as-of YYYY-MM-DD]");
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

/* ---- both sides ------------------------------------------------------------ */

// The schedule keeps one current batch *per month sheet*, so its view can hold several
// months at once and an unfiltered read would concatenate them.
const sheet = `Schedule ${new Date(`${asOf}T00:00:00Z`)
  .toLocaleString("en-US", { month: "long", timeZone: "UTC" })}`;

const [bucketting, zmat, oemRows, ledger, scheduleRows, assignmentRows] = await Promise.all([
  readSlot("bucketting", { root, url, key }),
  readSlot("zmat", { root, url, key }),
  readSlot("oem_key", { root, url, key }),
  readSalesLedger({ url, key }),
  readSlot("schedule", { root, url, key, sheet }),
  fetch(`${url}/rest/v1/bucket_assignments?select=scope,material_code,assigned_to`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }).then((r) => r.json()),
]);

const dimension = materialDimension(bucketting, zmat, {
  bucket: Object.fromEntries(assignmentRows
    .filter((a) => a.scope === "bucket").map((a) => [a.material_code, a.assigned_to])),
});
const sales = salesMapping(ledger, oemRows, dimension, asOf.slice(0, 7));
const ours = scheduleFacts(scheduleRows, dimension, sales, oemMapOf(oemRows));

const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));
const theirs = oracle.group ?? [];

/* ---- compare --------------------------------------------------------------- */

const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const same = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
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

// Counted before compared: a length mismatch pairs row 5 against row 6 and turns one
// missing group into a difference on every field of every row after it.
if (ours.length !== theirs.length) {
  faults.push(`rows: pipeline ${theirs.length}, port ${ours.length}`);
} else {
  const fields = [...new Set(theirs.flatMap((r) => Object.keys(r)))];
  for (let i = 0; i < theirs.length; i += 1) {
    for (const field of fields) {
      if (!same(theirs[i][field], ours[i][field])) {
        faults.push(`[${i}].${field} (${theirs[i].customer_display} / `
          + `${theirs[i].ctl_bucket}): pipeline ${JSON.stringify(theirs[i][field])}, `
          + `port ${JSON.stringify(ours[i][field])}`);
      }
    }
  }
}

console.log(`${scheduleRows.length.toLocaleString("en-US")} schedule rows from "${sheet}" `
  + `-> ${ours.length} groups (pipeline: ${theirs.length}).`);

if (faults.length) {
  const byField = new Map();
  for (const fault of faults) {
    const m = /\]\.(\w+)/.exec(fault);
    const name = m ? m[1] : "rows";
    byField.set(name, (byField.get(name) ?? 0) + 1);
  }
  console.error(`\n${faults.length} difference(s), in ${byField.size} field(s):`);
  for (const [name, count] of [...byField].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(count).padStart(6)}  ${name}`);
  }
  console.error("");
  for (const fault of faults.slice(0, 25)) console.error(`  - ${fault}`);
  if (faults.length > 25) console.error(`  … and ${faults.length - 25} more, not shown.`);
  process.exit(1);
}
console.log("Every group matches the pipeline's, field for field and in order.");
