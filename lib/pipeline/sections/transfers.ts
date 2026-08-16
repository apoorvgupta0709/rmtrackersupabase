/**
 * Section 12 — inter-plant transfers.
 *
 * Ported from `refresh_dashboard.py` L3982–4178. One row per despatched line: `DESP P LANT`
 * is the sending plant, `CUSTOMER CD`/`CUSTOMER NAME` name the *receiving* plant, and a
 * line stays in transit until that plant posts a goods receipt — so **an empty `GR DATE` is
 * the in-transit flag**. Quantity is in kilograms.
 *
 *  - **The header whitespace is collapsed before anything reads it.** This dump writes
 *    `BILLING  DATE` and `Billing  Document Number` with doubled spaces, and the section
 *    keys on the single-spaced names.
 *  - **A file with no transfer invoice line is not a transfer extract.** The daily mail has
 *    more than once carried a copy of the sales dump under the transfer filename, and sales
 *    lines never carry a transfer invoice type — so an empty result is reported as the
 *    wrong file rather than as no transfers.
 *  - **`TRANSFER|<n>` numbers the group in the *grouped* order, not the displayed one.**
 *    Rows are shown newest-in-transit first; the key keeps the index the grouping gave it.
 */

import { pyRound } from "../format.ts";
import { kahanSum } from "../numeric.ts";
import {
  firstUnique, isNa, makeCtlBucket, normCode, normDesc, pyStr, toNumber, toUtcDay, utcDayIso,
} from "../normalise.ts";
import type { Row } from "../source.ts";
import type { MaterialDimension } from "./material.ts";
import { LONG_LENGTH_MIN_M } from "./stock.ts";

export const TRANSFER_INVOICE_MARKER = "TRANSFER";

export type TransfersResult = {
  rows: Row[];
  details: Record<string, Row[]>;
  plants: { source: Row[]; destination: Row[] };
  available: boolean;
  note: string | null;
};

export function transfers(
  transferRows: Row[],
  dimension: MaterialDimension,
  asOf: string,
): TransfersResult {
  const empty: TransfersResult = {
    rows: [], details: {},
    plants: { source: [], destination: [] },
    available: false, note: "No transfer dump was supplied.",
  };
  if (transferRows.length === 0) return empty;

  // `re.sub(r"\s+", " ", c).strip()` over the headers, before any of them is read.
  const collapsed = transferRows.map((row) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) out[k.replace(/\s+/g, " ").trim()] = v;
    return out;
  });

  const tf = collapsed.filter((row) =>
    pyStr(row["Invoice Type"] ?? "").toUpperCase().includes(TRANSFER_INVOICE_MARKER)
    && !isNa(row["DESP P LANT"]));

  if (tf.length === 0) {
    return {
      ...empty,
      note: "The supplied transfer.xlsx contains no transfer invoice lines; "
        + "it is not a transfer extract.",
    };
  }

  /* ---- per line ------------------------------------------------------------ */

  const asOfDay = toUtcDay(asOf)!;

  const lines = tf.map((row) => {
    const materialKey = normCode(row["MATERAIL NUMBER"]);
    const descriptionKey = normDesc(row["Material Description"]);
    const bucket = (materialKey === null ? undefined : dimension.materialBucket.get(materialKey))
      ?? (descriptionKey === null ? undefined : dimension.descriptionBucket.get(descriptionKey))
      ?? null;
    const lengthM = toNumber(
      (descriptionKey === null ? undefined : dimension.descriptionLength.get(descriptionKey))
      ?? (materialKey === null ? undefined : dimension.materialLength.get(materialKey))
      ?? null);

    const billingDay = toUtcDay(row["BILLING DATE"]);
    const grnDay = toUtcDay(row["GR DATE"]);

    return {
      row,
      source_plant: normCode(row["DESP P LANT"]),
      dest_plant: normCode(row["CUSTOMER CD"]),
      material_key: materialKey,
      description_key: descriptionKey,
      bucket,
      length_m: lengthM,
      ctl_bucket: makeCtlBucket(bucket, lengthM),
      is_long: lengthM !== null && lengthM >= LONG_LENGTH_MIN_M,
      qty_mt: (toNumber(row["Quantity"]) ?? 0) / 1000,
      qty_nos: toNumber(row["qty in no"]) ?? 0,
      billing_day: billingDay,
      grn_day: grnDay,
      in_transit: grnDay === null,
      // To the goods receipt once posted, to the as-of date while still open.
      transit_days: billingDay === null ? null : (grnDay ?? asOfDay) - billingDay,
      document: normCode(row["Billing Document Number"]),
      sto_no: normCode(row["DO/STO NO"]),
      mark_customer: isNa(row["MARK DESTINATION"])
        ? normCode(row["MARK CUSTOMER"])
        : pyStr(row["MARK DESTINATION"]),
    };
  });

  /* ---- plant names, from the dump itself ----------------------------------- */

  const plantNames = new Map<string, string>();
  const sourceNames = firstUniqueBy(
    lines.filter((l) => l.source_plant !== null),
    (l) => l.source_plant!, (l) => l.row["PLANT DESC"]);
  const destNames = firstUniqueBy(
    lines.filter((l) => l.dest_plant !== null),
    (l) => l.dest_plant!, (l) => l.row["CUSTOMER NAME"]);
  for (const [k, v] of sourceNames) plantNames.set(k, v);
  for (const [k, v] of destNames) plantNames.set(k, v);

  const plantLabel = (code: string | null): string | null => {
    if (code === null) return null;
    const name = plantNames.get(code);
    return name ? `${code} - ${name}` : String(code);
  };

  const plants = {
    source: [...sourceNames.keys()].sort()
      .map((c) => ({ code: c, label: plantLabel(c) })),
    destination: [...destNames.keys()].sort()
      .map((c) => ({ code: c, label: plantLabel(c) })),
  };

  /* ---- grouped ------------------------------------------------------------- */

  const grouped = groupBy(lines, (l) => [
    l.source_plant, l.dest_plant, l.document, l.material_key,
    pick(l.row["Material Description"]), l.bucket, l.ctl_bucket,
    l.in_transit ? "True" : "False",
  ]);

  const aggregated = grouped.map(([parts, group], index) => ({
    // The index the grouping gave it — the detail key keeps this, not the display order.
    index,
    parts,
    group,
    qty_mt: kahanSum(group.map((l) => l.qty_mt)),
    qty_nos: kahanSum(group.map((l) => l.qty_nos)),
    batches: new Set(group.map((l) => l.row.BATCH).filter((b) => !isNa(b))).size,
    billing_day: minOf(group.map((l) => l.billing_day)),
    grn_day: maxOf(group.map((l) => l.grn_day)),
    transit_days: maxOf(group.map((l) => l.transit_days)),
    sto_no: firstUnique(group.map((l) => l.sto_no)) ?? null,
    mark_customer: firstUnique(group.map((l) => l.mark_customer)) ?? null,
    is_long: group.some((l) => l.is_long),
    in_transit: group[0].in_transit,
  }));

  const details: Record<string, Row[]> = {};
  const rows: Row[] = [];

  // In transit first, then newest billed. Stable, so an equal pair keeps group order.
  const displayed = [...aggregated].sort((a, b) => {
    if (a.in_transit !== b.in_transit) return a.in_transit ? -1 : 1;
    return (b.billing_day ?? -Infinity) - (a.billing_day ?? -Infinity);
  });

  for (const agg of displayed) {
    const detailKey = `TRANSFER|${agg.index}`;

    // The scope is deliberately narrower than the group key: batch detail is taken across
    // every description and bucket the same document moved for this material.
    const scope = lines.filter((l) =>
      l.source_plant === agg.parts[0] && l.dest_plant === agg.parts[1]
      && l.document === agg.parts[2] && l.material_key === agg.parts[3]
      && l.in_transit === agg.in_transit);

    details[detailKey] = groupBy(scope, (l) => [
      pick(l.row.BATCH), l.source_plant, l.dest_plant, l.document,
      dayKey(l.billing_day), dayKey(l.grn_day),
      l.in_transit ? "True" : "False", l.mark_customer,
    ])
      .map(([parts, group]) => ({ parts, group, qty: kahanSum(group.map((l) => l.qty_mt)) }))
      .sort((a, b) => b.qty - a.qty)
      .map(({ parts, group, qty }) => ({
        batch: parts[0],
        source_plant_label: plantLabel(group[0].source_plant),
        dest_plant_label: plantLabel(group[0].dest_plant),
        document: group[0].document,
        billing_date: utcDayIso(group[0].billing_day),
        grn_date: utcDayIso(group[0].grn_day),
        status: group[0].in_transit ? "In transit" : "Received",
        mark_customer: parts[7],
        qty,
        unit: "MT",
      }));

    rows.push({
      source_plant: agg.parts[0],
      source_plant_label: plantLabel(agg.parts[0]),
      dest_plant: agg.parts[1],
      dest_plant_label: plantLabel(agg.parts[1]),
      document: agg.parts[2],
      sto_no: agg.sto_no,
      material_code: agg.parts[3],
      description: agg.parts[4],
      bucket: agg.parts[5],
      ctl_bucket: agg.parts[6],
      length_type: agg.is_long ? "LL" : "CTL",
      billing_date: utcDayIso(agg.billing_day),
      grn_date: utcDayIso(agg.grn_day),
      status: agg.in_transit ? "In transit" : "Received",
      in_transit: agg.in_transit,
      transit_days: agg.transit_days === null ? null : Math.trunc(agg.transit_days),
      mark_customer: agg.mark_customer,
      qty_mt: pyRound(agg.qty_mt, 3),
      qty_nos: agg.qty_nos,
      batches: agg.batches,
      detail_key: detailKey,
    });
  }

  return { rows, details, plants, available: true, note: null };
}

/* ---- helpers --------------------------------------------------------------- */

const pick = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));
const dayKey = (day: number | null): string | null => (day === null ? null : String(day));

const minOf = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.min(...present) : null;
};
const maxOf = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.max(...present) : null;
};

function firstUniqueBy<T>(
  rows: T[],
  key: (row: T) => string,
  value: (row: T) => unknown,
): Map<string, string> {
  const groups = new Map<string, unknown[]>();
  for (const row of rows) {
    const k = key(row);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(value(row));
  }
  const out = new Map<string, string>();
  for (const [k, values] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const only = firstUnique(values);
    if (!isNa(only)) out.set(k, pyStr(only));
  }
  return out;
}

/** `groupby([...], dropna=False)` in pandas' sorted order, absent last on each level. */
function groupBy<T>(rows: T[], parts: (row: T) => (string | null)[]): [(string | null)[], T[]][] {
  const groups = new Map<string, [(string | null)[], T[]]>();
  for (const row of rows) {
    const p = parts(row);
    const k = JSON.stringify(p);
    (groups.get(k) ?? groups.set(k, [p, []]).get(k)!)[1].push(row);
  }
  return [...groups.values()].sort((a, b) => {
    for (let i = 0; i < Math.max(a[0].length, b[0].length); i += 1) {
      const x = a[0][i] ?? null;
      const y = b[0][i] ?? null;
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? -1 : 1;
    }
    return 0;
  });
}
