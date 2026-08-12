import * as XLSX from "xlsx";
import { SLOTS } from "./adapters.ts";
import { isMonthSheet, recognise, type Recognition } from "./recognise.ts";

/**
 * Turn an uploaded .xlsx into the cell grids the pipeline reads.
 *
 * This is deliberately the same logic as tools/export_sheet_cells.mjs, which is the
 * thing the fidelity check ran against: 23 of 23 slots rebuilt into the frames
 * pd.read_excel produces, and a whole refresh off those grids matched the file-based
 * build. Keeping the two in step is what makes that evidence apply to real uploads, so
 * any change here belongs in both, with the comparison re-run.
 *
 * What is stored is the raw grid — no header row chosen, no column window, nothing
 * named. Those are read-time decisions and they live in the Python registry, which means
 * a corrected header row is a re-read rather than asking for the workbook again.
 */

export type Cell = number | string | boolean | null | { __excel_date: string } | { __excel_time: string };

export type ParsedGrid = {
  slot: string;
  sheet: string;
  sourceFile: string;
  rows: Cell[][];
  nCols: number;
};

export type ParseResult = {
  filename: string;
  grids: ParsedGrid[];
  /** Slots this file should have filled but could not. */
  problems: string[];
  /** How the slots were arrived at, so a match on contents is visible and not silent. */
  how: Recognition["how"];
  /**
   * Set when nothing recognised the file. It is not an error and not discarded — the
   * sheets it holds are listed so the uploader can offer them, and the reader assigns
   * the slot by hand. A workbook the sender renamed is the normal case, not a mistake.
   */
  unassigned?: { sheetNames: string[] };
};

function encode(cell: XLSX.CellObject | undefined): Cell {
  if (!cell) return null;
  const { t, v } = cell;
  if (v === undefined || v === null) return null;
  if (t === "e") return null;                    // an error cell reads as empty, as in pandas
  if (v === "") return null;                     // an empty string is an empty cell
  if (t === "d" || v instanceof Date) {
    const when = new Date(v as Date);
    // Excel stores a clock time as a fraction of a day, landing on its 1899 epoch.
    // The sales dumps carry one — `eWay Bill Creation Time`. Sent as a full timestamp it
    // would read as 1899 and any comparison against a date would be a century out.
    if (when.getUTCFullYear() < 1900) {
      const pad = (n: number) => String(n).padStart(2, "0");
      return {
        __excel_time: `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`,
      };
    }
    return { __excel_date: when.toISOString() };
  }
  if (t === "b") return Boolean(v);
  if (t === "n") return typeof v === "number" ? v : Number(v);
  return String(v);
}

export function gridFor(worksheet: XLSX.WorkSheet): { rows: Cell[][]; nCols: number } {
  const ref = worksheet["!ref"];
  if (!ref) return { rows: [], nCols: 0 };
  const range = XLSX.utils.decode_range(ref);
  const rows: Cell[][] = [];
  // Anchored at A1, not at the sheet's declared origin. contract.xlsx declares a range
  // starting at row 2; reading from there dropped its first row and shifted every
  // positional column offset by one — and that sheet's quarters *are* column offsets,
  // so it would have priced against the wrong quarter. openpyxl counts from A1.
  for (let r = 0; r <= range.e.r; r++) {
    const row: Cell[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      row.push(encode(worksheet[XLSX.utils.encode_cell({ r, c })]));
    }
    rows.push(row);
  }
  return { rows, nCols: rows.length ? rows[0].length : 0 };
}

/**
 * Parse one uploaded workbook into every slot it fills.
 *
 * The workbook is opened before the slots are decided, because its sheets are the better
 * evidence of what it is: the sender's filename is whatever they saved it as, while a
 * `Bucketting` sheet is a fact about the file. Pass `assigned` to override both and put
 * it where the reader says.
 */
export function parseWorkbook(
  filename: string,
  data: ArrayBuffer,
  assigned?: string[],
): ParseResult {
  const workbook = XLSX.read(new Uint8Array(data), {
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    type: "array",
  });

  const found = assigned?.length
    ? ({ slots: assigned, how: "manual" } as Recognition)
    : recognise(filename, workbook.SheetNames);
  const slots = found.slots;
  const problems: string[] = [];

  if (slots.length === 0) {
    return {
      filename,
      grids: [],
      problems: [],
      how: "none",
      unassigned: { sheetNames: workbook.SheetNames },
    };
  }

  const grids: ParsedGrid[] = [];
  for (const slot of slots) {
    const spec = SLOTS[slot];
    let sheetName: string | undefined;

    if (spec.monthSheet) {
      // The schedule sheet is named for the month it covers and the owner renames it as
      // the month rolls, so it is discovered rather than declared. Every month sheet the
      // workbook holds is uploaded; the refresh picks the one matching its as-of date.
      const monthSheets = workbook.SheetNames.filter(isMonthSheet);
      for (const name of monthSheets) {
        const { rows, nCols } = gridFor(workbook.Sheets[name]);
        grids.push({ slot, sheet: name, sourceFile: filename, rows, nCols });
      }
      if (monthSheets.length === 0) {
        problems.push(`${filename} has no "Schedule <Month>" sheet.`);
      }
      continue;
    }

    sheetName = spec.sheet ?? workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      // signoff.xlsx routinely arrives without one of its three plants, which is normal
      // and not an error; a required sheet going missing is.
      const message = `${filename} has no sheet "${sheetName}" (slot ${slot}).`;
      if (!spec.optional) problems.push(message);
      continue;
    }
    const { rows, nCols } = gridFor(worksheet);
    grids.push({ slot, sheet: sheetName, sourceFile: filename, rows, nCols });
  }

  return { filename, grids, problems, how: found.how };
}

/** A stable digest of the parsed cells, for spotting a dump that was re-sent unchanged. */
export async function digestOf(rows: Cell[][]): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(rows));
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
