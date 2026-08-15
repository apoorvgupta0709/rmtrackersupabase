/**
 * Reading a dump slot out of Supabase, under the headers the sheet itself uses.
 *
 * The pipeline's frames are keyed by the *file's* column names — `"Customer Name"`,
 * `"Open Amount"`, `"Customer "` with its trailing space — while the tables and views are
 * keyed by snake_case. `config/dump_columns.json` is the mapping between them, generated
 * beside the view DDL precisely so a renamed column cannot move under one without the
 * other. This reads that manifest rather than restating it, so the port cannot drift from
 * the generator.
 *
 * Two storage kinds, as `sources.py` declares them:
 *  - **`view`** — a window onto the current batch. Ordered by `seq`, which is the row's
 *    position in the sheet. That order has to be *asked for*: a view has no order of its
 *    own, and several published fields are taken off whichever row of a group comes first.
 *  - **`row_json`** — an accumulating table holding the whole line as `row` jsonb, read
 *    positionally against the manifest's column list.
 */

import { readFileSync } from "node:fs";

type Column = { column?: string; header: string; position?: number };
type Manifest = {
  columns: Column[];
  storage: "view" | "row_json" | "typed";
  table: string;
};

/**
 * The order each accumulating slot's rows are read back in — `sources.TABLES`'s
 * `read_order or key`.
 *
 * Not decoration, and not only about paging. PostgREST pages by offset, and an unordered
 * offset over a growing table can serve one row twice and skip another — that alone would
 * justify it. But **zmat means it**: its rows are deduplicated again inside the pipeline
 * with `keep="first"`, so "first" has to be the sheet's first and not whichever material
 * code happens to sort lowest. That is why `dump_zmat` carries a `source_seq` column at
 * all, and reading it in any other order silently keeps a different row of each duplicate
 * group.
 */
const READ_ORDER: Record<string, string[]> = {
  zmat: ["source_seq"],
  bucketting: ["material_code"],
  oem_key: ["customer"],
  transfers: ["billing_document", "billing_item"],
};

export type Row = Record<string, unknown>;

/**
 * PostgREST answers at most this many rows and **says nothing about having stopped**.
 *
 * Paging that halts on an empty page is correct; paging that halts on a page shorter than
 * the window is correct; paging that assumes one request is enough is the fault that read
 * 998 of Bucketting's 1,750 rows, collapsed bucket resolution, and was caught only because
 * a hard floor refused to publish a dashboard of zeros.
 */
const PAGE = 1000;

export function manifests(root: string): Record<string, Manifest> {
  return JSON.parse(readFileSync(
    `${root}/.claude/skills/refresh-tvsm-dashboard/config/dump_columns.json`, "utf8"));
}

/** Every row of a PostgREST query, however many pages that takes. */
async function selectAll(
  url: string,
  key: string,
  path: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(`${url}/rest/v1/${path}${separator}limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    }
    const page = await response.json();
    rows.push(...page);
    // Stop only on a short page. An exactly-full page may or may not be the last one, and
    // guessing is what the cap punishes.
    if (page.length < PAGE) return rows;
  }
}

/**
 * One slot's rows, keyed by the sheet's own headers.
 *
 * `sheet` narrows a slot that keeps one current batch per sheet — the schedule's
 * uniqueness index is on `(slot, coalesce(sheet, ''))` rather than on the slot, so its
 * view can hold several months at once and an unfiltered read would concatenate them.
 */
export async function readSlot(
  slot: string,
  { root, url, key, sheet }: { root: string; url: string; key: string; sheet?: string },
): Promise<Row[]> {
  const manifest = manifests(root)[slot];
  if (!manifest) throw new Error(`No manifest for slot ${slot}`);

  if (manifest.storage === "view") {
    const wanted = manifest.columns.map((c) => c.column).filter(Boolean);
    const filter = sheet === undefined ? "" : `&sheet=eq.${encodeURIComponent(sheet)}`;
    const raw = await selectAll(url, key,
      `${manifest.table}?select=seq,${wanted.join(",")}&order=seq.asc${filter}`);
    return raw.map((row) => {
      const out: Row = {};
      for (const column of manifest.columns) {
        if (column.column) out[column.header] = row[column.column];
      }
      return out;
    });
  }

  const order = (READ_ORDER[slot] ?? []).map((c) => `${c}.asc`).join(",");
  const ordered = order ? `&order=${order}` : "";

  if (manifest.storage === "typed") {
    // A real table with named columns, outliving the batches it was filled from.
    const wanted = manifest.columns.map((c) => c.column).filter(Boolean);
    const raw = await selectAll(url, key,
      `${manifest.table}?select=${wanted.join(",")}${ordered}`);
    return raw.map((row) => {
      const out: Row = {};
      for (const column of manifest.columns) {
        if (column.column) out[column.header] = row[column.column];
      }
      return out;
    });
  }

  // `row_json`: the whole line kept as jsonb.
  //
  // An accumulating table keys that object **by the sheet's own header** — `raw_rows` is
  // the one that holds a positional array, and assuming the two agree reads every column
  // as null without erroring, which is how this first came back with 174 rows and no OEM
  // on any of them. Both shapes are handled rather than one assumed.
  const raw = await selectAll(url, key, `${manifest.table}?select=row${ordered}`);
  return raw.map((entry) => {
    const cells = entry.row ?? {};
    const out: Row = {};
    if (Array.isArray(cells)) {
      manifest.columns.forEach((column, i) => { out[column.header] = cells[i] ?? null; });
    } else {
      const byHeader = cells as Record<string, unknown>;
      for (const column of manifest.columns) {
        out[column.header] = byHeader[column.header] ?? null;
      }
    }
    return out;
  });
}
