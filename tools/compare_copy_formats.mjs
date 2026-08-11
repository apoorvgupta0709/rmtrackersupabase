/**
 * Do the two documents the app sends out still read exactly as the static page's?
 *
 * The clearance list and the dispatch plan are not screen furniture — they are pasted
 * into WhatsApp and into the dispatch team's sheet. A difference of a decimal place or a
 * thousand separator is a wrong figure in somebody else's document, and nothing about it
 * looks wrong. The equivalence was proved once by hand when the formats were ported;
 * this repeats the proof on demand, by running the static page's own functions out of
 * `index.html` against the same payload the app is given.
 *
 * Two traps it has already caught, and exists to keep catching:
 *  - the page's `fmt` sets only `maximumFractionDigits`, so a 5.1 MT shortfall reads
 *    `5.1` and never `5.100`;
 *  - quantities keep their thousand separators while *dimensions* drop them, because
 *    "1,130 mm" reads as a quantity on a phone.
 *
 * Run:  node tools/compare_copy_formats.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { COPY_FORMATS } from "../app/dashboard/[view]/copies.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "data.json"), "utf8"));
const page = readFileSync(join(root, "index.html"), "utf8");

/** The page's script between two markers, so this reads whatever the page now says. */
function between(from, to) {
  const start = page.indexOf(from);
  const end = page.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`markers not found: ${from} … ${to}`);
  return page.slice(start, end);
}

const source = [
  // `fmt` is used across the whole page; the two formats need only this much of it.
  "const fmt = (value, digits = 1) => value === null || value === undefined"
  + " || Number.isNaN(Number(value)) ? '–'"
  + " : Number(value).toLocaleString('en-IN', { maximumFractionDigits: digits });",
  between("const displayPlant = plant =>", "function renderStockAnalysis"),
  between("const CLEARANCE_MIN_NOS = 500;", "function showStock("),
  "return { copyClearance, copyDispatchPlan };",
].join("\n");

// The page reads its customer off a `<select>` and hands the result to `copyText`. Both
// are stubbed so the two functions can be driven customer by customer.
let captured = "";
let chosen = "";
const old = new Function("data", "document", "copyText", "setTimeout", source)(
  data,
  { getElementById: () => ({ get value() { return chosen; }, set textContent(_) {} }) },
  (text) => { captured = text; },
  () => {},
);

const ctx = {
  asOf: String(data.metadata.as_of),
  scalars: data,
  sections: { customer_lines: data.customer_lines },
};
const customers = [...new Set(data.customer_lines.map((r) => r.customer_display))].sort();
const isCrfh = (row) => String(row.bucket ?? "").toUpperCase().includes("CRFH");

let identical = 0;
const differing = [];

for (const customer of customers) {
  chosen = customer;
  // What the app's table actually hands the buttons: this customer's tube lines, with
  // the CRFH book split into a table of its own. The documents must still carry it.
  const handed = data.customer_lines.filter((r) => r.customer_display === customer && !isCrfh(r));

  for (const [kind, run] of [["clearance", old.copyClearance], ["dispatch", old.copyDispatchPlan]]) {
    captured = "";
    run({ textContent: "" });
    const before = captured;
    const after = COPY_FORMATS[kind].build(handed, ctx);

    if ("error" in after) {
      differing.push(`${customer} / ${kind}: refused — ${after.error}`);
      continue;
    }
    if (after.text === before) {
      identical += 1;
      continue;
    }
    const a = before.split("\n");
    const b = after.text.split("\n");
    const at = a.findIndex((line, i) => line !== b[i]);
    differing.push(
      `${customer} / ${kind}: ${a.length} lines on the page, ${b.length} in the app;`
      + ` first difference at line ${at + 1}`
      + `\n      page: ${JSON.stringify(a[at])}`
      + `\n      app:  ${JSON.stringify(b[at])}`,
    );
  }
}

console.log(`${identical} of ${customers.length * 2} documents are byte-identical `
  + `across ${customers.length} customers.`);

if (differing.length) {
  console.error(`\n${differing.length} differ:`);
  for (const line of differing) console.error(`  - ${line}`);
  process.exit(1);
}
