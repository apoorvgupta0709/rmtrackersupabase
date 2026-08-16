/**
 * Section 15 — the code repository.
 *
 * Ported from `refresh_dashboard.py` L5390–5488. One customer buys the same SKU under
 * several material codes, and bills it to one address while shipping it to another, so a
 * price change has to be raised against **every ship-to, bill-to, plant and code
 * combination that has actually been invoiced**. This is that list.
 *
 *  - **The longer sales window is read when it is supplied.** The daily dump is the current
 *    month only, so a code billed in April would otherwise be missing from a change request.
 *    Where no history slot exists the published month is used, and the window says which.
 *  - **The bucket is mapped from the material code first, then the description** — the
 *    reverse of `derive_sales`, which trusts the description first because the sales
 *    extract's material numbers all end in zero. Here the code has already been
 *    canonicalised, so it is the better key.
 *  - **Scope is the TVS ancillary base plus the Megh conversion codes**, which the OEM key
 *    files under Direct but which convert for TVS.
 */

import { pyRound } from "../format.ts";
import { kahanSum } from "../numeric.ts";
import {
  isNa, makeCtlBucket, normCode, normDesc, normText, pyStr, toNumber, toUtcDay, utcDayIso,
} from "../normalise.ts";
import type { Row } from "../source.ts";
import type { MaterialDimension } from "./material.ts";
import { CONVERSION_AGENT_OEM_BY_CODE } from "./overdue.ts";

export type RepositoryResult = {
  rows: Row[];
  window: Row;
};

export function codeRepository(
  source: Row[],
  dimension: MaterialDimension,
  oemMap: Map<string, unknown>,
  sourceFile: string,
): RepositoryResult {
  const repo = source.map((row) => {
    const customerKey = normCode(row["CUSTOMER  CD"]);
    const nameKey = normText(row["CUSTOMER  NAME"]);
    const materialKey = normCode(row["MATERAIL NUMBER"]);
    const descriptionKey = normDesc(row["Material   Description"]);

    // Code first here, description second — see the note at the top of this file.
    const bucket = (materialKey === null ? undefined : dimension.materialBucket.get(materialKey))
      ?? (descriptionKey === null ? undefined : dimension.descriptionBucket.get(descriptionKey))
      ?? null;
    const lengthM = toNumber(
      (descriptionKey === null ? undefined : dimension.descriptionLength.get(descriptionKey))
      ?? (materialKey === null ? undefined : dimension.materialLength.get(materialKey))
      ?? null);

    const fromKey = nameKey === null ? undefined : oemMap.get(nameKey);
    const conversion = customerKey === null
      ? undefined : CONVERSION_AGENT_OEM_BY_CODE[customerKey];
    const oem = conversion ?? (isNa(fromKey) ? null : pyStr(fromKey));

    return {
      row,
      customer_key: customerKey,
      material_key: materialKey,
      bucket,
      length_m: lengthM,
      ctl_bucket: makeCtlBucket(bucket, lengthM),
      oem,
      plant: normCode(row["DESP P LANT"]),
      ship_to_key: normCode(row["SHIP TO PARTY C"]),
      billing_day: toUtcDay(row["BILLING  DATE"]),
      qty_nos: toNumber(row["qty in no"]) ?? 0,
      qty_mt: (toNumber(row["Quantity"]) ?? 0) / 1000,
      in_scope: (conversion !== undefined)
        || (!isNa(fromKey) && pyStr(fromKey) === "TVS"),
    };
  }).filter((r) => r.in_scope && r.material_key !== null && r.qty_mt > 0);

  const grouped = groupBy(repo, (r) => [
    r.customer_key, pick(r.row["CUSTOMER  NAME"]), r.ship_to_key,
    pick(r.row["SHIPTO PARTY DISC"]), r.plant, r.material_key,
    pick(r.row["Material   Description"]), r.bucket, r.ctl_bucket,
    r.length_m === null ? null : String(r.length_m), r.oem,
  ]);

  const rows: Row[] = grouped
    .map(([parts, group]) => ({
      parts,
      name: parts[1],
      material: parts[5],
      plant: parts[4],
      invoices: new Set(group.map((r) => r.row["Billing  Document Number"])
        .filter((d) => !isNa(d))).size,
      qty_nos: kahanSum(group.map((r) => r.qty_nos)),
      qty_mt: kahanSum(group.map((r) => r.qty_mt)),
      first_billed: minOf(group.map((r) => r.billing_day)),
      last_billed: maxOf(group.map((r) => r.billing_day)),
      length_m: group[0].length_m,
    }))
    // Ascending by customer, then code, then plant. Stable, so the grouping breaks ties.
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.material, b.material) || cmp(a.plant, b.plant))
    .map((entry) => ({
      bill_to_code: entry.parts[0],
      bill_to_name: entry.parts[1] === null ? null : entry.parts[1].trim(),
      ship_to_code: entry.parts[2],
      ship_to_name: entry.parts[3] === null ? null : entry.parts[3].trim(),
      plant: entry.parts[4],
      material_code: entry.parts[5],
      description: entry.parts[6] === null ? null : entry.parts[6].trim(),
      bucket: entry.parts[7],
      ctl_bucket: entry.parts[8],
      length_mm: entry.length_m === null ? null : pyRound(entry.length_m * 1000, 1),
      oem: entry.parts[10],
      invoices: entry.invoices,
      qty_nos: entry.qty_nos,
      qty_mt: pyRound(entry.qty_mt, 3),
      first_billed: utcDayIso(entry.first_billed),
      last_billed: utcDayIso(entry.last_billed),
    }));

  const days = repo.map((r) => r.billing_day).filter((d): d is number => d !== null);

  return {
    rows,
    window: {
      source: sourceFile,
      from: days.length ? utcDayIso(Math.min(...days)) : null,
      to: days.length ? utcDayIso(Math.max(...days)) : null,
      rows: rows.length,
      customers: new Set(rows.map((r) => r.bill_to_code)).size,
      materials: new Set(rows.map((r) => r.material_code)).size,
      plants: [...new Set(rows.map((r) => r.plant).filter(Boolean))].sort() as string[],
      // One customer buying one size under more than one code is exactly what the
      // repository exists to surface, so the count is of distinct (customer, size) pairs.
      multi_code_skus: new Set(rows.filter((r) => r.ctl_bucket)
        .map((r) => `${r.bill_to_code}|${r.ctl_bucket}`)).size,
    },
  };
}

/* ---- helpers --------------------------------------------------------------- */

const pick = (value: unknown): string | null => (isNa(value) ? null : pyStr(value));

const cmp = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
};

const minOf = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.min(...present) : null;
};
const maxOf = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.max(...present) : null;
};

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
      const r = cmp(a[0][i] ?? null, b[0][i] ?? null);
      if (r !== 0) return r;
    }
    return 0;
  });
}
