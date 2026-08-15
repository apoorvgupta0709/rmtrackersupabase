/**
 * Does the ported material dimension resolve every code the pipeline resolves?
 *
 * This is the shared intermediate rather than a published section — every tracker, stock
 * frame and queue joins through it — so a disagreement here does not show up as a wrong
 * figure in one place. It shows up as tonnage on the wrong tracker row, or as a code
 * sitting in the Missing mappings queue that should not be, with every total still
 * reconciling. Nothing downstream can be trusted until this is exact.
 *
 * So it is checked by **total enumeration of every key in every map**, against a dump the
 * pipeline writes of its own maps:
 *
 *     DUMP_MATERIAL_DIMENSION=/tmp/dim.json \
 *       ./.venv/bin/python .claude/skills/refresh-tvsm-dashboard/scripts/refresh_from_supabase.py \
 *         --as-of 2026-08-14 --dry-run
 *     node tools/check_section_material.mjs /tmp/dim.json
 *
 * The dump is env-gated and never on the build's path — see the note beside it in
 * `refresh_dashboard.py`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { readSlot } from "../lib/pipeline/source.ts";
import { materialDimension } from "../lib/pipeline/sections/material.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = process.argv[2];
if (!oraclePath) {
  console.error("Usage: node tools/check_section_material.mjs <material dimension dump.json>");
  process.exit(2);
}

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

/* ---- the same inputs the pipeline read ------------------------------------- */

const [bucketting, zmat] = await Promise.all([
  readSlot("bucketting", { root, url, key }),
  readSlot("zmat", { root, url, key }),
]);

// The owner's assignments, applied last so they win — the same table the pipeline reads.
const assignmentRows = await fetch(
  `${url}/rest/v1/bucket_assignments?select=scope,material_code,assigned_to`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
).then((r) => r.json());
const assignments = {
  bucket: Object.fromEntries(assignmentRows
    .filter((a) => a.scope === "bucket")
    .map((a) => [a.material_code, a.assigned_to])),
};

const ours = materialDimension(bucketting, zmat, assignments);
const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));

/* ---- compare every key of every map ---------------------------------------- */

const MAPS = [
  ["material_bucket", ours.materialBucket],
  ["material_length", ours.materialLength],
  ["description_bucket", ours.descriptionBucket],
  ["description_material", ours.descriptionMaterial],
  ["description_materials", ours.descriptionMaterials],
  ["description_length", ours.descriptionLength],
  ["fg_codes_by_description", ours.fgCodesByDescription],
  ["fg_codes_by_description_plant", ours.fgCodesByDescriptionPlant],
];

// A length arrives as a number from one side and may arrive as its string from the other,
// and `189` and `189.0` are the same length written two ways — the same reasoning
// `pricing.ts` gives for running both sides of its length comparison through `Number`.
const same = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
    }
  }
  return String(a) === String(b);
};

const faults = [];
let comparisons = 0;
const summary = [];

for (const [name, mine] of MAPS) {
  const theirs = oracle[name] ?? {};
  const keys = [...new Set([...Object.keys(theirs), ...mine.keys()])];
  let bad = 0;
  for (const k of keys) {
    comparisons += 1;
    const a = theirs[k];
    const b = mine.get(k);
    const inTheirs = k in theirs;
    const inMine = mine.has(k);
    if (inTheirs !== inMine) {
      bad += 1;
      if (faults.length < 5000) {
        faults.push(`${name}[${JSON.stringify(k)}]: only in the ${inTheirs ? "pipeline" : "port"}`
          + ` (${JSON.stringify(inTheirs ? a : b)})`);
      }
    } else if (!same(a, b)) {
      bad += 1;
      if (faults.length < 5000) {
        faults.push(`${name}[${JSON.stringify(k)}]: pipeline ${JSON.stringify(a)}, `
          + `port ${JSON.stringify(b)}`);
      }
    }
  }
  summary.push(`  ${String(keys.length).padStart(7)} keys  ${name}${bad ? `  — ${bad} wrong` : ""}`);
}

// `direct` is nested, so it is compared field by field rather than by value.
{
  const theirs = oracle.direct ?? {};
  const keys = [...new Set([...Object.keys(theirs), ...ours.direct.keys()])];
  let bad = 0;
  for (const k of keys) {
    comparisons += 1;
    const a = theirs[k];
    const b = ours.direct.get(k);
    if (!a || !b) {
      bad += 1;
      faults.push(`direct[${JSON.stringify(k)}]: only in the ${a ? "pipeline" : "port"}`);
      continue;
    }
    for (const field of ["Bucket", "LL or CTL", "CTL Bucket", "Length"]) {
      if (!same(a[field], b[field])) {
        bad += 1;
        if (faults.length < 5000) {
          faults.push(`direct[${JSON.stringify(k)}].${field}: pipeline `
            + `${JSON.stringify(a[field])}, port ${JSON.stringify(b[field])}`);
        }
        break;
      }
    }
  }
  summary.push(`  ${String(keys.length).padStart(7)} keys  direct${bad ? `  — ${bad} wrong` : ""}`);
}

/* ---- report ---------------------------------------------------------------- */

console.log(`${bucketting.length.toLocaleString("en-US")} Bucketting rows, `
  + `${zmat.length.toLocaleString("en-US")} zmat rows, `
  + `${Object.keys(assignments.bucket).length} owner assignment(s).`);
console.log(`${comparisons.toLocaleString("en-US")} keys compared across ${MAPS.length + 1} maps:`);
for (const line of summary) console.log(line);

if (faults.length) {
  const byMap = new Map();
  for (const fault of faults) {
    const map = fault.slice(0, fault.indexOf("["));
    byMap.set(map, (byMap.get(map) ?? 0) + 1);
  }
  console.error(`\n${faults.length} disagreement(s), in ${byMap.size} map(s):`);
  for (const [map, count] of [...byMap].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(count).padStart(7)}  ${map}`);
  }
  console.error("");
  for (const fault of faults.slice(0, 25)) console.error(`  - ${fault}`);
  if (faults.length > 25) console.error(`  … and ${faults.length - 25} more, not shown.`);
  process.exit(1);
}
console.log("\nEvery key of every map resolves exactly as the pipeline resolves it.");
