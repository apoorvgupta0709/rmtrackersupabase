/**
 * Does every figure that claims a verdict actually get one?
 *
 * `views.ts` says which columns are inked by severity, and it says so with field names
 * written as strings — `from: "risk"`, `when: "high_age_mt"` — plus, for the word form, a
 * map of the verdicts the pipeline is expected to publish. **Nothing type-checks any of
 * that.** Rename `risk` in the pipeline and the column keeps compiling, keeps rendering,
 * and silently stops colouring; add a fifth verdict and the rows carrying it quietly fall
 * out of the map. The failure is invisible in exactly the way that matters, because an
 * uninked figure looks like a healthy one.
 *
 * This is the same argument `check_detail_keys.mjs` makes about drill-down templates, and
 * it resolves severity the same way the table does, against a published build.
 *
 * Run:  node tools/check_severity_fields.mjs [path/to/data.json]
 * Exits non-zero, naming the view, table and column, if anything cannot be judged.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { VIEWS } from "../app/dashboard/[view]/views.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(process.argv[2] ?? join(root, "data.json"), "utf8"));

/* ---- data.json in the shape the database serves it ------------------------ */
/* Mirrors ROW_SECTIONS and WRAPPED_SECTIONS in the pipeline's `sinks.py`, exactly as
   `check_detail_keys.mjs` does. Kept in step with that file by hand; the two would be
   worth sharing a module if a third checker ever needs the same shaping. */

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

/* ---- The same resolution the table does ----------------------------------- */

const get = (row, field) => {
  if (!field.includes(".")) return row[field];
  const [head, ...rest] = field.split(".");
  const inner = row[head];
  return inner && typeof inner === "object" ? inner[rest.join(".")] : undefined;
};

/** `severityOf` in `table.tsx`, kept deliberately in step with it. */
function severityOf(column, row) {
  const s = column.severity;
  if (!s) return null;
  if (s.when !== undefined && !get(row, s.when)) return null;
  const value = get(row, s.from ?? column.field);
  if (s.words) {
    if (value === null || value === undefined) return null;
    return s.words[String(value)] ?? null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (s.direction === "low") {
    if (s.alert !== undefined && value < s.alert) return "alert";
    if (s.attention !== undefined && value < s.attention) return "attention";
    return "ok";
  }
  if (s.direction === "high") {
    if (s.alert !== undefined && value >= s.alert) return "alert";
    if (s.attention !== undefined && value >= s.attention) return "attention";
    return "ok";
  }
  return null;
}

/* ---- Walk every view ------------------------------------------------------ */

const problems = [];
const tally = [];
let columnsChecked = 0;

for (const [viewKey, spec] of Object.entries(VIEWS)) {
  const picks = spec.pick
    ? [...new Set((sections[spec.pick.from.section] ?? [])
        .map((row) => String(row[spec.pick.from.field] ?? "")).filter(Boolean))]
    : [undefined];

  const seen = new Set();

  for (const pick of picks) {
    const ctx = {
      months: scalars.sales_trend?.months ?? [],
      quarters: scalars.sku_pricing?.quarters ?? [],
      unit: "mt",
      scalars,
      pick,
    };

    for (const table of spec.tables(ctx)) {
      let rows = [];
      if (table.section) {
        rows = sections[table.section] ?? [];
      } else if (table.scalar) {
        const [key, field] = table.scalar;
        const value = scalars[key]?.[field];
        rows = Array.isArray(value) ? value : [];
      }
      if (table.flatten) rows = table.flatten(rows, { sections, pick });
      if (!rows.length) continue;

      for (const column of table.columns) {
        const s = column.severity;
        if (!s) continue;
        const where = `${viewKey}/${table.key}/${column.field}`;
        // A tab with a selector renders the same table once per selection; the question
        // here is about the section, so each column is judged once.
        if (seen.has(where)) continue;
        seen.add(where);
        columnsChecked += 1;

        // A field no row has ever heard of is a rename, and it is the whole point of this
        // check. A field present and null everywhere is a different thing — an empty
        // answer — so presence is tested on the key, not on the value.
        for (const [role, field] of [["from", s.from], ["when", s.when]]) {
          if (!field) continue;
          if (!rows.some((row) => get(row, field) !== undefined)) {
            problems.push(`${where}: \`${role}: "${field}"\` names a field no row of `
              + `${table.section ?? table.scalar?.join(".")} carries (${rows.length} rows)`);
          }
        }
        if (!s.from && !s.words && !rows.some((r) => get(r, column.field) !== undefined)) {
          problems.push(`${where}: the column's own field is on no row of `
            + `${table.section ?? table.scalar?.join(".")} (${rows.length} rows)`);
        }

        // A verdict the map does not list takes no ink, which is right for "No demand"
        // and wrong for anything the pipeline started publishing since. So the map must
        // account for every word actually present, `null` included.
        if (s.words) {
          const field = s.from ?? column.field;
          const unlisted = [...new Set(rows
            .map((row) => get(row, field))
            .filter((v) => v !== null && v !== undefined)
            .map(String)
            .filter((v) => !(v in s.words)))];
          if (unlisted.length) {
            problems.push(`${where}: \`${field}\` carries ${unlisted.length} verdict(s) `
              + `the map does not list, so they take no ink: ${unlisted.join(", ")}`);
          }
        }

        const bands = { alert: 0, attention: 0, ok: 0, none: 0 };
        for (const row of rows) bands[severityOf(column, row) ?? "none"] += 1;
        tally.push(`  ${where.padEnd(52)} `
          + `${String(bands.alert).padStart(4)} alert  `
          + `${String(bands.attention).padStart(4)} attention  `
          + `${String(bands.ok).padStart(4)} ok  `
          + `${String(bands.none).padStart(4)} plain`);

        // A column that inks nothing at all is a column nobody will notice is broken.
        if (bands.alert + bands.attention + bands.ok === 0) {
          problems.push(`${where}: not one of ${rows.length} rows takes any ink`);
        }
      }
    }
  }
}

console.log(`Severity columns checked: ${columnsChecked}`);
console.log(tally.join("\n"));

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nEvery severity column resolves against the published build.");
