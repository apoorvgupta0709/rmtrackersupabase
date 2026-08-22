/**
 * Nothing function-valued may cross to the client.
 *
 * `DataTable` is a client component, so every prop the page hands it is serialized at
 * request time — and a function anywhere in them kills the whole tab with "Functions
 * cannot be passed directly to Client Components". That failure is invisible to `tsc`
 * and to both deploys: the mapping tab shipped broken on 20 Aug with every build green,
 * because the queue's `derive` columns are functions and nobody clicked the tab for two
 * days.
 *
 * The page resolves `derive` server-side and strips it before the hand-off, so the rule
 * this file enforces is: after that strip, no view's table may carry a function in any
 * prop DataTable receives. `flatten`, `pickFields` and `derive` itself are server-side
 * by design and exempt; everything else that is a function is a tab that will not load.
 */

import { readFileSync } from "node:fs";
import { VIEWS } from "../app/dashboard/[view]/views.ts";

// The strip this file simulates has to actually exist in the page, or the simulation
// grades a hand-off that no longer happens. Asserted on the text because the page is a
// server component and cannot be imported here.
const page = readFileSync(
  new URL("../app/dashboard/[view]/page.tsx", import.meta.url),
  "utf8",
);
if (!page.includes("columns.map(({ derive, ...plain }) => plain)")) {
  console.error(
    "page.tsx no longer strips `derive` before handing columns to DataTable — every "
    + "tab with a derived column will fail to serialize at request time.",
  );
  process.exit(1);
}

/** The TableSpec fields the page passes into DataTable, name for name. */
const CLIENT_PROPS = [
  "title", "note", "columns", "averageOver", "copies", "unmapped", "foldAdd", "lineage",
];

const ctx = {
  months: [],
  quarters: [],
  unit: "mt",
  scalars: {},
  pick: undefined,
  picks: {},
};

const failures = [];

function scan(value, path, view, table) {
  if (typeof value === "function") {
    failures.push(`${view} / ${table} / ${path}: a function would cross to the client`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scan(entry, `${path}[${index}]`, view, table));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      scan(entry, `${path}.${key}`, view, table);
    }
  }
}

let tablesChecked = 0;
for (const [viewName, spec] of Object.entries(VIEWS)) {
  let tables;
  try {
    tables = spec.tables(ctx);
  } catch (error) {
    failures.push(`${viewName}: tables() threw on an empty context — ${error.message}`);
    continue;
  }
  for (const table of tables) {
    tablesChecked += 1;
    // Every table owes its readers a lineage — the source file behind its figures and
    // the key that mapped them on. The type requires it; this catches an empty one.
    if (!table.lineage?.source || !table.lineage?.key) {
      failures.push(`${viewName} / ${table.key}: no lineage declared`);
    }
    // What the page does before the hand-off: a derived column crosses without its
    // function, its text already written onto the rows.
    const stripped = {
      ...table,
      columns: table.columns.map(({ derive, ...plain }) => plain),
    };
    for (const prop of CLIENT_PROPS) {
      scan(stripped[prop], prop, viewName, table.key);
    }
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} client-prop failure(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `${tablesChecked} tables across ${Object.keys(VIEWS).length} views: nothing `
  + "function-valued crosses to the client.",
);
