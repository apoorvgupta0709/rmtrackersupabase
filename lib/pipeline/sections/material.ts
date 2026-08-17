/**
 * Section 1 — the governed material dimension.
 *
 * Ported from `refresh_dashboard.py` L1338–1441. Not a payload section: it is the shared
 * intermediate every other one joins through, which is why it comes first. `overdue_analysis`
 * was the only section in the pipeline that stands free of it.
 *
 * The shape of the answer, in one sentence: **Bucketting governs a material code directly,
 * and zmat spreads that governance to codes it never named** — a code with no row in
 * Bucketting still resolves if some other code with the same physical attributes has one.
 * `attr_key` is what carries it across, which is why that key exists at all.
 *
 * Three decisions worth not losing:
 *
 *  - **The owner's assignments are applied last, as an override and not a fallback.** This
 *    is the single place a code becomes a bucket, so this is what makes an answer given on
 *    the Missing mappings tab actually move tonnage onto a tracker. A code the master
 *    resolves *wrongly* is exactly the case somebody is correcting, and a fallback would
 *    silently ignore them.
 *  - **A description that maps to more than one code recovers none of them.** Naming one
 *    arbitrarily could raise a transfer on the wrong material; the candidates are quoted
 *    instead, which is the honest answer rather than a blank.
 *  - **`first_unique` everywhere, not `first`.** A key that two rows disagree about resolves
 *    to nothing rather than to whichever row the frame happened to hold first — the
 *    difference between an unmapped code somebody can fix and a wrong one nobody can see.
 */

import {
  attrKey, firstUnique, isNa, normCode, normDesc, normBucket, pyStr, toNumber, validBucket,
} from "../normalise.ts";
import type { Row } from "../source.ts";

/** zmat's `MATERIAL TYPE` for a finished good. */
export const FG_MATERIAL_TYPE = "FERT";

/** A mother tube standing in WIP carries a `PTM-` description; its finished good a `TUB-`. */
export const WIP_DESCRIPTION_PREFIX = "PTM";
export const FG_DESCRIPTION_PREFIX = "TUB";

export type MaterialDimension = {
  /** Bucketting's own rows, by material code. */
  direct: Map<string, { Bucket: string | null; "LL or CTL": unknown; "CTL Bucket": string | null; Length: unknown }>;
  materialBucket: Map<string, string>;
  materialLength: Map<string, unknown>;
  descriptionBucket: Map<string, string>;
  descriptionMaterial: Map<string, string>;
  descriptionMaterials: Map<string, string[]>;
  descriptionLength: Map<string, unknown>;
  fgCodesByDescription: Map<string, string[]>;
  /** Keyed `description|plant`, as the dump writes a detail key. */
  fgCodesByDescriptionPlant: Map<string, string[]>;
};

const LENGTH_COLUMN = "LENGTH FOR TATA TUBES MATERIAL (WITH 4 D";

export function materialDimension(
  bucketting: Row[],
  zmat: Row[],
  assignments: { bucket?: Record<string, string> } = {},
): MaterialDimension {
  /* ---- Bucketting: the codes somebody has governed by hand ----------------- */

  const governed = bucketting
    .map((row) => ({
      material_key: normCode(row["Material Codes"]),
      Bucket: normBucket(row["Bucket"]),
      "CTL Bucket": normBucket(row["CTL Bucket"]),
      "LL or CTL": row["LL or CTL"],
      Length: row["Length"],
    }))
    .filter((row) => validBucket(row.Bucket));

  // `sort_values("material_key").drop_duplicates("material_key")` — sorted, then the first
  // of each code wins. Sorting first is what makes "first" mean something reproducible.
  const direct: MaterialDimension["direct"] = new Map();
  for (const row of [...governed].sort(compareMaybe((r) => r.material_key))) {
    if (row.material_key !== null && !direct.has(row.material_key)) {
      direct.set(row.material_key, {
        Bucket: row.Bucket,
        "LL or CTL": row["LL or CTL"],
        "CTL Bucket": row["CTL Bucket"],
        Length: row.Length,
      });
    }
  }

  /* ---- zmat: every code SAP has extended, with its attributes -------------- */

  type Zmat = {
    material_key: string | null;
    description_key: string | null;
    attr_key: string | null;
    length: unknown;
    material_type: string;
    plant_key: string | null;
  };

  const rows: Zmat[] = zmat.map((row) => ({
    material_key: normCode(row["Column1"]),
    description_key: normDesc(row["MATERIAL DESCRIPTION"]),
    attr_key: attrKey(
      row["OUTER DIAMETER OF MATERIAL"],
      row["INNER DIAMETER OF MATERIAL"],
      row["THICKNESS FOR TATA TUBES MATERIAL"],
      row["MATERIAL SPECIFICATION"],
      row["MATERIAL END FINISH"],
      row["MATERIAL SURFACE FINISH"],
    ),
    length: row[LENGTH_COLUMN],
    material_type: pyStr(row["MATERIAL TYPE"] ?? "").toUpperCase(),
    plant_key: normCode(row["PLANT"]),
  }));

  // `drop_duplicates` keeps the first of each (code, description, attributes, length).
  const seen = new Set<string>();
  const distinct = rows.filter((r) => {
    const key = JSON.stringify([r.material_key, r.description_key, r.attr_key, r.length]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  /* ---- spread governance across codes that share attributes ---------------- */

  // Trained only on codes Bucketting names: what a governed code's attributes mean.
  // `first_unique`, so an attribute set two buckets disagree about teaches nothing.
  const trained = distinct
    .filter((r) => r.material_key !== null && direct.has(r.material_key))
    .map((r) => ({ attr_key: r.attr_key, bucket: direct.get(r.material_key!)!.Bucket }))
    .filter((r) => r.attr_key !== null && r.bucket !== null);

  const attrCandidates = groupFirstUnique(
    trained, (r) => r.attr_key!, (r) => r.bucket!);

  const resolved = distinct.map((r) => {
    const directBucket = r.material_key === null
      ? undefined : direct.get(r.material_key)?.Bucket ?? undefined;
    const inferred = r.attr_key === null ? undefined : attrCandidates.get(r.attr_key);
    return { ...r, resolved_bucket: directBucket ?? inferred ?? null };
  });

  const materialBucket = groupFirstUnique(
    resolved, (r) => r.material_key, (r) => r.resolved_bucket);

  // Applied last, so they win. See the note at the top of this file.
  for (const [code, bucket] of Object.entries(assignments.bucket ?? {})) {
    materialBucket.set(code, bucket);
  }

  const materialLength = groupFirstUnique(resolved, (r) => r.material_key, (r) => r.length);
  const descriptionBucket = groupFirstUnique(
    resolved, (r) => r.description_key, (r) => r.resolved_bucket);
  // Recovers a true material code from a description. The WIP dump zeroes the final digit
  // of every material number, the same defect the sales file has, so its codes cannot be
  // trusted or joined on directly.
  const descriptionMaterial = groupFirstUnique(
    resolved, (r) => r.description_key, (r) => r.material_key);
  const descriptionLength = groupFirstUnique(
    resolved, (r) => r.description_key, (r) => r.length);

  const descriptionMaterials = groupSortedSet(
    resolved.filter((r) => r.description_key !== null && r.material_key !== null),
    (r) => r.description_key!, (r) => r.material_key!);

  /* ---- finished goods, by description and by description and plant --------- */

  const fg = resolved.filter((r) => r.material_type === FG_MATERIAL_TYPE);

  const fgCodesByDescription = groupSortedSet(
    fg.filter((r) => r.description_key !== null && r.material_key !== null),
    (r) => r.description_key!, (r) => r.material_key!);

  const fgCodesByDescriptionPlant = groupSortedSet(
    fg.filter((r) =>
      r.description_key !== null && r.material_key !== null && r.plant_key !== null),
    (r) => `${r.description_key}|${r.plant_key}`, (r) => r.material_key!);

  return {
    direct,
    materialBucket,
    materialLength,
    descriptionBucket,
    descriptionMaterial,
    descriptionMaterials,
    descriptionLength,
    fgCodesByDescription,
    fgCodesByDescriptionPlant,
  };
}

/**
 * The finished-goods code an STR can be raised on for a mother-tube description.
 *
 * An STR can only be raised on a finished-goods code. Mother tubes standing in WIP carry a
 * `PTM-` description; the finished goods that will be booked against them carry the same
 * description under `TUB-`, so the code is recovered by swapping the prefix.
 *
 * Returns `[null, null]` when the swapped description is not in zmat, which is how a mother
 * tube with no finished equivalent is told apart from one that simply has no stock.
 */
export function fgCodeForMotherTube(
  dimension: MaterialDimension,
  descriptionKey: string | null,
  plant: string | null,
  bucket: string | null,
): [string | null, string | null] {
  const text = descriptionKey ?? "";
  if (!text.startsWith(WIP_DESCRIPTION_PREFIX)) return [null, null];
  const fgKey = FG_DESCRIPTION_PREFIX + text.slice(WIP_DESCRIPTION_PREFIX.length);

  let candidates = dimension.fgCodesByDescriptionPlant.get(`${fgKey}|${plant}`) ?? [];
  if (candidates.length === 0) candidates = dimension.fgCodesByDescription.get(fgKey) ?? [];
  if (candidates.length === 0) return [null, null];

  // Prefer a code whose governed bucket agrees with the mother tube's, then take the
  // lowest so repeated runs pick the same one.
  const governed = candidates.filter((code) => dimension.materialBucket.get(code) === bucket);
  const pool = governed.length ? governed : candidates;
  const chosen = [...pool].sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0))[0];
  return [chosen, fgKey];
}

/* ---- grouping helpers ------------------------------------------------------ */

/**
 * `groupby(key)[value].agg(first_unique).dropna()`.
 *
 * A group whose values disagree contributes nothing, and so does one whose only value is
 * absent — that is `dropna()` doing the second half of the job, and dropping it would turn
 * "nobody has said" into "the answer is null" everywhere downstream.
 */
function groupFirstUnique<T, V>(
  rows: T[],
  key: (row: T) => string | null,
  value: (row: T) => V,
): Map<string, NonNullable<V>> {
  const groups = new Map<string, V[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(value(row));
  }
  const out = new Map<string, NonNullable<V>>();
  for (const [k, values] of groups) {
    const only = firstUnique(values);
    if (!isNa(only)) out.set(k, only as NonNullable<V>);
  }
  return out;
}

/** `groupby(key)[value].agg(lambda s: sorted(set(s)))`. */
function groupSortedSet<T>(
  rows: T[],
  key: (row: T) => string,
  value: (row: T) => string,
): Map<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const row of rows) {
    const k = key(row);
    (groups.get(k) ?? groups.set(k, new Set()).get(k)!).add(value(row));
  }
  return new Map([...groups].map(([k, set]) => [k, [...set].sort()]));
}

/** `sort_values` on a possibly-absent key: pandas puts the absent ones last. */
function compareMaybe<T>(of: (row: T) => string | null) {
  return (a: T, b: T): number => {
    const x = of(a);
    const y = of(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

/** Numbers that arrive as text, for callers joining on a length. */
export const asLength = (value: unknown): number | null => toNumber(value);
