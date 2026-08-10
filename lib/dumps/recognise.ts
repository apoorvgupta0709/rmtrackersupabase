/**
 * Work out which slots an uploaded workbook fills.
 *
 * The registry in `adapters.ts` is generated from the pipeline's own source list and
 * names each dump by its canonical filename. Real files do not arrive with those names:
 * they arrive as the sender saved them — `RM Tracker_18092025.xlsx`, `wip ystockn.xlsx`,
 * `FG STROCK REPORT 07.08.2026.XLSX`. Matching the canonical name exactly meant the
 * owner had to rename every workbook by hand before uploading, and a rename done wrong
 * is a dump loaded into the wrong slot.
 *
 * So a file is recognised three ways, strongest first:
 *
 *  1. **Its name**, compared on a normalised form — case, spaces, underscores, hyphens
 *     and the extension all ignored. `RM_Tracker_Model.XLSX` is `rm_tracker_model.xlsx`.
 *  2. **Its sheets**, which is what the file actually is rather than what it was called.
 *     A workbook holding `Bucketting` and `OEM_key_1_rev codes` is the RM tracker master
 *     whatever the sender named it.
 *  3. **By hand**, in the uploader, for anything still unrecognised — see `parse.ts`.
 *     Guessing is the one thing not on the list: putting the sales dump in the transfer
 *     slot has happened before from a filename alone, and nothing downstream catches it.
 */

import { SLOTS } from "./adapters";

/** `RM Tracker_18092025.XLSX` -> `rm tracker 18092025`. */
export function normalise(filename: string): string {
  return filename
    .replace(/\.(xlsx|xlsm|xls)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Slots whose canonical name this file carries.
 *
 * Stem equality, not a prefix or a substring: `sales.xlsx`, `sales_history.xlsx`,
 * `sales_jul.xlsx`, `sales_q1.xlsx` and `sales_q4.xlsx` are five different dumps whose
 * names all begin "sales", and a looser rule would put one in another's slot.
 */
export function slotsByFilename(filename: string): string[] {
  const name = normalise(filename);
  return Object.entries(SLOTS)
    .filter(([, slot]) => slot.files.some((f) => normalise(f) === name))
    .map(([key]) => key);
}

/** `Sheet1`, `Sheet5`, `Sheet` — a name that identifies nothing. */
const GENERIC_SHEET = /^sheet\s*\d*$/i;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

/** The schedule sheet is named for the month it holds, and the owner renames it. */
export function isMonthSheet(name: string): boolean {
  return name.startsWith("Schedule ") && MONTHS.includes(name.slice("Schedule ".length));
}

/** The workbook a slot is read from — its canonical filename, which groups its siblings. */
const familyOf = (slot: string) => SLOTS[slot].files[0];

/**
 * Slots whose distinctive sheets this workbook holds.
 *
 * Only a sheet whose name identifies the dump counts: `Sheet1` is every dump and would
 * match all of them. Where two workbooks share a sheet name — `orders.xlsx` and
 * `signoff.xlsx` both carry a `jsr` — the one matching more of its own sheets wins, and
 * a tie is left unrecognised rather than resolved by a coin toss.
 */
export function slotsBySheets(sheetNames: string[]): string[] {
  const held = new Set(sheetNames.map((s) => s.trim().toLowerCase()));
  const hasMonth = sheetNames.some(isMonthSheet);

  const matched: { slot: string; sheet: string }[] = [];
  for (const [slot, spec] of Object.entries(SLOTS)) {
    if (spec.monthSheet) continue;
    if (!spec.sheet || GENERIC_SHEET.test(spec.sheet)) continue;
    if (held.has(spec.sheet.trim().toLowerCase())) matched.push({ slot, sheet: spec.sheet.toLowerCase() });
  }

  /**
   * A month sheet corroborates; it never identifies on its own.
   *
   * `Schedule August` is an ordinary thing to call a sheet and more than one workbook in
   * this pack has one — the master carries `Schedule August` beside `Schedule Pivot`,
   * `Schedule for Printing` and `Schedule Ampere`. Taken as proof, a stray month sheet in
   * any other workbook would fill the schedule slot from the wrong file, and the schedule
   * is the one thing on this dashboard that must come from the approved master. So it
   * counts only where the same workbook also carries one of that family's unmistakable
   * sheets — `Bucketting`, or `OEM_key_1_rev codes`.
   */
  if (hasMonth) {
    const corroborated = new Set(matched.map((h) => familyOf(h.slot)));
    for (const [slot, spec] of Object.entries(SLOTS)) {
      if (spec.monthSheet && corroborated.has(familyOf(slot))) {
        matched.push({ slot, sheet: "schedule" });
      }
    }
  }
  if (matched.length === 0) return [];

  // Score each workbook family by how much of itself it recognised.
  const byFamily = new Map<string, { slot: string; sheet: string }[]>();
  for (const hit of matched) {
    const family = familyOf(hit.slot);
    byFamily.set(family, [...(byFamily.get(family) ?? []), hit]);
  }

  // A family is dropped when another family sharing one of its sheets matched more of
  // its own, and when they matched the same number neither is trusted.
  const keep: string[] = [];
  for (const [family, hits] of byFamily) {
    const sheets = new Set(hits.map((h) => h.sheet));
    let beaten = false;
    for (const [other, otherHits] of byFamily) {
      if (other === family) continue;
      const overlaps = otherHits.some((h) => sheets.has(h.sheet));
      if (overlaps && otherHits.length >= hits.length) beaten = true;
    }
    if (!beaten) keep.push(...hits.map((h) => h.slot));
  }
  return keep;
}

export type Recognition = {
  slots: string[];
  how: "filename" | "sheets" | "manual" | "none";
};

/** Name first, then contents. */
export function recognise(filename: string, sheetNames: string[]): Recognition {
  const byName = slotsByFilename(filename);
  if (byName.length) return { slots: byName, how: "filename" };
  const bySheet = slotsBySheets(sheetNames);
  if (bySheet.length) return { slots: bySheet, how: "sheets" };
  return { slots: [], how: "none" };
}

/** A slot offered in the uploader's assign-by-hand picker. */
export function slotChoices(): { slot: string; describe: string }[] {
  return Object.entries(SLOTS).map(([slot, spec]) => ({
    slot,
    describe: `${slot} — ${spec.monthSheet ? "Schedule <Month>" : (spec.sheet ?? "first sheet")} of ${spec.files[0]}`,
  }));
}
