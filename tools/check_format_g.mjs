/**
 * Does `fmtG` write a float exactly as Python's `%g` does?
 *
 * The drill-down keys are pipe-joined formatted floats, so a formatter that disagrees by
 * one character produces a key that matches nothing — a breakup that opens empty, with no
 * error and nothing to reconcile it against. This is the check that stops that, and it is
 * deliberately not a spot-check: it asks CPython itself, over the adversarial cases *and*
 * over every number that actually appears in the published build.
 *
 *     node tools/check_format_g.mjs [path/to/data.json]
 *
 * Exits non-zero, naming the value, if the two ever disagree.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fmtG, pyRound } from "../lib/pipeline/format.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = process.argv[2] ?? join(root, "data.json");

/* ---- the values to try ----------------------------------------------------- */

/**
 * Cases chosen to sit on the rule's seams rather than in the middle of it: the fixed
 * versus exponential boundary at both ends, a rounding carry that moves the exponent and
 * so moves the branch, and the trailing-zero strip.
 */
const ADVERSARIAL = [
  0, 1, -1, 0.5, -0.5, 2.5, 5000, 5000.0, 189, 189.0,
  // the fixed/exponential seam: -4 <= X < 6
  1e-5, 9.9e-5, 1e-4, 0.0001234567, 99999.9, 999999, 999999.4, 1000000, 1234567, 1e21,
  // rounding that carries into a new exponent
  999.9, 9999995, 0.99999995, 9.999999e-5,
  // trailing zeros, and the halfway cases where Python rounds half to even
  0.250, 1.50, 2.675, 0.125, 0.135, 1.005,
  // the real shapes: diameters, walls, lengths in mm
  19.05, 25.4, 31.75, 1.6, 2.0, 1.21, 1.22, 878, 5840, 6000, 5841.0, 5.84,
  -0.0, 1 / 3, 2 / 3, Math.PI, 1e-320, Number.MAX_SAFE_INTEGER,
];

/**
 * A seeded fuzz, because the adversarial list only covers the seams somebody thought of.
 *
 * Seeded rather than random so a failure is reproducible and CI cannot go green by luck.
 * The three families are deliberate: doubles spread across forty orders of magnitude, then
 * dyadic rationals (`n/8`, `n/16`, …) which are the values that produce *exact* halfway
 * cases and so are the only ones that can catch a half-up rounder, then plain integers.
 */
function fuzzValues(count = 10000) {
  let seed = 0x9e3779b9;
  const next = () => {
    // Lehmer / Park-Miller: small, and its sequence does not depend on the platform.
    seed = (seed * 48271) % 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out = [];
  for (let i = 0; i < count * 0.4; i += 1) {
    out.push((next() * 2 - 1) * 10 ** (Math.floor(next() * 40) - 20));
  }
  for (let i = 0; i < count * 0.4; i += 1) {
    const denominator = [2, 4, 8, 16, 32][Math.floor(next() * 5)];
    out.push(Math.trunc((next() * 2 - 1) * 1e7) / denominator);
  }
  for (let i = 0; i < count * 0.2; i += 1) out.push(Math.floor(next() * 1e9));
  return out;
}

/** Every number anywhere in the published build — this is what actually gets formatted. */
function harvest(node, into, seen = new Set()) {
  if (typeof node === "number" && Number.isFinite(node)) into.add(node);
  else if (Array.isArray(node)) for (const v of node) harvest(v, into, seen);
  else if (node && typeof node === "object") {
    if (seen.has(node)) return;
    seen.add(node);
    for (const v of Object.values(node)) harvest(v, into, seen);
  }
}

const fuzz = fuzzValues();
const values = new Set([...ADVERSARIAL, ...fuzz]);
let fromBuild = 0;
try {
  const build = new Set();
  harvest(JSON.parse(readFileSync(dataPath, "utf8")), build);
  fromBuild = build.size;
  for (const v of build) values.add(v);
} catch (error) {
  // A missing build is not a reason to skip the adversarial set, but say so rather than
  // reporting a pass that covered a fraction of what it claims to.
  console.log(`No build read at ${dataPath} (${error.code ?? error.message}); `
    + `checking the adversarial and fuzz cases only.`);
}

const list = [...values];

/* ---- ask CPython ----------------------------------------------------------- */

// Through JSON in both directions: a double written by `JSON.stringify` and read by
// `json.loads` is the same double, which a decimal string typed into the script would not
// reliably be.
const expected = JSON.parse(execFileSync("python3", ["-c", `
import json, sys
values = json.load(sys.stdin)
json.dump([format(v, "g") for v in values], sys.stdout)
`], { input: JSON.stringify(list), encoding: "utf8" }));

/* ---- compare --------------------------------------------------------------- */

const faults = [];
const faultsRound = [];
for (const [i, value] of list.entries()) {
  const ours = fmtG(value);
  if (ours !== expected[i]) {
    faults.push(`${JSON.stringify(value)}: python "${expected[i]}", fmtG "${ours}"`);
  }
}

// The three CPython prints but JSON cannot carry, so they never reach the list above.
for (const [value, want] of [[NaN, "nan"], [Infinity, "inf"], [-Infinity, "-inf"]]) {
  const ours = fmtG(value);
  if (ours !== want) faults.push(`${value}: python "${want}", fmtG "${ours}"`);
}

/* ---- and `pyRound`, which sits under the join keys the same way ------------ */

// `norm_number` rounds to 4 before formatting, `norm_thickness` and `norm_od` to 2,
// `fmt_nos` to 0 — so the same half-to-even question decides which governed gauge a wall
// folds onto. Checked at every precision the pipeline actually uses.
const roundExpected = JSON.parse(execFileSync("python3", ["-c", `
import json, sys
values, digits = json.load(sys.stdin)
json.dump([[repr(round(v, d)) for v in values] for d in digits], sys.stdout)
`], { input: JSON.stringify([list, [0, 2, 4]]), encoding: "utf8" }));

for (const [d, digits] of [0, 2, 4].entries()) {
  list.forEach((value, i) => {
    // Compared through Python's own `repr`, so the comparison cannot be lost in a second
    // round of formatting.
    const ours = pyRound(value, digits);
    const theirs = roundExpected[d][i];
    const oursRepr = Number.isInteger(ours) && digits === 0 ? String(ours) : String(ours);
    if (Number(theirs) !== Number(oursRepr)) {
      faultsRound.push(`round(${value}, ${digits}): python ${theirs}, pyRound ${oursRepr}`);
    }
  });
}

console.log(`${list.length} distinct values checked — ${ADVERSARIAL.length} adversarial, `
  + `${fuzz.length} seeded fuzz, ${fromBuild} harvested from `
  + `${dataPath.split("/").pop()} — plus nan, inf and -inf.`);
console.log(`pyRound checked at 0, 2 and 4 decimals over the same ${list.length} values.`);

if (faultsRound.length) {
  console.error(`\n${faultsRound.length} pyRound disagreement(s) with Python:`);
  for (const fault of faultsRound.slice(0, 20)) console.error(`  - ${fault}`);
  if (faultsRound.length > 20) {
    console.error(`  … and ${faultsRound.length - 20} more, not shown.`);
  }
  process.exit(1);
}

if (faults.length) {
  console.error(`\n${faults.length} disagreement(s) with Python:`);
  for (const fault of faults.slice(0, 40)) console.error(`  - ${fault}`);
  if (faults.length > 40) console.error(`  … and ${faults.length - 40} more, not shown.`);
  process.exit(1);
}
console.log("fmtG writes every one of them exactly as Python's %g does.");
