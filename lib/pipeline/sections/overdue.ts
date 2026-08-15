/**
 * Section 10 — overdue receivables for the TVS ancillaries, from the yf65 ageing file.
 *
 * Ported from `refresh_dashboard.py` L2901–3028. Pure: it takes the frames and returns the
 * section, its two drill-downs and its QC tallies, so it can be held against the pipeline's
 * own answer without touching the network.
 *
 * The three decisions worth not losing, all of them from the original's comments:
 *
 *  - **A receivable falls due `RECEIVABLE_DUE_DAYS` after the invoice date.** That governed
 *    term replaces both the per-document Net Due Date and the file's own Due Status flag,
 *    whose payment terms vary by document.
 *  - **Only `RV` and `RD` are invoices to chase.** They are exactly the rows whose Nature is
 *    BILLING; everything else is a debit balance, a credit note or a collection.
 *  - **An offset is told by its Nature, never by not being a billing document.** The
 *    complement of billing also holds debit balances, which *add* to the exposure rather
 *    than reducing it. Doc Type cannot decide this — `AB` carries both OTHER DEBIT BALANCE
 *    and OTHER CREDIT BALANCE — so Nature governs. Both lists are whitelists, so a Nature
 *    nobody has seen is not quietly counted; what they exclude is tallied into QC instead of
 *    disappearing.
 */

import { pyRound } from "../format.ts";
import {
  firstUnique, isNa, normCode, normText, pyStr, toNumber, toUtcDay, utcDayIso,
} from "../normalise.ts";
import type { Row } from "../source.ts";

/** A receivable falls due this many days after the invoice date. */
export const RECEIVABLE_DUE_DAYS = 47;

/** Document types that represent a billing invoice. */
export const BILLING_DOC_TYPES = new Set(["RV", "RD"]);

/** Documents that *reduce* what an ancillary owes. A debit balance does not. */
export const OFFSET_NATURES = new Set(["CREDIT NOTE", "OTHER CREDIT BALANCE", "COLLECTION"]);

/** Conversion agents, routed to the OEM they convert for. */
export const CONVERSION_AGENT_OEM_BY_CODE: Record<string, string> = {
  "943209": "TVS",    // MEGH STEELS PRIVATE LIMITED - TVS A
  "943210": "HMSIL",  // MEGH STEELS PRIVATE LIMITED - HMSIL
  "943211": "RE",     // MEGH STEELS PRIVATE LIMITED - RE
};

export type OverdueRow = {
  ancillary: string | null;
  customer_code: string | null;
  overdue_amount: number;
  documents: number;
  oldest_days: number | null;
  over_90_days_amount: number;
  offsets_amount: number;
  offsets_documents: number;
  offsets_detail_key: string;
  overdue_debits: number;
  overdue_credits: number;
  detail_key: string;
};

export type OverdueResult = {
  rows: OverdueRow[];
  details: Record<string, Row[]>;
  unmapped: { customer: string | null; overdue_amount: number; documents: number }[];
  excluded: Record<string, { documents: number; amount: number }>;
};

/* ---- the section ----------------------------------------------------------- */
//
// Dates go through `toUtcDay`, never the host's zone: `as_of` drives the ageing
// arithmetic, and a container running in IST would move every document across the day
// boundary and quietly re-age the whole book.

type Prepared = {
  row: Row;
  name: string | null;
  customerKey: string | null;
  oem: string | null;
  openAmount: number;
  invoiceDay: number | null;
  dueDay: number | null;
  daysOverdue: number | null;
  invoiceNo: string | null;
  docTypeKey: string;
  natureKey: string;
};

export function overdueAnalysis(
  receivables: Row[],
  oemRows: Row[],
  asOf: string,
): OverdueResult {
  if (receivables.length === 0) {
    return { rows: [], details: {}, unmapped: [], excluded: {} };
  }

  // `dict(zip(...))` — a repeated customer keeps the *last* OEM the key file gives it.
  const oemMap = new Map<string, unknown>();
  for (const row of oemRows) {
    const key = normText(row["Customer "]);
    if (key !== null) oemMap.set(key, row["OEM"]);
  }

  const asOfDay = toUtcDay(asOf);
  if (asOfDay === null) throw new Error(`as_of is not a date: ${asOf}`);

  const prepared: Prepared[] = receivables.map((row) => {
    const customerKey = normCode(row["Customer Code"]);
    const nameKey = normText(row["Customer Name"]);

    // A conversion agent's code overrides whatever the OEM key says its name maps to.
    let oem = nameKey === null ? undefined : oemMap.get(nameKey);
    if (customerKey !== null && customerKey in CONVERSION_AGENT_OEM_BY_CODE) {
      oem = CONVERSION_AGENT_OEM_BY_CODE[customerKey];
    }

    const invoiceDay = toUtcDay(row["Document Date"]);
    const dueDay = invoiceDay === null ? null : invoiceDay + RECEIVABLE_DUE_DAYS;

    // Billing Doc is the invoice number; Document Number is the accounting document.
    const billing = row["Billing Doc"];
    const billingNumber = toNumber(billing);
    const invoiceNo = isNa(billing) || billingNumber === null
      ? null
      : String(Math.trunc(billingNumber));

    return {
      row,
      name: isNa(row["Customer Name"]) ? null : pyStr(row["Customer Name"]),
      customerKey,
      oem: isNa(oem) ? null : pyStr(oem),
      openAmount: toNumber(row["Open Amount"]) ?? 0,
      invoiceDay,
      dueDay,
      daysOverdue: dueDay === null ? null : asOfDay - dueDay,
      invoiceNo,
      docTypeKey: pyStr(row["Doc Type"] ?? "").trim().toUpperCase(),
      natureKey: pyStr(row["Nature"] ?? "").trim().toUpperCase(),
    };
  });

  const overdue = prepared.filter(
    (r) => r.daysOverdue !== null && r.daysOverdue > 0 && BILLING_DOC_TYPES.has(r.docTypeKey));
  const offsets = prepared.filter((r) => OFFSET_NATURES.has(r.natureKey));
  const tvsRows = prepared.filter((r) => r.oem === "TVS");

  // What the two whitelists leave behind, tallied per Nature so setting the debit balances
  // aside is a figure somebody can check rather than a disappearance.
  const excluded: OverdueResult["excluded"] = {};
  for (const key of sortedGroupKeys(tvsRows
    .filter((r) => !BILLING_DOC_TYPES.has(r.docTypeKey) && !OFFSET_NATURES.has(r.natureKey))
    .map((r) => r.natureKey))) {
    const group = tvsRows.filter((r) =>
      !BILLING_DOC_TYPES.has(r.docTypeKey) && !OFFSET_NATURES.has(r.natureKey)
      && r.natureKey === key);
    excluded[key] = {
      documents: group.length,
      amount: pyRound(sum(group.map((r) => r.openAmount)), 2),
    };
  }

  const tvsOverdue = overdue.filter((r) => r.oem === "TVS");
  const details: Record<string, Row[]> = {};
  const rows: OverdueRow[] = [];

  // `groupby` sorts its keys, and the rows are built in that order before being re-sorted
  // by amount — so the name order is what breaks a tie on amount, and it has to be the
  // same name order.
  for (const name of sortedGroupKeys(tvsOverdue.map((r) => r.name))) {
    const group = tvsOverdue.filter((r) => r.name === name);
    const detailKey = `OVERDUE|${name}`;
    const offsetKey = `OFFSET|${name}`;
    const offsetGroup = offsets.filter((r) => r.name === name);

    details[detailKey] = [...group]
      .sort((a, b) => (b.daysOverdue ?? -Infinity) - (a.daysOverdue ?? -Infinity))
      .map((d) => ({
        invoice_no: d.invoiceNo,
        document: `${pyStr(d.row["Doc Type"])} ${pyStr(d.row["Document Number"])}`,
        invoice_date: utcDayIso(d.invoiceDay),
        due_date: utcDayIso(d.dueDay),
        age_days: d.daysOverdue,
        qty: d.openAmount,
        unit: "INR",
      }));

    details[offsetKey] = [...offsetGroup]
      .sort((a, b) => a.openAmount - b.openAmount)
      .filter((d) => d.openAmount !== 0)
      .map((d) => ({
        document: `${pyStr(d.row["Doc Type"])} ${pyStr(d.row["Document Number"])}`,
        nature: d.row["Nature"],
        posted_on: utcDayIso(d.invoiceDay),
        reference: d.invoiceNo === null ? null : String(d.invoiceNo),
        qty: d.openAmount,
        unit: "INR",
      }));

    const ages = group.map((r) => r.daysOverdue).filter((v): v is number => v !== null);
    rows.push({
      ancillary: name,
      customer_code: firstUnique(group.map((r) => r.customerKey)) ?? null,
      overdue_amount: pyRound(sum(group.map((r) => r.openAmount)), 2),
      documents: group.length,
      oldest_days: ages.length ? Math.max(...ages) : null,
      over_90_days_amount: pyRound(
        sum(group.filter((r) => (r.daysOverdue ?? 0) > 90).map((r) => r.openAmount)), 2),
      offsets_amount: pyRound(sum(offsetGroup.map((r) => r.openAmount)), 2),
      offsets_documents: offsetGroup.length,
      offsets_detail_key: offsetKey,
      overdue_debits: pyRound(sum(group.filter((r) => r.openAmount > 0)
        .map((r) => r.openAmount)), 2),
      overdue_credits: pyRound(sum(group.filter((r) => r.openAmount < 0)
        .map((r) => r.openAmount)), 2),
      detail_key: detailKey,
    });
  }

  // Stable, so a tie on amount keeps the name order the grouping produced.
  rows.sort((a, b) => b.overdue_amount - a.overdue_amount);

  const noOem = overdue.filter((r) => r.oem === null);
  const unmapped = sortedGroupKeys(noOem.map((r) => r.name)).map((name) => {
    const group = noOem.filter((r) => r.name === name);
    return {
      customer: name,
      overdue_amount: pyRound(sum(group.map((r) => r.openAmount)), 2),
      documents: group.length,
    };
  });

  return { rows, details, unmapped, excluded };
}

/* ---- helpers --------------------------------------------------------------- */

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * Distinct group keys in `groupby`'s order: sorted, with the absent key last.
 *
 * pandas sorts group keys by default and `dropna=False` keeps a null group, which it
 * places at the end. Insertion order would be the natural JavaScript choice and would
 * silently reorder every section.
 */
function sortedGroupKeys<T extends string | null>(values: T[]): T[] {
  const distinct = [...new Set(values)];
  const present = distinct.filter((v): v is Exclude<T, null> => v !== null).sort();
  return [...present, ...(distinct.includes(null as T) ? [null as T] : [])];
}
