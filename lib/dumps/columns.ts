/**
 * What a parsed sheet's columns are called, and whether the pipeline will find the ones
 * it reads.
 *
 * The uploader used to store a workbook without ever looking at a header. That is right
 * for *storage* — the grid goes to Postgres raw and which row is the header is a read-time
 * decision that stays in Python — but it made the upload silent about the one thing that
 * actually goes wrong. A dump whose columns have been renamed or reordered is accepted,
 * looks fine, and fails hours later inside the refresh as a `KeyError` naming one column,
 * by which time the person who has the file has gone home.
 *
 * So this names the columns the same way the read will, checks them against what the slot
 * declares, and hands back five rows to look at. It is a preview of a read, not the read:
 * nothing here decides what is stored.
 *
 * **The naming has to match `sources.py:name_columns` exactly.** A column named
 * differently here would report a good file as broken, or a broken one as fine.
 */

import { SLOTS, type DumpSlot } from "./adapters.ts";

export type Cell = string | number | boolean | null | Record<string, unknown>;

/** One declared column, and where it turned up. */
export type ColumnMatch = { name: string; at: number | null };

export type SheetMapping = {
  /** Every column of the window, named as the read will name them. */
  columns: string[];
  /** The declared columns, in order, each with the position it was found at. */
  matched: ColumnMatch[];
  /** Declared columns the sheet does not carry. Empty is the good outcome. */
  missing: string[];
  /** The key column's position, so the preview can lead with it. */
  keyAt: number | null;
  /** Up to five data rows, as text, one array per row, aligned to `columns`. */
  sample: string[][];
  /** True where the slot declares no header row at all — the contract sheets. */
  positional: boolean;
};

const SAMPLE_ROWS = 5;

/**
 * `U:AF` -> 20..31.
 *
 * Only the letter-range form, because it is the only form the pipeline uses. A name list
 * would be a different thing and is deliberately not guessed at — the same rule
 * `excel_column_range` in `sources.py` follows.
 */
export function columnRange(usecols: string | null, width: number): number[] {
  if (!usecols) return Array.from({ length: width }, (_, i) => i);
  if (!/^[A-Z]+:[A-Z]+$/.test(usecols)) return Array.from({ length: width }, (_, i) => i);
  const indexOf = (letters: string) =>
    [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  const [first, last] = usecols.split(":");
  const from = indexOf(first);
  const to = indexOf(last);
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/**
 * Header names the way pandas makes them: blanks numbered, duplicates suffixed.
 *
 * Reproduced rather than approximated, for the reason the Python says: a column named
 * differently is a `KeyError` three thousand lines later, or worse a silently absent
 * column that a `.get` turns into an empty series.
 */
export function nameColumns(header: Cell[], count: number): string[] {
  const names: string[] = [];
  for (let position = 0; position < count; position++) {
    const value = header[position];
    if (value === null || value === undefined || value === "") {
      names.push(`Unnamed: ${position}`);
    } else if (typeof value === "number" && Number.isInteger(value)) {
      // A header cell holding a number reads as the number, not as "3.0".
      names.push(String(value));
    } else {
      names.push(cellText(value));
    }
  }

  const seen = new Map<string, number>();
  return names.map((name) => {
    const held = seen.get(name);
    if (held === undefined) {
      seen.set(name, 0);
      return name;
    }
    seen.set(name, held + 1);
    return `${name}.${held + 1}`;
  });
}

/** A cell as the preview shows it. Dates and times arrive wrapped by the parser. */
export function cellText(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const wrapped = value as Record<string, unknown>;
    const inner = wrapped.__excel_date ?? wrapped.__excel_time;
    return inner === undefined ? "" : String(inner);
  }
  if (typeof value === "number") return String(value);
  return String(value);
}

/** An empty cell, by the read's own definition. The parser already maps `""` to null. */
const blank = (cell: Cell | undefined) => cell === null || cell === undefined;

/**
 * The last row that carries anything, so a sheet declaring ten thousand rows of which two
 * hundred are real does not preview two hundred rows of blanks. openpyxl bounds a sheet
 * the same way, which is why the row counts agree — and the whole row is looked at, not
 * the column window: `Bucketting` is read as `U:AF` and 211 of its rows are blank in that
 * window while carrying data elsewhere.
 *
 * Emptiness is "no cell at all", not "nothing once trimmed". A cell holding a single
 * space is a value to pandas, and one such cell in the last column of the TVSM sheet is
 * the difference between twenty columns and twenty-one.
 */
function lastRowWithContent(cells: Cell[][]): number {
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i].some((cell) => !blank(cell))) return i;
  }
  return -1;
}

/**
 * Name a stored grid's columns and say which of the declared ones are there.
 *
 * A slot with no header row — the two contract sheets, which are read positionally
 * because their quarters are column offsets — has nothing to check by name and says so
 * rather than inventing header text out of its first row of prices.
 */
export function mapSheet(slot: string, cells: Cell[][]): SheetMapping {
  const spec: DumpSlot | undefined = SLOTS[slot];
  const width = cells.reduce((w, row) => Math.max(w, row.length), 0);
  const window = columnRange(spec?.usecols ?? null, width);
  const bound = lastRowWithContent(cells);
  const take = (row: number) => window.map((c) => cells[row]?.[c] ?? null);

  if (!spec || spec.header === null) {
    const sample: string[][] = [];
    for (let i = 0; i <= bound && sample.length < SAMPLE_ROWS; i++) {
      sample.push(take(i).map(cellText));
    }
    return {
      columns: window.map((_, i) => `Column ${i + 1}`),
      matched: [],
      missing: [],
      keyAt: null,
      sample,
      positional: true,
    };
  }

  let columns = nameColumns(take(spec.header), window.length);

  /**
   * Trailing columns that are empty top to bottom, header included, come off.
   *
   * The same artefact one axis over from a sheet declaring more rows than it has, and
   * pandas drops them, so a preview that kept them would show eight columns the read
   * does not have. Only *unnamed* ones go: a named column that happens to be empty this
   * week is part of the sheet's shape and pandas keeps it too.
   */
  const empty = (column: number) => {
    for (let i = spec.header! + 1; i <= bound; i++) {
      if (!blank(cells[i]?.[window[column]])) return false;
    }
    return true;
  };
  let kept = columns.length;
  while (kept > 0 && columns[kept - 1].startsWith("Unnamed: ") && empty(kept - 1)) {
    kept -= 1;
  }
  columns = columns.slice(0, kept);
  const visible = window.slice(0, kept);

  const sample: string[][] = [];
  for (let i = spec.header + 1; i <= bound && sample.length < SAMPLE_ROWS; i++) {
    // Skip rows with nothing in them at all: they are padding, and five of those is a
    // preview that shows nothing.
    if (visible.every((c) => blank(cells[i]?.[c]))) continue;
    sample.push(visible.map((c) => cellText(cells[i]?.[c] ?? null)));
  }

  const matched: ColumnMatch[] = (spec.required ?? []).map((name) => ({
    name,
    at: columns.indexOf(name) === -1 ? null : columns.indexOf(name),
  }));
  const key = spec.keyColumn;

  return {
    columns,
    matched,
    missing: matched.filter((m) => m.at === null).map((m) => m.name),
    keyAt: key ? (columns.indexOf(key) === -1 ? null : columns.indexOf(key)) : null,
    sample,
    positional: false,
  };
}

/**
 * A column name as it should be *shown*.
 *
 * Several of these headers carry a non-breaking space or a trailing space that is
 * load-bearing and invisible: `Material No` in the WIP dump, `Chamferring ` on the
 * schedule. A reader comparing the page to their spreadsheet has to be able to see the
 * difference, or a mismatch reads as the check being wrong.
 */
export function visibleName(name: string): string {
  return name
    .replace(/\u00a0/g, "\u237d")
    .replace(/^( +)/, (run) => "\u00b7".repeat(run.length))
    .replace(/( +)$/, (run) => "\u00b7".repeat(run.length));
}
