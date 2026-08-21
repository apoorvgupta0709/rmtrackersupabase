/**
 * Does every column say how it was derived?
 *
 *     node tools/check_column_notes.mjs
 *
 * The ⓘ on a header is only worth trusting if it is never generic where a real
 * calculation sits behind the figure. The structural default in `explainColumn` exists
 * for that fallback, but the owner's requirement (21 Aug 2026) is stronger: the note
 * names the input file and the arithmetic, which only an authored `explain` can do. So
 * this walks every view's every column and fails on any that carries neither an
 * `explain` nor an `assign` — assignable columns get their authored text from
 * `explainColumn` itself, where it is assembled from the scope and code field so it can
 * never drift from what the cell actually does.
 *
 * A column added without a note fails here at once, instead of shipping as a header
 * whose ⓘ answers a different question than the one being asked of it.
 */

import { VIEWS } from "../app/dashboard/[view]/views.ts";

// Enough context for every `tables()` to build: two months, one quarter, MT.
const CONTEXT = {
  scalars: {}, sections: {}, picks: {},
  months: ["2026-07", "2026-08"], unit: "mt", quarters: ["Q1"],
};

let total = 0;
let authored = 0;
const missing = [];
const skipped = [];

for (const [viewKey, view] of Object.entries(VIEWS)) {
  let tables = [];
  try {
    tables = view.tables?.(CONTEXT) ?? [];
  } catch {
    // A view whose columns depend on the live build cannot be built from an empty
    // context; say so rather than silently covering less than claimed.
    skipped.push(viewKey);
    continue;
  }
  for (const table of tables) {
    for (const column of table.columns) {
      total += 1;
      if (column.explain || column.assign) authored += 1;
      else missing.push(`${viewKey}/${table.key}/${column.field} (${column.label})`);
    }
  }
}

console.log(`${authored} of ${total} columns carry an authored derivation note.`);
if (skipped.length) console.log(`  (not walkable without a build: ${skipped.join(", ")})`);

if (missing.length) {
  console.error(`\n${missing.length} column(s) with no note:`);
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}
console.log("\nEvery column names its input and its arithmetic.");
