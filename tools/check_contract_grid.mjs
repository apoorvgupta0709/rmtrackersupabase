/**
 * Does the raw cell-grid read reach every contract row the build priced against?
 *
 * `contract:*` is the one slot family with no table — read positionally, because its
 * quarters are column offsets rather than named fields. So it is the one read that cannot
 * be checked by comparing column names, and this checks it the only way that means
 * anything: every `contract_key` the published build quotes must be findable in the grid,
 * at the column `PRICING_SHEETS` says holds it.
 *
 *     node tools/check_contract_grid.mjs /tmp/port/oracle.json
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readCellGrid } from "../lib/pipeline/source.ts";
import { sizeKey, pyStr, isNa } from "../lib/pipeline/normalise.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
if (!oraclePath) {
  console.error("Usage: node tools/check_contract_grid.mjs <data.json>");
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

// `PRICING_SHEETS`, as far as this check needs it: which column holds the size key.
const SHEETS = { ERW: { keyCol: 6 }, CEW: { keyCol: 8 } };

const grids = Object.fromEntries(await Promise.all(
  Object.keys(SHEETS).map(async (route) =>
    [route, await readCellGrid(`contract:${route}`, { url, key })])));

const faults = [];
const found = new Map();

for (const [route, { keyCol }] of Object.entries(SHEETS)) {
  const grid = grids[route];
  if (grid.length === 0) {
    faults.push(`contract:${route}: no current batch`);
    continue;
  }
  // Rows 0-2 are the three header bands: quarter group, sub-group, column name.
  let sizes = 0;
  for (const row of grid.slice(3)) {
    const cell = row[keyCol];
    if (isNa(cell)) continue;
    if (sizeKey(cell) !== null) sizes += 1;
    found.set(pyStr(cell).trim(), route);
  }
  console.log(`contract:${route}: ${grid.length} rows x ${grid[0]?.length ?? 0} columns, `
    + `${sizes} of them parsing as a size at column ${keyCol}.`);
}

// The real check: every key the build actually quoted.
const quoted = new Set((JSON.parse(readFileSync(oraclePath, "utf8")).sku_pricing?.rows ?? [])
  .map((r) => r.contract_key).filter(Boolean));

const missing = [...quoted].filter((k) => !found.has(k));
console.log(`${quoted.size} distinct contract keys quoted by the build; `
  + `${quoted.size - missing.length} reachable in the grid.`);

if (missing.length) {
  faults.push(`${missing.length} quoted key(s) not found in the grid: `
    + missing.slice(0, 5).join(", "));
}

if (faults.length) {
  console.error("");
  for (const fault of faults) console.error(`  - ${fault}`);
  process.exit(1);
}
console.log("\nEvery contract row the build priced against is reachable in the raw grid.");
