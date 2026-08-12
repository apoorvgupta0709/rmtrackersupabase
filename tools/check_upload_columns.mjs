/**
 * Does the uploader name a sheet's columns the way the pipeline will read them?
 *
 * The upload page now says which of a dump's columns it found and which it did not, so
 * that a workbook whose headers have moved is refused at the moment somebody is standing
 * there with the file — rather than hours later, mid-refresh, as a `KeyError` naming one
 * column. That check is only worth anything if the names it compares are the names the
 * read will produce, and they are produced twice: `nameColumns` in TypeScript and
 * `name_columns` in `sources.py`.
 *
 * So this parses every dump in `dumps/` exactly as the browser does — SheetJS, same
 * options as `lib/dumps/parse.ts` — names its columns through the TypeScript, and writes
 * the answer out for `tools/check_upload_columns.py` to compare against pandas.
 *
 *     node tools/check_upload_columns.mjs dumps out.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import XLSX from "xlsx";

const here = dirname(fileURLToPath(import.meta.url));
const { SLOTS } = await import(resolve(here, "../lib/dumps/adapters.ts"));
const { mapSheet } = await import(resolve(here, "../lib/dumps/columns.ts"));
const { gridFor } = await import(resolve(here, "../lib/dumps/parse.ts"));

const dumps = process.argv[2] ?? join(here, "..", "dumps");
const out = process.argv[3];

const workbooks = new Map();
function workbookFor(path) {
  if (!workbooks.has(path)) {
    workbooks.set(
      path,
      XLSX.read(readFileSync(path), {
        cellDates: true,
        cellFormula: false,
        cellStyles: false,
      }),
    );
  }
  return workbooks.get(path);
}

const answer = {};
for (const [slot, spec] of Object.entries(SLOTS)) {
  let book = null;
  let used = null;
  for (const file of spec.files) {
    try {
      book = workbookFor(join(dumps, file));
      used = file;
      break;
    } catch {
      /* the next accepted name, or none at all */
    }
  }
  if (!book) continue;

  // The schedule's sheet is named for the month it covers, so it is read off the
  // workbook rather than declared — the same rule the uploader follows.
  const sheetName = spec.monthSheet
    ? book.SheetNames.find((n) => /^Schedule [A-Z][a-z]+$/.test(n) && n !== "Schedule Pivot")
    : (spec.sheet ?? book.SheetNames[0]);
  if (!sheetName || !book.Sheets[sheetName]) continue;

  const cells = gridFor(book.Sheets[sheetName]).rows;
  const mapping = mapSheet(slot, cells);
  answer[slot] = {
    file: used,
    sheet: sheetName,
    columns: mapping.columns,
    missing: mapping.missing,
    positional: mapping.positional,
    sampleRows: mapping.sample.length,
  };
}

if (out) writeFileSync(out, JSON.stringify(answer, null, 1));
const broken = Object.entries(answer).filter(([, a]) => a.missing.length);
for (const [slot, a] of broken) {
  console.error(`${slot} (${a.file} / ${a.sheet}): missing ${a.missing.join(", ")}`);
}
console.log(
  `${Object.keys(answer).length} slots parsed, `
  + `${broken.length} with a declared column the sheet does not carry.`,
);
process.exit(broken.length ? 1 : 0);
