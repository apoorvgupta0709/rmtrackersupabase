/**
 * Does the ported code repository match the pipeline's, row and window?
 *
 *     node tools/check_section_repository.mjs /tmp/port/oracle.json --as-of 2026-08-14
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot, readSalesLedger } from "../lib/pipeline/source.ts";
import { materialDimension } from "../lib/pipeline/sections/material.ts";
import { salesMapping, oemMapOf } from "../lib/pipeline/sections/sales.ts";
import { codeRepository } from "../lib/pipeline/sections/repository.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
const asOf = process.argv.includes("--as-of")
  ? process.argv[process.argv.indexOf("--as-of") + 1] : "2026-08-14";
if (!oraclePath) {
  console.error("Usage: node tools/check_section_repository.mjs <data.json> [--as-of YYYY-MM-DD]");
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
const sales = salesMapping(ledger, oemRows, dimension, asOf.slice(0, 7));
const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));

// The window names which source the pipeline read, so the check follows it rather than
// guessing: no history slot is uploaded today, so it falls back to the published month.
const sourceFile = oracle.code_repository?.window?.source ?? "sales.xlsx";
const ours = codeRepository(sales.published, dimension, oemMapOf(oemRows), sourceFile);

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
const theirs = oracle.code_repository?.rows ?? [];
let bad = 0;
if (ours.rows.length !== theirs.length) {
  faults.push(`code_repository: pipeline ${theirs.length} rows, port ${ours.rows.length}`);
} else {
  const fields = [...new Set(theirs.flatMap((r) => Object.keys(r)))];
  for (let i = 0; i < theirs.length; i += 1) {
    for (const f of fields) {
      if (!same(theirs[i][f], ours.rows[i][f])) {
        bad += 1;
        if (faults.length < 2000) {
          faults.push(`rows[${i}].${f} (${theirs[i].material_code}): pipeline `
            + `${JSON.stringify(theirs[i][f])}, port ${JSON.stringify(ours.rows[i][f])}`);
        }
      }
    }
  }
}

const theirWindow = oracle.code_repository?.window ?? {};
for (const f of Object.keys(theirWindow)) {
  if (!same(theirWindow[f], ours.window[f])) {
    faults.push(`window.${f}: pipeline ${JSON.stringify(theirWindow[f])}, `
      + `port ${JSON.stringify(ours.window[f])}`);
  }
}

console.log(`${sales.published.length.toLocaleString("en-US")} published sales lines `
  + `-> ${ours.rows.length} repository rows (pipeline: ${theirs.length}).`);
console.log(`  window fields: ${Object.keys(theirWindow).length}`);

if (faults.length) {
  console.error(`\n${faults.length} difference(s):`);
  for (const fault of faults.slice(0, 20)) console.error(`  - ${fault}`);
  if (faults.length > 20) console.error(`  ... and ${faults.length - 20} more.`);
  process.exit(1);
}
console.log("\nEvery repository row and every window figure matches the pipeline.");
