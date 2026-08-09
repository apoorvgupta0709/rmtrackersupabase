// Parse each dump the way the browser will, and write out what it saw.
//
// The uploader parses .xlsx in the browser with SheetJS and posts rows; the pipeline
// then rebuilds its frames from those rows instead of from a file. That only works if
// SheetJS and pandas agree about what is in a cell — and where they disagree it will not
// raise, it will change a number on a page. So this writes SheetJS's view of every sheet
// the pipeline reads, and a Python check compares the rebuilt frame against the one
// pd.read_excel produces.
//
// What is written is the raw cell grid, not a table: no header row is chosen, no column
// window applied, nothing named. Those are read-time decisions and they live in the slot
// registry, which means a corrected header row is a re-read rather than a re-upload.
//
// Usage: node tools/export_sheet_cells.mjs <slots.json> <out-dir>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import XLSX from 'xlsx';

const [, , slotsPath, outDir] = process.argv;
if (!slotsPath || !outDir) {
  console.error('usage: node tools/export_sheet_cells.mjs <slots.json> <out-dir>');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const slots = JSON.parse(readFileSync(slotsPath, 'utf8'));

// One workbook may serve several slots — the RM tracker model alone carries Bucketting,
// the OEM key and the schedule — so parsing is cached per file.
const workbooks = new Map();
function workbookFor(path) {
  if (!workbooks.has(path)) {
    // Read the bytes and hand over a buffer rather than using readFile. That is what the
    // browser does with an uploaded File, so the parse under test here is the parse that
    // will run in production — and the ESM build has no filesystem of its own anyway.
    workbooks.set(path, XLSX.read(readFileSync(path), {
      // Dates come back as Date objects rather than Excel serial numbers. Without this a
      // billing date arrives as 45876 and every ageing calculation downstream is wrong by
      // decades.
      cellDates: true,
      // Formula cells carry their cached result, which is what pandas reads too (it opens
      // the workbook with openpyxl's data_only=True). Reading the formula text instead
      // would put "=B2*C2" where a tonnage belongs.
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      type: 'buffer',
    }));
  }
  return workbooks.get(path);
}

// A cell's value, plus how it should be read back. Only dates need the marker: numbers,
// strings and booleans are themselves in JSON, but a date has to survive as something
// other than the string it would otherwise become.
function encode(cell) {
  if (cell === undefined || cell === null) return null;
  const { t, v } = cell;
  if (v === undefined || v === null) return null;
  if (t === 'e') return null;              // an error cell reads as empty, as it does in pandas
  // A cell holding an empty string is an empty cell. openpyxl gives None and pandas NaN
  // for both, and treating them differently would put "" where every downstream check
  // looks for a missing value.
  if (v === '') return null;
  if (t === 'd' || v instanceof Date) {
    const when = new Date(v);
    // Excel stores a clock time as a fraction of a day, which lands on its epoch date.
    // openpyxl hands those back as a time rather than a datetime, and the sales dumps
    // carry one — `eWay Bill Creation Time`. Sent as a full timestamp it would read as
    // 1899, and anything comparing it to a date would be wrong by a century.
    if (when.getUTCFullYear() < 1900) {
      const pad = (n) => String(n).padStart(2, '0');
      return {
        __excel_time: `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`,
      };
    }
    return { __excel_date: when.toISOString() };
  }
  if (t === 'b') return Boolean(v);
  if (t === 'n') return typeof v === 'number' ? v : Number(v);
  return String(v);
}

const manifest = [];

for (const [slot, spec] of Object.entries(slots)) {
  const wb = workbookFor(spec.path);
  const sheetName = spec.sheet ?? wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    manifest.push({ slot, path: spec.path, sheet: sheetName, missing: true });
    continue;
  }

  const range = XLSX.utils.decode_range(ws['!ref']);
  const cells = [];
  // Walk the declared range rather than using sheet_to_json, which trims trailing empty
  // cells per row. Two of these reads are positional — Bucketting's U:AF window and the
  // contract sheets, whose quarters are column offsets — so a short row would silently
  // shift them.
  // Anchored at A1 rather than at the sheet's declared origin. contract.xlsx declares a
  // range starting at row 2, and reading from there dropped its first row and shifted
  // every positional column offset by one — the quarters on that sheet are column
  // offsets, so it would have priced against the wrong quarter. openpyxl always counts
  // from A1, so this does too.
  for (let r = 0; r <= range.e.r; r++) {
    const row = [];
    for (let c = 0; c <= range.e.c; c++) {
      row.push(encode(ws[XLSX.utils.encode_cell({ r, c })]));
    }
    cells.push(row);
  }

  const out = {
    slot,
    sheet: sheetName,
    source_file: spec.path.split('/').pop(),
    // The sheet's own origin. A sheet whose range does not start at A1 would otherwise
    // rebuild shifted, and the column window would land on the wrong columns.
    origin: { row: range.s.r, col: range.s.c },
    n_rows: cells.length,
    n_cols: cells.length ? cells[0].length : 0,
    cells,
  };
  writeFileSync(join(outDir, `${slot.replace(':', '__')}.json`), JSON.stringify(out));
  manifest.push({ slot, sheet: sheetName, rows: out.n_rows, cols: out.n_cols });
}

writeFileSync(join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 1));
console.log(JSON.stringify({ slots: manifest.length, out: outDir }));
