/**
 * The pipeline's normalisation helpers, in TypeScript.
 *
 * These are the functions that turn what a sheet happens to hold into the string
 * everything else keys on, and almost every one of them exists because a join once missed.
 * The comments carry those cases across from `refresh_dashboard.py` deliberately: the
 * algorithms here are trivial, and the accumulated corrections are the whole asset. A port
 * that reproduces the code and drops the reasons will look right and quietly stop folding
 * a near-gauge that somebody agreed to fold three months ago.
 *
 * Two seams to know about, both of which the section-level parity harness is the real
 * guard against:
 *
 *  - **`pd.isna` is not `== null`.** Pandas treats `NaN`, `None` and `NA` alike; a cell
 *    that is empty in Excel arrives as `NaN`, which is *truthy*, which is why so many of
 *    the originals test for it explicitly. `isNa` below covers `null`, `undefined` and
 *    `NaN`, and — like pandas — does **not** treat `""` or `0` as absent.
 *  - **Python `str()` of a float keeps its point: `str(5.0)` is `"5.0"`, where JavaScript
 *    writes `"5"`.** It matters in `normText`, which strips non-alphanumerics and so turns
 *    Python's `"5.0"` into `"5 0"` and JavaScript's `"5"` into `"5"`. Where the pipeline
 *    reads a column pandas typed as float and the ported code reads the same column typed
 *    `text` by a snapshot view, the two can disagree without either being wrong. `pyStr`
 *    documents the choice; `--only <section>` on the parity harness is what proves it.
 */

import { pyRound, fmtG } from "./format.ts";

/** A finished length at or above this many metres is stated in millimetres, not metres. */
export const VSM_LENGTH_MM_ABOVE_M = 20;

/* ---- the primitives pandas supplies and JavaScript does not ---------------- */

/**
 * `pd.isna`, for the values that actually cross the wire.
 *
 * Not `!value`: an empty cell arrives as `NaN`, and `NaN` is truthy, so `if (!value)`
 * lets it through — which is the trap `blank_to_none` and `make_ctl_bucket` were both
 * written to close, the latter after building the CTL bucket `"nan-0.46"`, which passed
 * validation, matched nothing, and took its stock out of circulation while every
 * resolution count still read 100%.
 */
export function isNa(value: unknown): boolean {
  return value === null || value === undefined
    || (typeof value === "number" && Number.isNaN(value));
}

/**
 * `str(value)`, for the types a dump column yields.
 *
 * The part that is not obvious: **Python and JavaScript switch to exponential notation at
 * different magnitudes.** Python writes a float in fixed notation while its decimal
 * exponent is in `[-4, 16)` and exponentially outside that; JavaScript's window is
 * `(-7, 21)`. So `0.0000344824` is `"3.44824e-05"` to Python and `"0.0000344824"` to
 * JavaScript, and since nine of the helpers below are `str()` followed by a regular
 * expression, that one difference moved twenty answers before this was written properly.
 *
 * The remaining seam, which cannot be closed from here: Python distinguishes `int` from
 * `float`, so `str(5)` is `"5"` and `str(5.0)` is `"5.0"`, where JavaScript has one number
 * type and writes `"5"` for both. Integral values are therefore rendered without the point.
 * That is the right choice for `normCode`, whose `\\d+(\\.0+)?` branch normalises the two
 * together anyway, and it is the seam the section-level parity harness has to watch.
 */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value !== "number") return String(value);

  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";

  // `toExponential()` with no argument gives the shortest digits that round-trip, which is
  // the same set Python's `repr` picks; only the decision of where to put the point differs.
  const shortest = value.toExponential();
  const exponent = Number(shortest.slice(shortest.indexOf("e") + 1));
  if (exponent >= -4 && exponent < 16) return String(value);

  const [mantissa, rawExponent] = shortest.split("e");
  const sign = rawExponent.startsWith("-") ? "-" : "+";
  return `${mantissa}e${sign}${rawExponent.replace(/^[+-]/, "").padStart(2, "0")}`;
}

/**
 * `value or fallback`, where Python's falsiness is not JavaScript's.
 *
 * `0` is falsy in Python, so `str(key or "")` turns a zero key into the empty string and
 * `key_family(0)` is `None` rather than `"0"`. `NaN`, on the other hand, is *truthy* — which
 * is the whole reason so many of these helpers test for it explicitly.
 */
function pyOr(value: unknown, fallback: string): string {
  const falsy = value === null || value === undefined || value === false
    || value === 0 || value === "";
  return falsy ? fallback : pyStr(value);
}

/**
 * What Python's `float()` accepts, which is narrower than what `Number()` accepts.
 *
 * `Number("")` and `Number(" ")` are **0**, where `float("")` raises — so a helper that
 * leans on `Number` turns an empty cell into the string `"0"` and publishes it as a size.
 * `Number("0x10")` is 16, where `float("0x10")` raises. Both are the same class of fault as
 * the `"nan-0.46"` bucket: a value that is absent becomes a value that is present, valid
 * and wrong. So the literal is validated rather than coerced.
 */
const FLOAT_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function pyFloat(value: unknown): number | null {
  if (isNa(value)) return null;
  if (typeof value === "number") return value;
  const text = pyStr(value).trim();
  if (FLOAT_LITERAL.test(text)) return Number(text);
  // `float()` takes these spellings too, in any case, with an optional sign.
  if (/^[+-]?inf(inity)?$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(text)) return NaN;
  return null;
}

/** `pd.to_numeric(value, errors="coerce")`: a number, or null where it is not one. */
export function toNumber(value: unknown): number | null {
  const parsed = pyFloat(value);
  return parsed === null || Number.isNaN(parsed) ? null : parsed;
}

/* ---- text and codes -------------------------------------------------------- */

/** A material or customer code: digits as an integer, anything else upper-cased. */
export function normCode(value: unknown): string | null {
  if (isNa(value)) return null;
  const text = pyStr(value).trim();
  if (/^\d+(\.0+)?$/.test(text)) return String(Math.trunc(Number(text)));
  return text.toUpperCase();
}

/** Upper case, non-alphanumerics collapsed to single spaces, trimmed; empty becomes null. */
export function normText(value: unknown): string | null {
  if (isNa(value)) return null;
  const text = pyStr(value).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  return text.replace(/\s+/g, " ") || null;
}

/** A material description: upper case with runs of whitespace collapsed. */
export function normDesc(value: unknown): string | null {
  if (isNa(value)) return null;
  return pyStr(value).toUpperCase().replace(/\s+/g, " ").trim();
}

/** A number as a key component: rounded, then written the way Python's `%g` writes it. */
export function normNumber(value: unknown, digits = 4): string | null {
  if (isNa(value)) return null;
  const asNumber = pyFloat(value);
  if (asNumber === null) return normText(value);
  return fmtG(pyRound(asNumber, digits));
}

/* ---- the governed size tables ---------------------------------------------- */

/**
 * Wall thicknesses customers write, folded onto the gauge Bucketting actually governs.
 *
 * Kept as a table rather than as rounding, because the next one is a line and not a new
 * branch — and because folding here is recovering a size, not losing one. 1.22 is a
 * customer-written near-gauge like the 1.21 beside it: Bucketting governs 256 buckets at
 * 1.20 and none at either, so its absence meant Srikam, Rajsriya and NMPL lines written at
 * 1.22 met no bucket at all — 85,500 pieces on the August schedule reaching no row rather
 * than joining the 1.20 they are.
 */
export const THICKNESS_GROUPS = new Map<number, number>([
  [1.00, 1.00], [1.01, 1.00], [1.02, 1.00],
  [1.20, 1.20], [1.21, 1.20], [1.22, 1.20],
  [1.62, 1.60],   // Sandhar Technology writes 1.62; Bucketting governs only 1.6
  [1.50, 1.60], [1.60, 1.60], [1.63, 1.60],
  [1.90, 2.00], [1.95, 2.00], [2.00, 2.00], [2.03, 2.00],
  [2.25, 2.25], [2.32, 2.25],
  [2.30, 2.30], [2.34, 2.30],
  [2.41, 2.50], [2.45, 2.50], [2.50, 2.50],
  [2.60, 2.60], [2.65, 2.60],
  [2.70, 2.80], [2.75, 2.80], [2.80, 2.80],
  [3.00, 3.00], [3.02, 3.00],
  [3.40, 3.50], [3.50, 3.50],
]);

/**
 * Outside diameters that name a diameter Bucketting governs under a different number.
 *
 * Both entries are cases where Bucketting holds one value and nothing near it — 22.23
 * (never 22.2) and 41.28 (never 41.3) — so folding recovers the size rather than rounding
 * it away.
 */
export const OD_GROUPS = new Map<number, number>([
  [22.20, 22.23], [22.23, 22.23],
  [28.58, 28.58], [28.60, 28.58],
  [37.90, 37.95], [37.95, 37.95],
  [41.28, 41.28], [41.30, 41.28],
]);

const folded = (groups: Map<number, number>, value: unknown): string | null => {
  if (isNa(value)) return null;
  const asNumber = pyFloat(value);
  if (asNumber === null) return normText(value);
  const rounded = pyRound(asNumber, 2);
  return normNumber(groups.get(rounded) ?? rounded);
};

export const normThickness = (value: unknown): string | null => folded(THICKNESS_GROUPS, value);
export const normOd = (value: unknown): string | null => folded(OD_GROUPS, value);

/** Surface finishes, reduced to the two states the pipeline distinguishes. */
export function normSurface(value: unknown): string | null {
  const text = normText(value);
  if (text === "AW" || text === "AP" || text === "HR") return "AW";
  if (text === "AN" || text === "BH" || text === "NR") return "AN";
  return text;
}

/** The attribute key a material is identified by when its code cannot be trusted. */
export function attrKey(
  od: unknown,
  innerDiameter: unknown,
  thickness: unknown,
  specification: unknown,
  endFinish: unknown,
  surfaceFinish: unknown,
): string | null {
  const parts = [
    normOd(od),
    normNumber(isNa(innerDiameter) ? 0 : innerDiameter),
    normThickness(thickness),
    normCode(specification),
    normText(endFinish),
    normSurface(surfaceFinish),
  ];
  return parts.some((part) => part === null) ? null : parts.join("|");
}

/** One cell holding several codes, as a list. Separated by a pipe, comma or slash. */
export function splitCodes(value: unknown): string[] {
  if (isNa(value)) return [];
  return pyStr(value).split(/[|,/]/)
    .map((part) => normCode(part))
    .filter((code): code is string => Boolean(code));
}

/* ---- buckets --------------------------------------------------------------- */

/**
 * A bucket as written on a sheet, reduced to the string everything else keys on.
 *
 * A single trailing space makes a bucket a different string that renders identically, so
 * it silently becomes its own tracker row and its own pool. On the 30 July file the RM
 * tracker's TVSM sheet wrote `25.4-0-2.5-ERW 1-FC ` on one row: 60.304 MT of TVSM sales
 * sat on a phantom row of their own while the real bucket reported a 56 MT gap it had
 * already dispatched. Non-breaking spaces arrive through the same cells and collapse the
 * same way.
 *
 * Apply this wherever a bucket enters from a sheet, not only where one has been seen to be
 * dirty — a bucket is a join key, and a join key that depends on typing is not a key.
 */
export function normBucket(value: unknown): string | null {
  if (isNa(value)) return null;
  const text = pyStr(value).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

/** A bucket that says something: not blank, not a NaN spelling, not a review note. */
export function validBucket(value: unknown): boolean {
  if (isNa(value)) return false;
  const text = pyStr(value).trim().toUpperCase();
  return Boolean(text)
    && !["NAN", "NONE", "NULL"].includes(text)
    && !text.includes("CHECK")
    && !text.includes("NO KEY");
}

/**
 * A CTL bucket: the governed bucket with its cut length appended, or `-1` for a long one.
 *
 * The NaN guard is not defensive tidying. A missing bucket arrives as NaN as often as it
 * does as None, and `not nan` is False, so testing truthiness alone built the string
 * `"nan-0.46"` — a CTL bucket that passed validation, matched nothing, and took its stock
 * out of circulation while every resolution count still read 100%.
 */
export function makeCtlBucket(bucket: unknown, lengthM: unknown): string | null {
  if (isNa(bucket) || !pyStr(bucket).trim() || isNa(lengthM)) return null;
  // The original calls `float(length_m)` unguarded, so a length that is present but not a
  // number raises rather than returning. Refusing the bucket is the safer reading of the
  // same intent: a CTL bucket with no length is the `"nan-0.46"` fault in another costume.
  const length = pyFloat(lengthM);
  if (length === null || Number.isNaN(length)) return null;
  const suffix = length >= 3.5 ? "1" : normNumber(length, 4);
  return `${pyStr(bucket)}-${suffix}`;
}

/**
 * The Megh SKU key: a governed bucket with the finished length appended.
 *
 * This is the shape the `vsm stock` plan states in its own `length key` column, and every
 * frame joining to a Megh SKU has to build the same one. It replaced a key assembled as
 * `OD-ID-thickness-length-grade-cuttype`, whose cut token was read off the bucket's end
 * condition — so wherever the plan and Bucketting disagreed there, the key missed and the
 * tonnage left the tab rather than landing on a SKU.
 */
export function bucketVsmKey(bucket: unknown, length: unknown): string | null {
  const cleaned = normBucket(bucket);
  if (!cleaned || isNa(length)) return null;
  const rendered = normNumber(length, 4);
  return rendered === null ? null : `${cleaned}-${rendered}`;
}

/**
 * The plan's own length key, corrected only where it could not otherwise join.
 *
 * The sheet stays as written; only the derived join key moves. Two corrections, both
 * agreed with the owner: whitespace collapses, so `25.4-0-2.5-ERW 1-FC -5.95` meets the key
 * every other frame builds; and a trailing length above `VSM_LENGTH_MM_ABOVE_M` is
 * millimetres — the plan writes 572.5 beside 5.95 and 6.0, and stock, sales and WIP all
 * normalise to metres, so as written such a row could never meet them.
 *
 * Anything whose last component is not a number comes back as written: a key that states
 * no length is not one to invent a length for.
 */
export function normLengthKey(value: unknown): string | null {
  if (isNa(value)) return null;
  let text = pyStr(value).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  text = text.replace(/\s*-\s*/g, "-");

  const at = text.lastIndexOf("-");
  if (at <= 0) return text;
  const head = text.slice(0, at);
  const tail = text.slice(at + 1);

  let length = toNumber(tail);
  if (length === null) return text;
  if (length > VSM_LENGTH_MM_ABOVE_M) length = length / 1000;
  const rendered = normNumber(length, 4);
  return rendered === null ? text : `${head}-${rendered}`;
}

/**
 * The SKU key without its length component — the key for "other length" stock.
 *
 * Derived from the key itself rather than rebuilt from dimensions, so both sides of the
 * join produce it the same way. For a governed size that is the bucket; for a `Megh-` size
 * it is `Megh-OD-ID-thickness`, which is the honest answer — such a size has no governed
 * bucket for other-length stock to be found under.
 */
export function keyFamily(key: unknown): string | null {
  const text = pyOr(key, "");
  const at = text.lastIndexOf("-");
  if (at > 0 && toNumber(text.slice(at + 1)) !== null) return text.slice(0, at);
  return text || null;
}

/* ---- descriptions ---------------------------------------------------------- */

const DESCRIPTION_DIMENSIONS =
  /(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)(?:X(\d+(?:\.\d+)?))?\s*$/;

/**
 * Read OD, ID and thickness out of a material description.
 *
 * Round sections read as OD x thickness x length, rectangular and square as
 * width x height x thickness x length, so the token count decides the layout.
 */
export function descriptionShape(
  description: unknown,
): [string | null, string | null, string | null] | null {
  const text = isNa(description) ? "" : pyStr(description).trim();
  const match = DESCRIPTION_DIMENSIONS.exec(text);
  if (!match) return null;
  const [, first, second, third, fourth] = match;
  if (fourth === undefined) return [normOd(first), normNumber(0), normThickness(second)];
  return [normOd(first), normNumber(second), normThickness(third)];
}

/**
 * True when a description's dimensions agree with the bucket it was given.
 *
 * A material code whose governed bucket contradicts its own description cannot be trusted:
 * the dump reuses one code across physically different materials.
 */
export function shapeMatchesBucket(description: unknown, bucket: unknown): boolean {
  const shape = descriptionShape(description);
  const parts = (isNa(bucket) ? "" : pyStr(bucket)).split("-");
  if (shape === null || parts.length < 3) return true;
  return shape.map((v) => String(v)).join(" ") === parts.slice(0, 3).join(" ");
}

/* ---- odds and ends --------------------------------------------------------- */

/**
 * A plan cell that says nothing, as null.
 *
 * Test every plan cell for absence explicitly. `NaN` is truthy, so `if (!sku)` lets a row
 * with no key through to become a dictionary key, and `bucket || null` keeps a `NaN` as
 * the bucket — which then reads as governed and never reaches the assign-a-bucket queue.
 */
export function blankToNone<T>(value: T): T | null {
  return isNa(value) || !pyStr(value).trim() ? null : value;
}

/** The one value a series holds, or null where it holds none or more than one. */
export function firstUnique<T>(series: Iterable<T>): T | null {
  const unique = [...new Set([...series].filter((v) => !isNa(v)))];
  return unique.length === 1 ? unique[0] : null;
}

/**
 * A bucket split into its text and numeric runs, so a list of them sorts the way a reader
 * expects — `25.4` before `31.75`, not `25.4` before `3.175` as strings would.
 */
export function naturalBucketKey(value: unknown): (string | number)[] {
  return pyOr(value, "").split(/(\d+(?:\.\d+)?)/)
    .map((part) => (/^\d+(?:\.\d+)?$/.test(part) ? Number(part) : part.toUpperCase()));
}

/** Compare two natural keys, for `sort`. Mirrors Python's tuple ordering. */
export function compareNaturalBucket(a: unknown, b: unknown): number {
  const left = naturalBucketKey(a);
  const right = naturalBucketKey(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (i >= left.length) return -1;
    if (i >= right.length) return 1;
    const x = left[i];
    const y = right[i];
    // A tuple holding a number where the other holds a string is a TypeError in Python
    // rather than an ordering, and the splitter alternates the two, so matching indices
    // always agree in type. Ordering them anyway keeps this total rather than throwing.
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** `Q4 FY26` -> `[26, 4]`, so a list of quarters sorts into calendar order. */
export function financialQuarterOrder(label: string): [number, number] {
  const [quarter, fy] = label.split(" FY");
  return [Number(fy), Number(quarter.slice(1))];
}

/**
 * Whole pieces, grouped, for text a planner reads on screen.
 *
 * Python's `:,` is three-digit grouping despite the original's docstring calling it
 * Indian, and this reproduces what the code does rather than what the comment says.
 */
export function fmtNos(value: unknown): string {
  const asNumber = toNumber(value);
  if (asNumber === null || !Number.isFinite(asNumber)) return "0";
  // `+ 0` collapses the negative zero that rounding -0.13 leaves behind. Python rounds to
  // an `int`, which has no signed zero, so it writes "0" where `toLocaleString` writes "-0".
  return (pyRound(asNumber) + 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
