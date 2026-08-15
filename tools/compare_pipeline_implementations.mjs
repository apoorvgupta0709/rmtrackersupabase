/**
 * Do two implementations of the pipeline build the same dashboard?
 *
 * The port replaces `refresh_dashboard.py` section by section. While that is under way
 * there are two implementations of the same arithmetic, which is exactly the arrangement
 * that drifts — and it drifts silently: one would publish a figure, the other another,
 * and both would look right on their own. So nothing switches over until this says the
 * payloads are identical.
 *
 * It is the same question `tools/compare_pipeline_backends.py` asks of two *sources*,
 * asked instead of two *implementations*, and it answers it the same way: diff every leaf
 * of the `data.json` payload by path. The comparison rules are ported deliberately rather
 * than reinvented — the incidental-key set and the relative float tolerance below are
 * that file's, and they are there because a run differs from a run in ways that are not
 * differences.
 *
 *     node tools/compare_pipeline_implementations.mjs python.json typescript.json
 *     node tools/compare_pipeline_implementations.mjs a.json b.json --only ll_tracker
 *
 * Exits non-zero if any leaf differs, and says which one.
 */

import { readFileSync } from "node:fs";

/* ---- what is not a difference --------------------------------------------- */

/**
 * Keys whose value is a fact about the run rather than about the business.
 *
 * Two runs of the same pipeline differ here by construction, so a harness that reported
 * them would never be green and would stop being read — which is the failure mode that
 * matters for a check nothing else backstops.
 */
const INCIDENTAL = new Set([
  "generated_at", "duration_seconds", "source_files", "run_url", "build_id",
  "refreshed_at_utc",
]);

/**
 * A figure that has been through JSON and back can land a bit off the double that
 * produced it, and Python and JavaScript do not print the same double the same way. A
 * difference at the fifteenth digit is not what this is for; a difference in the fourth
 * is, which is why the tolerance is relative and tight rather than a rounded epsilon.
 */
const closeEnough = (a, b) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/* ---- the diff -------------------------------------------------------------- */

const show = (value) =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const kindOf = (value) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

/** Every leaf of these two payloads that does not match, by path. */
function differences(left, right, path, labels) {
  const [leftName, rightName] = labels;

  if (kindOf(left) === "object" && kindOf(right) === "object") {
    const faults = [];
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (INCIDENTAL.has(key)) continue;
      const here = path ? `${path}.${key}` : key;
      if (!(key in left)) faults.push(`${here}: only on the ${rightName} run`);
      else if (!(key in right)) faults.push(`${here}: only on the ${leftName} run`);
      else faults.push(...differences(left[key], right[key], here, labels));
    }
    return faults;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    // Report a length mismatch and stop: pairing row 5 against row 6 turns one missing
    // row into a difference on every row after it, which buries the actual fault.
    if (left.length !== right.length) {
      return [`${path}: ${left.length} entries off the ${leftName} run, `
        + `${right.length} off the ${rightName} run`];
    }
    const faults = [];
    for (let i = 0; i < left.length; i += 1) {
      faults.push(...differences(left[i], right[i], `${path}[${i}]`, labels));
    }
    return faults;
  }

  if (typeof left === "number" && typeof right === "number") {
    return closeEnough(left, right)
      ? []
      : [`${path}: ${left} off the ${leftName} run, ${right} off the ${rightName} run`];
  }

  // A number on one side and its string on the other is the classic port fault, and
  // `!==` alone would report it as an unremarkable mismatch. Name it.
  if (kindOf(left) !== kindOf(right)) {
    return [`${path}: ${kindOf(left)} ${show(left)} off the ${leftName} run, `
      + `${kindOf(right)} ${show(right)} off the ${rightName} run`];
  }

  if (left !== right) {
    return [`${path}: ${show(left)} off the ${leftName} run, `
      + `${show(right)} off the ${rightName} run`];
  }
  return [];
}

/* ---- command line ---------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const files = argv.filter((a, i) =>
  !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

if (files.length !== 2) {
  console.error("Usage: node tools/compare_pipeline_implementations.mjs "
    + "<left.json> <right.json> [--left NAME] [--right NAME] [--only a,b] [--top N]");
  process.exit(2);
}

const labels = [flag("left", "python"), flag("right", "typescript")];
const only = (flag("only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const top = Number(flag("top", "40"));

let [left, right] = files.map((f) => JSON.parse(readFileSync(f, "utf8")));

// Limiting to the sections being ported is the normal way to run this: the port is
// section by section, so every other section differs until its turn and would drown the
// one under test.
if (only.length) {
  const pick = (payload) => Object.fromEntries(
    only.filter((k) => k in payload).map((k) => [k, payload[k]]));
  const absent = only.filter((k) => !(k in left) && !(k in right));
  if (absent.length) {
    console.error(`No such section in either payload: ${absent.join(", ")}`);
    process.exit(2);
  }
  [left, right] = [pick(left), pick(right)];
}

/* ---- report ---------------------------------------------------------------- */

const faults = differences(left, right, "", labels);

const scope = only.length ? `${only.length} section(s): ${only.join(", ")}` : "the whole payload";
console.log(`Comparing ${scope} — ${labels[0]} against ${labels[1]}.`);

if (!faults.length) {
  const sections = Object.keys(left).length;
  console.log(`No differences across ${sections} top-level key(s). `
    + `The two implementations build the same dashboard.`);
  process.exit(0);
}

// Which sections are at fault, so a run that is half-ported reads as progress rather
// than as a wall of lines.
const bySection = new Map();
for (const fault of faults) {
  const section = fault.split(/[.[:]/, 1)[0];
  bySection.set(section, (bySection.get(section) ?? 0) + 1);
}

console.error(`\n${faults.length} difference(s), in ${bySection.size} section(s):`);
for (const [section, count] of [...bySection].sort((a, b) => b[1] - a[1])) {
  console.error(`  ${String(count).padStart(6)}  ${section}`);
}

console.error("");
for (const fault of faults.slice(0, top)) console.error(`  - ${fault}`);
if (faults.length > top) {
  // Say what was dropped. A cap that stays quiet reads as "that was all of them".
  console.error(`  … and ${faults.length - top} more, not shown `
    + `(raise with --top ${faults.length}).`);
}
process.exit(1);
