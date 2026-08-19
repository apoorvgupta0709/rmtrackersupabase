/**
 * Does the Missing mappings tab hold together?
 *
 *     node tools/check_mapping_tab.mjs
 *
 * Three things on that tab fail *silently* when they are wrong, which is the only reason
 * this file exists. None of them throws, none shows an error, and each leaves a control
 * that looks exactly like a working one:
 *
 *  - **An `unmapped` field that names no column.** `unmappedAt` filters the misses out, so
 *    a typo leaves the list empty and the "Only unanswered" button simply never renders.
 *    A missing button reads as "this table does not offer that", not as a bug.
 *  - **An assignable scope the route will not admit.** The cell posts, the route answers
 *    400, and the cell reports the refusal — visible, but only to whoever happens to type
 *    in that column.
 *  - **An assignable scope the pipeline never reads.** This is the worst of the three and
 *    has happened twice: the write succeeds, the cell says *saved · applies at the next
 *    refresh*, the row leaves the queue, and not one figure moves at that refresh or any
 *    other. `megh_sku` was in that state for a fortnight and `oem` for eight hours.
 *
 * The Python suite's `test_the_assignable_spaces_agree_everywhere` covers the last two for
 * the scopes as a set. This one covers them per column, and covers the first at all.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { VIEWS } from "../app/dashboard/[view]/views.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const faults = [];
const summary = [];

/**
 * A view's tables, off a build that is not there.
 *
 * `tables()` takes the render context, and several views read the build out of it to
 * decide their columns — the trend's month headers, the customer tracker's note. Those
 * throw on an empty context, which is not a fault in them: the page never calls them
 * without one. This check is about the *shape* of the mapping tab, so a view that cannot
 * be built without a build is skipped rather than reported.
 */
const CONTEXT = { scalars: {}, sections: {}, picks: {} };
const tablesOf = (view) => {
  try {
    return view.tables?.(CONTEXT) ?? [];
  } catch {
    return [];
  }
};

/* ---- what the route admits and what the pipeline reads --------------------- */

const route = read("app", "api", "assign", "route.ts");
const admitted = new Set(
  [...route.slice(route.indexOf("const SCOPES"), route.indexOf("\n", route.indexOf("const SCOPES")))
    .matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
);

const pipeline = read(".claude", "skills", "refresh-tvsm-dashboard", "scripts",
  "refresh_dashboard.py");
const readsScope = (scope) => pipeline.includes(`.get("${scope}", {})`);

summary.push(`  route admits ${[...admitted].sort().join(", ")}`);

/* ---- every assignable column, on every tab -------------------------------- */

let assignable = 0;
for (const [viewKey, view] of Object.entries(VIEWS)) {
  for (const table of tablesOf(view)) {
    const fields = new Set(table.columns.map((c) => c.field));

    for (const column of table.columns) {
      if (!column.assign) continue;
      assignable += 1;
      const where = `${viewKey}/${table.key}/${column.field}`;
      const { scope, codeField } = column.assign;

      if (!admitted.has(scope)) {
        faults.push(`${where}: assigns in "${scope}", which /api/assign refuses with a 400.`);
      }
      if (!readsScope(scope)) {
        faults.push(`${where}: assigns in "${scope}", which refresh_dashboard.py never `
          + `reads — the cell would save, say saved, and move nothing.`);
      }
      // The decision is recorded against this field's value, so a name that is on no
      // column of this table files every answer under the empty string.
      if (!fields.has(codeField)) {
        faults.push(`${where}: records against "${codeField}", which is not a column of `
          + `this table — every answer would be filed under one key.`);
      }
    }

    /* ---- and the unanswered toggle ---------------------------------------- */

    if (!table.unmapped) continue;
    if (table.unmapped.length === 0) {
      faults.push(`${viewKey}/${table.key}: declares an empty \`unmapped\`, so the toggle `
        + `renders and hides nothing.`);
    }
    for (const field of table.unmapped) {
      if (!fields.has(field)) {
        faults.push(`${viewKey}/${table.key}: \`unmapped\` names "${field}", which is not `
          + `a column — the "Only unanswered" button will not appear.`);
      }
    }
  }
}

/* ---- the tab itself -------------------------------------------------------- */

const mapping = VIEWS.mappingView;
const tables = tablesOf(mapping);
const masters = tables.filter((t) => t.master || t.key === "length_key");
const withToggle = tables.filter((t) => t.unmapped?.length);

if (masters.length !== 3) {
  faults.push(`Missing mappings carries ${masters.length} master tables, not 3 — the `
    + `owner asked for bucketting, the OEM key and the plan's length key in one place.`);
}
if (withToggle.length !== tables.length) {
  const without = tables.filter((t) => !t.unmapped?.length).map((t) => t.key);
  faults.push(`no unanswered toggle on: ${without.join(", ")}`);
}
if (VIEWS.mappingsView) {
  faults.push("`mappingsView` still exists; the masters were folded into `mappingView`.");
}

summary.push(`  ${tables.length} tables on Missing mappings, ${masters.length} of them masters`);
summary.push(`  ${assignable} assignable columns across every tab`);
summary.push(`  ${withToggle.length} tables offer "Only unanswered"`);

console.log("Missing mappings tab:");
for (const line of summary) console.log(line);

if (faults.length) {
  console.error(`\n${faults.length} fault(s):`);
  for (const fault of faults) console.error(`  - ${fault}`);
  process.exit(1);
}
console.log("\nEvery answerable column posts a scope the route admits and the pipeline "
  + "reads, and every toggle names columns that exist.");
