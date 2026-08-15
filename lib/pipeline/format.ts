/**
 * Python's `%g`, in TypeScript, because the drill-down keys are built out of it.
 *
 * Ten places in `refresh_dashboard.py` write a float with `f"{x:g}"`, and most of them
 * are building a key — `f"{dim1:g}x{dim2:g}x{thickness:g}x{length_mm:g}"` at L3336 and
 * L3392, the Megh BOP lookup at L3318 and L3364, the size face at L2453. A key is only
 * ever compared for equality, so a formatter that disagrees with Python by one character
 * does not produce a wrong number: it produces a key that matches nothing, and a reader
 * opens a breakup that is silently empty. There is no error and nothing reconciles it.
 *
 * `check_pricing_formula.mjs` already asserts one instance of this — that JavaScript and
 * Python write an integral length the same way — because they did not. This is that
 * assertion generalised into the one function every key construction goes through.
 *
 * **Neither `toFixed` nor `toPrecision` can be used to round.** Both round halfway cases
 * away from zero; Python rounds half to even. Over the published build that is four
 * disagreements in eighteen thousand — `2814.125` becomes `2814.13` where Python writes
 * `2814.12`, `3175885` becomes `3.17589e+06` where Python writes `3.17588e+06` — which is
 * exactly the density that survives a spot-check and breaks a key months later. So the
 * value's *exact* decimal expansion is computed first, in BigInt, and rounded by hand.
 * Every double is a dyadic rational and therefore has a terminating decimal expansion, so
 * "exact" here is literal and not an approximation with more digits.
 */

/**
 * Format a number as CPython's `format(value, "g")` does.
 *
 * The rule, from CPython's `float__format__`: with precision `P` (0 treated as 1) and `X`
 * the decimal exponent of the value *after* rounding to `P` significant digits, use
 * fixed-point with `P-1-X` decimals when `-4 <= X < P`, and exponential with `P-1`
 * decimals otherwise. Then strip trailing zeros from the fraction, and the point if
 * nothing survives it.
 *
 * Taking `X` after rounding is the part that is easy to get wrong: at `P = 1`, `999.9`
 * rounds to `1e3`, so `X` is 3 and not 2, and the branch changes with it.
 */
export function fmtG(value: number, precision = 6): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  // `(-0).toFixed(0)` is `"0"`; Python writes `-0`. Cheap to honour, and a sign present in
  // one implementation and not the other is precisely a key that stops matching.
  if (Object.is(value, -0)) return "-0";
  if (value === 0) return "0";

  const p = precision === 0 ? 1 : precision;
  const sign = value < 0 ? "-" : "";

  let { digits, exponent } = exactDecimal(Math.abs(value));
  ({ digits, exponent } = roundHalfEven(digits, exponent, p));

  // The decimal exponent of the rounded value: `X` in the rule above.
  const x = digits.length - 1 + exponent;

  if (x >= -4 && x < p) {
    return sign + stripTrailingZeros(toFixedPoint(digits, exponent));
  }
  const mantissa = stripTrailingZeros(
    digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits,
  );
  // Python writes at least two exponent digits (`1e+06`, not `1e+6`).
  const magnitude = String(Math.abs(x)).padStart(2, "0");
  return `${sign}${mantissa}e${x < 0 ? "-" : "+"}${magnitude}`;
}

/**
 * Python's `round(value, digits)`, which is also half-to-even and also not `Math.round`.
 *
 * `norm_number` rounds to 4 decimals before formatting, `norm_thickness` and `norm_od`
 * round to 2, and `fmt_nos` rounds to a whole number — so this sits underneath the join
 * keys just as `fmtG` sits underneath the drill-down keys. A wall written `1.225` deciding
 * between `1.22` and `1.23` decides which governed thickness it folds onto, and therefore
 * which bucket the tonnage lands in.
 *
 * Rounded off the exact decimal expansion for the same reason as `fmtG`: a tie is only a
 * tie if every remaining digit is zero, which is a question about the value and not about
 * how many digits a formatter chose to show.
 */
export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return value;

  const negative = value < 0;
  const { digits: d, exponent: e } = exactDecimal(Math.abs(value));

  // `value × 10^digits` is already an integer, so there is nothing below the cut.
  const shift = e + digits;
  if (shift >= 0) return value;

  const k = -shift;
  const scale = 10n ** BigInt(k);
  const n = BigInt(d);
  const quotient = n / scale;
  const remainder = n % scale;
  const half = scale / 2n;

  let rounded = quotient;
  if (remainder > half || (remainder === half && quotient % 2n === 1n)) rounded += 1n;

  // Through a decimal string rather than arithmetic: `q / 10**digits` in floating point
  // introduces exactly the error this function exists to control, whereas parsing a
  // decimal literal is correctly rounded to the nearest double — which is what Python does.
  const result = Number(`${rounded}e${-digits}`);
  return negative ? -result : result;
}

/**
 * The exact decimal expansion of a positive finite double, as `digits × 10^exponent`.
 *
 * A double is `m × 2^e` for integers `m` and `e`. When `e >= 0` that is already an
 * integer. When `e < 0` it is `m / 2^k`, and multiplying above and below by `5^k` gives
 * `m·5^k / 10^k` — an integer over a power of ten, which is the expansion, exactly.
 */
function exactDecimal(value: number): { digits: string; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);

  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const rawMantissa = bits & 0xf_ffff_ffff_ffffn;

  // A subnormal has no implicit leading bit and a fixed exponent.
  const mantissa = rawExponent === 0 ? rawMantissa : rawMantissa | 0x10_0000_0000_0000n;
  const twoExponent = (rawExponent === 0 ? 1 : rawExponent) - 1075;

  if (twoExponent >= 0) {
    return { digits: (mantissa << BigInt(twoExponent)).toString(), exponent: 0 };
  }
  const k = -twoExponent;
  return { digits: (mantissa * 5n ** BigInt(k)).toString(), exponent: -k };
}

/**
 * Round a decimal digit string to `p` significant digits, breaking exact ties to even.
 *
 * This is the whole reason the expansion above is computed exactly: a tie is only a tie
 * if every digit past the halfway point is zero, and that is a question about the real
 * value rather than about however many digits a formatter chose to show.
 */
function roundHalfEven(
  digits: string,
  exponent: number,
  p: number,
): { digits: string; exponent: number } {
  if (digits.length <= p) return { digits, exponent };

  const drop = digits.length - p;
  const kept = BigInt(digits.slice(0, p));
  const rest = digits.slice(p);

  const roundsUp = rest[0] > "5"
    || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || kept % 2n === 1n));

  let rounded = roundsUp ? kept + 1n : kept;
  let shifted = exponent + drop;

  // `999999 + 1` is seven digits: keep `p` of them and pay for it in the exponent.
  let text = rounded.toString();
  if (text.length > p) {
    text = text.slice(0, p);
    shifted += 1;
  }
  return { digits: text, exponent: shifted };
}

/** `digits × 10^exponent` written without an exponent. */
function toFixedPoint(digits: string, exponent: number): string {
  if (exponent >= 0) return digits + "0".repeat(exponent);

  const fractionDigits = -exponent;
  if (digits.length > fractionDigits) {
    const at = digits.length - fractionDigits;
    return `${digits.slice(0, at)}.${digits.slice(at)}`;
  }
  return `0.${"0".repeat(fractionDigits - digits.length)}${digits}`;
}

/** `"5.000"` -> `"5"`, `"0.250"` -> `"0.25"`, `"5000"` -> `"5000"`. */
function stripTrailingZeros(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/\.?0+$/, "");
}
