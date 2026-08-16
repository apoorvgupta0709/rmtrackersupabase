/**
 * Does the ported transfer section match the pipeline's, row and batch?
 *
 * `transfers` is a wrapped payload section — its rows publish as `transfers`, the plants
 * and note as a scalar beside them — so the fresh `data.json` is the oracle.
 *
 *     node tools/check_section_transfers.mjs /tmp/port/oracle.json --as-of 2026-08-14
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot } from "../lib/pipeline/source.ts";
import { materialDimension } from "../lib/pipeline/sections/material.ts";
import { transfers } from "../lib/pipeline/sections/transfers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
const asOf = process.argv.includes("--as-of")
  ? process.argv[process.argv.indexOf("--as-of") + 1] : "2026-08-14";
if (!oraclePath) {
  console.error("Usage: node tools/check_section_transfers.mjs <data.json> [--as-of YYYY-MM-DD]");
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

const [bucketting, zmat, transferRows, assignmentRows] = await Promise.all([
  readSlot("bucketting", { root, url, key }),
  readSlot("zmat", { root, url, key }),
  readSlot("transfers", { root, url, key }),
  fetch(`${url}/rest/v1/bucket_assignments?select=scope,material_code,assigned_to`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }).then((r) => r.json()),
]);

const dimension = materialDimension(bucketting, zmat, {
  bucket: Object.fromEntries(assignmentRows
    .filter((a) => a.scope === "bucket").map((a) => [a.material_code, a.assigned_to])),
});
const ours = transfers(transferRows, dimension, asOf);
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
  const theirs = oracle.transfers?.rows ?? [];
  let bad = 0;
  if (ours.rows.length !== theirs.length) {
    faults.push(`transfers: pipeline ${theirs.length} rows, port ${ours.rows.length}`);
  } else {
    const fields = [...new Set(theirs.flatMap((r) => Object.keys(r)))];
    for (let i = 0; i < theirs.length; i += 1) {
      for (const f of fields) {
        if (!same(theirs[i][f], ours.rows[i][f])) {
          bad += 1;
          if (faults.length < 2000) {
            faults.push(`transfers[${i}].${f} (${theirs[i].document}): pipeline `
              + `${JSON.stringify(theirs[i][f])}, port ${JSON.stringify(ours.rows[i][f])}`);
          }
        }
      }
    }
  }
  summary.push(`  ${String(theirs.length).padStart(5)} transfer rows${bad ? `  - ${bad} wrong` : ""}`);
}

{
  const theirs = Object.fromEntries(Object.entries(oracle.stock_details ?? {})
    .filter(([k]) => k.startsWith("TRANSFER|")));
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
  summary.push(`  ${String(keys.length).padStart(5)} TRANSFER| keys${bad ? `  - ${bad} wrong` : ""}`);
}

for (const [name, mine, theirs] of [
  ["plants", ours.plants, oracle.transfers?.plants],
  ["available", ours.available, oracle.transfers?.available],
  ["note", ours.note, oracle.transfers?.note],
]) {
  if (!same(theirs, mine)) {
    faults.push(`${name}: pipeline ${JSON.stringify(theirs)?.slice(0, 200)}, port ${JSON.stringify(mine)?.slice(0, 200)}`);
  } else summary.push(`        ${name} ok`);
}

console.log(`${transferRows.length.toLocaleString("en-US")} ledger transfer lines.`);
for (const line of summary) console.log(line);

if (faults.length) {
  console.error(`\n${faults.length} difference(s):`);
  for (const fault of faults.slice(0, 20)) console.error(`  - ${fault}`);
  if (faults.length > 20) console.error(`  ... and ${faults.length - 20} more.`);
  process.exit(1);
}
console.log("\nEvery transfer row, batch line and plant label matches the pipeline.");
