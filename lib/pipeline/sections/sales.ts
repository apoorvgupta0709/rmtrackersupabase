/**
 * Section 2 — the sales mapping.
 *
 * Ported from `refresh_dashboard.py` L1504–1633. Like the material dimension, not a
 * published section: it is the other thing most sections join through.
 *
 * **The material number is not a usable primary key here.** Every value in this extract
 * ends in zero, so description and attribute mapping is primary and the code is the
 * fallback — the reverse of what the column names suggest.
 *
 * Three decisions worth not losing:
 *
 *  - **Every line is derived once, then sliced.** The whole window and the published month
 *    go through the same function, because a trend that disagreed with the month it
 *    overlaps would be worse than no trend. Deriving once makes that structural rather
 *    than something to remember.
 *  - **`code_oem` is read across the whole ledger, never the published month.** A code's
 *    OEM does not change month to month, but the daily dump only covers the month in
 *    progress: on 3 August it held three days and 125 lines, most schedule customers had
 *    not bought yet, and schedule OEM resolution fell to 66.75% against a 99% publication
 *    gate. Nothing was wrong with the data — the derivation assumed a populated month.
 *  - **The OEM key result is kept separate from the Boiler override.** Customer mapping
 *    exceptions must turn on whether the customer is in `OEM_key_1_rev codes`, not on a
 *    material-driven override, so `oem_key_oem` survives beside `OEM`.
 */

import {
  firstUnique, isNa, makeCtlBucket, normCode, normDesc, normText, pyStr, toNumber,
  toUtcDay, toUtcMonth,
} from "../normalise.ts";
import type { Row } from "../source.ts";
import type { MaterialDimension } from "./material.ts";

/** Material groups whose lines are Boiler regardless of customer. */
const BOILER_MATERIAL_GROUP = /(?:BOT|COR|AHT)$/;

export type SalesLine = Row & {
  customer_key: string | null;
  customer_name_key: string | null;
  description_key: string | null;
  material_key: string | null;
  bucket: string | null;
  length_m: number | null;
  ctl_bucket: string | null;
  oem_key_oem: string | null;
  OEM: string | null;
  sales_nos: number;
  sales_m: number;
  sales_mt: number;
  billing_month: string | null;
};

export type SalesMapping = {
  all: SalesLine[];
  published: SalesLine[];
  /** `customer_key|ctl_bucket` -> the month's totals. */
  salesLookup: Map<string, {
    sales_nos: number; sales_m: number; sales_mt: number; sales_rows: number;
  }>;
  codeOem: Map<string, string>;
  soByCustomerCtl: Map<string, SoValue>;
  soByCtlPlant: Map<string, SoValue>;
  soByCtl: Map<string, SoValue>;
  soByCustomerMaterial: Map<string, SoValue>;
  soByMaterial: Map<string, SoValue>;
};

/** `(so_number, supply_plant, material_key)`, as the pipeline carries it. */
export type SoValue = [string | null, string | null, string | null];

/** `oem["Customer "] -> oem["OEM"]`; a repeated customer keeps the last one given. */
export function oemMapOf(oemRows: Row[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const row of oemRows) {
    const key = normText(row["Customer "]);
    if (key !== null) map.set(key, row["OEM"]);
  }
  return map;
}

/** Every column the rest of the pipeline expects on a sales frame. */
export function deriveSales(
  rows: Row[],
  dimension: MaterialDimension,
  oemMap: Map<string, unknown>,
): SalesLine[] {
  return rows.map((row) => {
    const descriptionKey = normDesc(row["Material   Description"]);
    const materialKey = normCode(row["MATERAIL NUMBER"]);

    // Description first, code second — see the note at the top of this file.
    const bucket = (descriptionKey === null ? undefined : dimension.descriptionBucket.get(descriptionKey))
      ?? (materialKey === null ? undefined : dimension.materialBucket.get(materialKey))
      ?? null;

    const lengthFromDescription = descriptionKey === null
      ? undefined : dimension.descriptionLength.get(descriptionKey);
    const lengthM = !isNa(lengthFromDescription)
      ? toNumber(lengthFromDescription)
      : toNumber(row["Length for TATA Tubes Material"]);

    const customerNameKey = normText(row["CUSTOMER  NAME"]);
    const oemKeyOem = customerNameKey === null ? undefined : oemMap.get(customerNameKey);

    const materialGroupKey = pyStr(row["MATERIAL GROUP"] ?? "").trim().toUpperCase();
    const oem = BOILER_MATERIAL_GROUP.test(materialGroupKey)
      ? "Boiler"
      : (isNa(oemKeyOem) ? null : pyStr(oemKeyOem));

    return {
      ...row,
      customer_key: normCode(row["CUSTOMER  CD"]),
      customer_name_key: customerNameKey,
      description_key: descriptionKey,
      material_key: materialKey,
      bucket,
      length_m: lengthM,
      ctl_bucket: makeCtlBucket(bucket, lengthM),
      oem_key_oem: isNa(oemKeyOem) ? null : pyStr(oemKeyOem),
      OEM: oem,
      sales_nos: toNumber(row["qty in no"]) ?? 0,
      sales_m: toNumber(row["Domain for z_qty_meter"]) ?? 0,
      sales_mt: (toNumber(row["Quantity"]) ?? 0) / 1000,
      billing_month: toUtcMonth(row["BILLING  DATE"]),
    };
  });
}

export function salesMapping(
  ledger: Row[],
  oemRows: Row[],
  dimension: MaterialDimension,
  publishedMonth: string,
): SalesMapping {
  const oemMap = oemMapOf(oemRows);
  const all = deriveSales(ledger, dimension, oemMap);
  const published = all.filter((line) => line.billing_month === publishedMonth);

  /* ---- the month's totals, by customer and CTL bucket --------------------- */

  const salesLookup: SalesMapping["salesLookup"] = new Map();
  for (const line of published) {
    if (line.customer_key === null || line.ctl_bucket === null) continue;
    const key = `${line.customer_key}|${line.ctl_bucket}`;
    const at = salesLookup.get(key)
      ?? { sales_nos: 0, sales_m: 0, sales_mt: 0, sales_rows: 0 };
    at.sales_nos += line.sales_nos;
    at.sales_m += line.sales_m;
    at.sales_mt += line.sales_mt;
    at.sales_rows += 1;
    salesLookup.set(key, at);
  }

  /* ---- which OEM a customer code belongs to, over the whole ledger -------- */

  // `first_unique`, so a code two OEMs disagree about answers nothing rather than
  // whichever line came first. Order does not enter into it, which is the point.
  const byCode = new Map<string, (string | null)[]>();
  for (const line of all) {
    if (line.customer_key === null || line.OEM === null) continue;
    (byCode.get(line.customer_key) ?? byCode.set(line.customer_key, []).get(line.customer_key)!)
      .push(line.OEM);
  }
  const codeOem = new Map<string, string>();
  for (const [code, values] of byCode) {
    const only = firstUnique(values);
    if (!isNa(only)) codeOem.set(code, only as string);
  }

  /* ---- sales orders for the dispatch plan --------------------------------- */

  // Last invoice wins — the loop overwrites — so the sort decides which SO and despatch
  // plant a schedule line is offered. Stable, because several invoices share a date and
  // their order among themselves would otherwise be decided by however the frame happened
  // to be assembled. That was invisible while sales came from one file in file order.
  const orders = published
    .map((line) => {
      const so = line["SO/STR No"];
      const soNumber = toNumber(so);
      return {
        so_number: isNa(so) || soNumber === null ? null : String(Math.trunc(soNumber)),
        supply_plant: normCode(line["Supply Plant."]),
        material_key: line.material_key,
        customer_key: line.customer_key,
        ctl_bucket: line.ctl_bucket,
        invoice_day: toUtcDay(line["BILLING  DATE"]),
      };
    })
    .filter((r) => r.so_number !== null && r.ctl_bucket !== null);

  // `na_position` is not set on this sort, so pandas puts absent dates last.
  const sorted = [...orders].sort((a, b) => {
    if (a.invoice_day === null && b.invoice_day === null) return 0;
    if (a.invoice_day === null) return 1;
    if (b.invoice_day === null) return -1;
    return a.invoice_day - b.invoice_day;
  });

  const soByCustomerCtl = new Map<string, SoValue>();
  const soByCtlPlant = new Map<string, SoValue>();
  const soByCtl = new Map<string, SoValue>();
  const soByCustomerMaterial = new Map<string, SoValue>();
  const soByMaterial = new Map<string, SoValue>();

  for (const r of sorted) {
    const value: SoValue = [r.so_number, r.supply_plant, r.material_key];
    soByCustomerCtl.set(`${blank(r.customer_key)}|${blank(r.ctl_bucket)}`, value);
    soByCtlPlant.set(`${blank(r.ctl_bucket)}|${blank(r.supply_plant)}`, value);
    soByCtl.set(blank(r.ctl_bucket), value);
    // `if r.material_key:` — a null *and* an empty string both fall through here.
    if (r.material_key) {
      soByCustomerMaterial.set(`${blank(r.customer_key)}|${r.material_key}`, value);
      soByMaterial.set(r.material_key, value);
    }
  }

  return {
    all,
    published,
    salesLookup,
    codeOem,
    soByCustomerCtl,
    soByCtlPlant,
    soByCtl,
    soByCustomerMaterial,
    soByMaterial,
  };
}

/* ---- helpers --------------------------------------------------------------- */

/** A tuple component in a joined key: an absent one contributes nothing, as `str(None)`
 *  would not — the dump writes `""` for it, so both sides agree on the same key. */
const blank = (value: string | null): string => value ?? "";

