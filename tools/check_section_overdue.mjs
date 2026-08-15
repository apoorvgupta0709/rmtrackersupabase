/**
 * Does the ported overdue section build the same rows the pipeline builds?
 *
 * The first section of the port, and the one chosen to prove the mechanism rather than to
 * be difficult: `overdue_analysis` is a leaf — nothing downstream reads it, it owns its own
 * two drill-down prefixes, it feeds one tab, and no QC floor depends on it. If the shape of
 * this check does not work here it will not work anywhere.
 *
 * It reads the same dumps the pipeline read, runs the port over them, and diffs the result
 * against an oracle produced by the pipeline itself for the same `--as-of`:
 *
 *     ./.venv/bin/python .claude/skills/refresh-tvsm-dashboard/scripts/refresh_from_supabase.py \
 *         --as-of 2026-08-14 --dry-run
 *     node tools/check_section_overdue.mjs <that run's data.json> --as-of 2026-08-14
 *
 * The oracle must be *fresh*. The committed `data.json` is the frozen 7 August build and
 * the dumps have moved since, so checking against it would report the calendar as a defect.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot } from "../lib/pipeline/source.ts";
import { overdueAnalysis } from "../lib/pipeline/sections/overdue.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const oraclePath = argv.find((a) => !a.startsWith("--") && a.endsWith(".json"));
const asOf = flag("as-of", "2026-08-14");

if (!oraclePath) {
  console.error("Usage: node tools/check_section_overdue.mjs <oracle data.json> [--as-of YYYY-MM-DD]");
  process.exit(2);
}

/* ---- credentials, from the same file the pipeline reads -------------------- */

const env = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(2);
}

/* ---- run both sides -------------------------------------------------------- */

const [receivables, oemRows] = await Promise.all([
  readSlot("receivables", { root, url, key }),
  readSlot("oem_key", { root, url, key }),
]);

const ours = overdueAnalysis(receivables, oemRows, asOf);
const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));

/* ---- diff, by the same rules as the payload differ ------------------------- */

const closeEnough = (a, b) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function differences(left, right, path) {
  if (kindOf(left) === "object" && kindOf(right) === "object") {
    const faults = [];
    for (const k of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const here = path ? `${path}.${k}` : k;
      if (!(k in left)) faults.push(`${here}: only in the port`);
      else if (!(k in right)) faults.push(`${here}: only in the pipeline`);
      else faults.push(...differences(left[k], right[k], here));
    }
    return faults;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return [`${path}: ${left.length} in the pipeline, ${right.length} in the port`];
    }
    return left.flatMap((v, i) => differences(v, right[i], `${path}[${i}]`));
  }
  if (typeof left === "number" && typeof right === "number") {
    return closeEnough(left, right) ? []
      : [`${path}: pipeline ${left}, port ${right}`];
  }
  if (left !== right) {
    return [`${path}: pipeline ${JSON.stringify(left)}, port ${JSON.stringify(right)}`];
  }
  return [];
}

const faults = [];

faults.push(...differences(oracle.overdue_analysis ?? [], ours.rows, "overdue_analysis"));

// The drill-downs, which are more than half the section's real output and where a wrong
// sort or a wrong key hides: a key that never matches opens an empty modal, silently.
const oracleDetails = Object.fromEntries(Object.entries(oracle.stock_details ?? {})
  .filter(([k]) => k.startsWith("OVERDUE|") || k.startsWith("OFFSET|")));
// A drill-down whose value is an empty list writes no rows, so the pipeline's own payload
// keeps the key while the build does not. Compare against the payload, which keeps it.
faults.push(...differences(oracleDetails, ours.details, "stock_details"));

const oracleQc = oracle.qc?.receivables ?? null;
if (oracleQc && oracleQc.excluded_by_nature) {
  faults.push(...differences(oracleQc.excluded_by_nature, ours.excluded, "qc.excluded_by_nature"));
}

/* ---- report ---------------------------------------------------------------- */

console.log(`${receivables.length.toLocaleString("en-US")} receivable rows, `
  + `${oemRows.length} OEM key rows, as of ${asOf}.`);
console.log(`${ours.rows.length} ancillaries, `
  + `${Object.keys(ours.details).length} drill-downs, `
  + `${ours.unmapped.length} unmapped, `
  + `${Object.keys(ours.excluded).length} excluded natures.`);

if (faults.length) {
  console.error(`\n${faults.length} difference(s) against the pipeline:`);
  for (const fault of faults.slice(0, 40)) console.error(`  - ${fault}`);
  if (faults.length > 40) {
    console.error(`  … and ${faults.length - 40} more (raise the cap in this file to see them).`);
  }
  process.exit(1);
}
console.log("The ported section builds exactly what the pipeline builds.");
