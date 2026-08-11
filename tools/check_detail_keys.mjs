/**
 * Does every drill-down on the page actually reach a breakup?
 *
 * `views.ts` says which figures open the lines behind them, as templates resolved
 * against the row — `{stock_detail_key}`, `LLSCHEDULE|{bucket}`. Nothing type-checks a
 * template: rename a field in the pipeline and the column keeps compiling and starts
 * opening nothing. So this resolves every template against every row of the published
 * `data.json` and checks the key against the drill-downs the same build produced.
 *
 * It also checks the prefixes reached this way are all mapped to a tab in
 * `detail_prefix_views`, because an unmapped prefix is not a broken link — it is a
 * breakup that `can_read_prefix` refuses to everyone but an admin.
 *
 * Run:  node tools/check_detail_keys.mjs [path/to/data.json]
 * Exits non-zero, and says which column and which row, if anything is unreachable.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { VIEWS } from "../app/dashboard/[view]/views.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(process.argv[2] ?? join(root, "data.json"), "utf8"));
const seed = readFileSync(
  join(root, "supabase/migrations/20260809181849_seed_section_and_prefix_view_map.sql"),
  "utf8",
);

/* ---- data.json in the shape the database serves it ------------------------ */
/* Mirrors ROW_SECTIONS and WRAPPED_SECTIONS in the pipeline's `sinks.py`. */

const ROW_SECTIONS = [
  "customer_lines", "customer_summary",
  "megh_tracker", "megh_bop_added", "megh_length_bucketing", "megh_unmapped",
  "ll_tracker",
  "missing_mappings", "stock_unmapped", "rfd_unmapped", "wip_unmapped",
  "sales_summary", "overdue_analysis",
];

const WRAPPED_SECTIONS = {
  transfers: [["rows", "transfers"]],
  str_plan: [["rows", "str_plan"]],
  orders: [["rows", "orders"], ["unmapped", "orders_unmapped"]],
  sku_pricing: [["rows", "sku_pricing"], ["unpriced", "sku_pricing_unpriced"]],
  code_repository: [["rows", "code_repository"]],
  signoff: [["unmapped", "signoff_unmapped"]],
  stock_analysis: [["ctl", "stock_analysis_ctl"], ["ll", "stock_analysis_ll"],
                   ["source_coverage", "stock_source_coverage"]],
  sales_trend: [["buckets", "trend_buckets"],
                ["customer_skus", "trend_customer_skus"],
                ["customer_sku_history", "trend_customer_sku_history"],
                ["plants", "trend_plants"]],
};

const sections = {};
for (const name of ROW_SECTIONS) {
  if (Array.isArray(data[name])) sections[name] = data[name];
}
const scalars = { ...data };
for (const [source, mappings] of Object.entries(WRAPPED_SECTIONS)) {
  const block = data[source];
  if (!block || typeof block !== "object") continue;
  const taken = new Set();
  for (const [field, section] of mappings) {
    if (Array.isArray(block[field])) sections[section] = block[field];
    taken.add(field);
  }
  scalars[source] = Object.fromEntries(
    Object.entries(block).filter(([k]) => !taken.has(k)),
  );
}

const details = data.stock_details ?? {};
const seededPrefixes = new Set(
  [...seed.matchAll(/\('([A-Z0-9]+)',\s*'\w+View'\)/g)].map((m) => m[1]),
);

/* ---- The same resolution the table does ----------------------------------- */

const get = (row, field) => {
  if (!field.includes(".")) return row[field];
  const [head, ...rest] = field.split(".");
  const inner = row[head];
  return inner && typeof inner === "object" ? inner[rest.join(".")] : undefined;
};

function fill(template, row) {
  let missing = false;
  const filled = template.replace(/\{([^}]+)\}/g, (_, field) => {
    const value = get(row, field);
    if (value === null || value === undefined || value === "") missing = true;
    return String(value ?? "");
  });
  return missing ? null : filled;
}

/* ---- Walk every view, both units ------------------------------------------ */

const problems = [];
const notes = [];
const reached = new Set();
let columnsChecked = 0;
let buttonsChecked = 0;
let hollow = 0;

for (const [viewKey, spec] of Object.entries(VIEWS)) {
  for (const unit of spec.unitToggle ? ["mt", "nos"] : ["mt"]) {
    const ctx = {
      months: scalars.sales_trend?.months ?? [],
      quarters: scalars.sku_pricing?.quarters ?? [],
      unit,
      scalars,
    };
    for (const table of spec.tables(ctx)) {
      let rows = [];
      if (table.section) {
        rows = sections[table.section] ?? [];
        if (table.flatten) rows = table.flatten(rows);
      } else if (table.scalar) {
        const [key, field] = table.scalar;
        const value = scalars[key]?.[field];
        rows = Array.isArray(value) ? value : [];
      }

      for (const column of table.columns) {
        if (!column.detail) continue;
        columnsChecked += 1;
        const where = `${viewKey}/${table.key}/${column.field} (${unit})`;
        let opened = 0;
        const missing = [];

        for (const row of rows) {
          if (column.detail.when !== undefined && !get(row, column.detail.when)) continue;
          const key = fill(column.detail.key, row);
          if (key === null) continue;
          opened += 1;
          buttonsChecked += 1;
          reached.add(key.split("|", 1)[0]);
          if (!(key in details) && missing.length < 3) missing.push(key);
          // A key whose list is empty writes no rows, so it is not in the database at
          // all and the panel opens on its empty state. Counted rather than failed:
          // that is the honest answer for a pool with nothing in it.
          else if (!details[key]?.length) hollow += 1;
        }

        if (missing.length) {
          problems.push(`${where}: ${missing.length}+ of ${opened} buttons open a key `
            + `that is not in stock_details, e.g. ${missing.join(", ")}`);
        }
        // A column nothing can open is a column that will never be noticed as broken —
        // unless it is guarded, in which case a build where every figure in it is zero
        // is a quiet month rather than a rename. Said either way, failed only when the
        // template itself is what never resolved.
        if (rows.length && opened === 0) {
          const message = `${where}: no row in ${rows.length} opens anything`;
          if (column.detail.when === undefined) {
            problems.push(`${message} — the field behind the key is probably renamed`);
          } else {
            notes.push(`${message}; every row's ${column.detail.when} is zero on this build`);
          }
        }
        // The title has to resolve too, or the panel opens headed by its column label.
        const sample = rows.find(
          (row) => (column.detail.when === undefined || get(row, column.detail.when))
            && fill(column.detail.key, row) !== null,
        );
        if (sample && fill(column.detail.title, sample) === null) {
          problems.push(`${where}: the title template resolves to nothing on a row that opens`);
        }
      }
    }
  }
}

for (const prefix of [...reached].sort()) {
  if (!seededPrefixes.has(prefix)) {
    problems.push(`prefix ${prefix} is opened by the page but is not in detail_prefix_views — `
      + "can_read_prefix will refuse it to every account but admin");
  }
}

console.log(`${columnsChecked} drill-down columns, ${buttonsChecked} buttons, `
  + `${reached.size} prefixes: ${[...reached].sort().join(" ")}`);
console.log(`${hollow} of those buttons open a pool with no lines in it.`);

// The prefixes this build produced that nothing on the page opens. SCHEDULE, BALANCE and
// TRENDMONTH are the headline-card breakups, which the fact strip does not open; anything
// else appearing here is a breakup the pipeline builds and no reader can reach.
const unreached = [...new Set(Object.keys(details).map((k) => k.split("|", 1)[0]))]
  .filter((p) => !reached.has(p))
  .sort();
if (unreached.length) console.log(`Not opened from any table: ${unreached.join(" ")}`);
for (const note of notes) console.log(`Note: ${note}`);

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("Every drill-down on the page reaches a breakup this build produced.");
