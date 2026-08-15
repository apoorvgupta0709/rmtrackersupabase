/**
 * Do the ported normalisation helpers agree with the pipeline's own, value for value?
 *
 * These helpers decide which bucket a line lands in, so a disagreement does not raise
 * anything — it moves tonnage onto a different tracker row and every total still
 * reconciles. That is the class of fault this whole port has to be afraid of, and the only
 * defence that works against it is refusing to sample: the corpus below is **every
 * distinct string and number in the published build**, plus the cases the originals' own
 * comments name as having gone wrong before.
 *
 * It is the shape `test_material_codes_from_every_dump_canonicalise_to_the_same_value`
 * already uses for `material_code`, which was ported to SQL the same way and proven over
 * every dump rather than over a fixture.
 *
 *     node tools/check_normalise.mjs [path/to/data.json]
 *
 * Needs the repo's `.venv` (pandas 2.3.3), because it asks `refresh_dashboard.py` itself
 * rather than a transcription of it. Exits non-zero naming the helper and the value.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as ts from "../lib/pipeline/normalise.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = process.argv[2] ?? join(root, "data.json");
const scratch = process.env.TMPDIR ?? "/tmp";

/* ---- the corpus ------------------------------------------------------------ */

/**
 * Values the originals' comments name as having caused a defect, plus the seams.
 *
 * `"25.4-0-2.5-ERW 1-FC "` is the trailing space that put 60.304 MT on a phantom bucket;
 * `1.22` and `1.21` are the near-gauges whose absence left 85,500 pieces meeting no bucket;
 * `""` and `" "` are the empty cells that `Number()` would turn into a `0` size.
 */
const ADVERSARIAL = [
  null, "", " ", "  ", " ", "nan", "NaN", "None", "NULL", "0", 0, -0,
  "25.4-0-2.5-ERW 1-FC ", "25.4-0-2.5-ERW 1-FC", "25.4-0-2.5-ERW 1-FC",
  "25.4-0-2.5-ERW 1-FC -5.95", "25.4 - 0 - 2.5 - ERW 1 - FC - 5.95",
  1.0, 1.01, 1.02, 1.2, 1.21, 1.22, 1.5, 1.6, 1.62, 1.63, 1.9, 1.95, 2.0, 2.03,
  2.25, 2.32, 2.3, 2.34, 2.41, 2.45, 2.5, 2.6, 2.65, 2.7, 2.75, 2.8, 3.0, 3.02, 3.4, 3.5,
  22.2, 22.23, 28.58, 28.6, 37.9, 37.95, 41.28, 41.3, 19.05, 25.4, 31.75,
  "1.22", "22.20", " 41.30 ", "0x10", "1e3", "  5  ", "+2.5", ".5", "5.", "abc",
  "inf", "-inf", "Infinity",
  "CHECK TDC FOR GRADE", "NO KEY", "check", "nan-0.46",
  "3768904", "3768904.0", "0036388067", "DP 0036388067", 3768904, 3768904.0,
  "MS TUBE 25.4X1.6X6000", "SQ TUBE 40X40X2X6000", "TUBE 19.05X2X5840",
  "AW", "AP", "HR", "AN", "BH", "NR", "PE", "BE", "aw", " an ",
  "Megh-25.4-0-1.6", "572.5", 572.5, 5.95, 6.0, 5840, 5841.0,
  "Q4 FY26", "Q1 FY27",
];

/** Every distinct string and number in the published build. */
function harvest(node, strings, numbers, seen = new Set()) {
  if (typeof node === "string") strings.add(node);
  else if (typeof node === "number" && Number.isFinite(node)) numbers.add(node);
  else if (Array.isArray(node)) for (const v of node) harvest(v, strings, numbers, seen);
  else if (node && typeof node === "object") {
    if (seen.has(node)) return;
    seen.add(node);
    for (const k of Object.keys(node)) strings.add(k);
    for (const v of Object.values(node)) harvest(v, strings, numbers, seen);
  }
}

const strings = new Set();
const numbers = new Set();
let fromBuild = 0;
try {
  harvest(JSON.parse(readFileSync(dataPath, "utf8")), strings, numbers);
  fromBuild = strings.size + numbers.size;
} catch (error) {
  console.log(`No build read at ${dataPath} (${error.code ?? error.message}); `
    + "checking the adversarial cases only.");
}

const corpus = [...new Set([...ADVERSARIAL, ...strings, ...numbers])];

/* ---- what to compare ------------------------------------------------------- */

/** TypeScript name -> the pipeline's own name. One argument each, over the whole corpus. */
const UNARY = {
  normCode: "norm_code",
  normText: "norm_text",
  normDesc: "norm_desc",
  normNumber: "norm_number",
  normThickness: "norm_thickness",
  normOd: "norm_od",
  normSurface: "norm_surface",
  normBucket: "norm_bucket",
  validBucket: "valid_bucket",
  normLengthKey: "norm_length_key",
  keyFamily: "key_family",
  blankToNone: "blank_to_none",
  naturalBucketKey: "natural_bucket_key",
  descriptionShape: "description_shape",
  splitCodes: "split_codes",
  fmtNos: "fmt_nos",
};

// Pairs, sampled rather than crossed: the full product of the build's strings against its
// numbers is tens of millions of calls for no extra coverage.
const bucketish = corpus.filter((v) => typeof v === "string").slice(0, 400);
const lengthish = corpus.filter((v) => typeof v === "number").slice(0, 200)
  .concat([null, "", "5.95", 6.0, 572.5, 3.5, 3.49]);
const pairs = [];
for (const bucket of bucketish) {
  for (const length of lengthish.slice(0, 24)) pairs.push([bucket, length]);
}
for (const [i, bucket] of bucketish.entries()) pairs.push([bucket, lengthish[i % lengthish.length]]);

const BINARY = {
  makeCtlBucket: "make_ctl_bucket",
  bucketVsmKey: "bucket_vsm_key",
  shapeMatchesBucket: "shape_matches_bucket",
};

/* ---- ask the pipeline ------------------------------------------------------ */

const request = { corpus, pairs, unary: Object.values(UNARY), binary: Object.values(BINARY) };
const requestPath = join(scratch, "normalise-request.json");
writeFileSync(requestPath, JSON.stringify(request));

const script = `
import importlib.util, json, math, sys
from pathlib import Path

root = Path(${JSON.stringify(root)})
spec = importlib.util.spec_from_file_location(
    "refresh_dashboard",
    root / ".claude/skills/refresh-tvsm-dashboard/scripts/refresh_dashboard.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)

payload = json.loads(Path(${JSON.stringify(requestPath)}).read_text())

def safe(value):
    """Tuples become lists, and a NaN that escapes becomes None, so JSON can carry it."""
    if isinstance(value, tuple):
        return [safe(v) for v in value]
    if isinstance(value, list):
        return [safe(v) for v in value]
    if isinstance(value, float) and math.isnan(value):
        return None
    return value

def attempt(fn, *args):
    """Record what the pipeline raises rather than dying with it.

    Not defensive plumbing: \`fmt_nos("inf")\` raises OverflowError, because \`float("inf")\`
    succeeds and \`round()\` then refuses, and the helper only catches TypeError and
    ValueError. That is a real latent defect and the harness's job is to report it, not to
    stop at it.
    """
    try:
        return safe(fn(*args))
    except Exception as error:
        return {"__raised__": type(error).__name__}

out = {"unary": {}, "binary": {}}
for name in payload["unary"]:
    fn = getattr(pipeline, name)
    out["unary"][name] = [attempt(fn, v) for v in payload["corpus"]]
for name in payload["binary"]:
    fn = getattr(pipeline, name)
    out["binary"][name] = [attempt(fn, a, b) for a, b in payload["pairs"]]

json.dump(out, sys.stdout)
`;

const python = join(root, ".venv/bin/python");
const expected = JSON.parse(execFileSync(python, ["-c", script], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
}));

/* ---- compare --------------------------------------------------------------- */

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const raised = (value) => value && typeof value === "object" && "__raised__" in value;

const faults = [];
const raises = [];
let compared = 0;

const check = (label, ours, theirs) => {
  compared += 1;
  // Where the pipeline raises, the port returning a value is not a disagreement about the
  // answer — there is no answer to disagree with. Collected and reported separately.
  if (raised(theirs)) {
    raises.push(`${label}: pipeline raises ${theirs.__raised__}, `
      + `ported returns ${JSON.stringify(ours)}`);
    return;
  }
  if (!same(ours, theirs)) {
    faults.push(`${label}: pipeline ${JSON.stringify(theirs)}, `
      + `ported ${JSON.stringify(ours)}`);
  }
};

for (const [tsName, pyName] of Object.entries(UNARY)) {
  corpus.forEach((value, i) => {
    check(`${tsName}(${JSON.stringify(value)})`, ts[tsName](value), expected.unary[pyName][i]);
  });
}

for (const [tsName, pyName] of Object.entries(BINARY)) {
  pairs.forEach(([a, b], i) => {
    check(`${tsName}(${JSON.stringify(a)}, ${JSON.stringify(b)})`,
      ts[tsName](a, b), expected.binary[pyName][i]);
  });
}

console.log(`${Object.keys(UNARY).length + Object.keys(BINARY).length} helpers, `
  + `${compared.toLocaleString("en-US")} comparisons — ${corpus.length} corpus values `
  + `(${ADVERSARIAL.length} adversarial, ${fromBuild} from `
  + `${dataPath.split("/").pop()}) and ${pairs.length} pairs.`);

if (raises.length) {
  // Worth saying out loud even on a green run: an input the pipeline cannot survive is a
  // latent defect in it, and the port having an answer is not the same as the two agreeing.
  console.log(`\n${raises.length} input(s) the pipeline raises on, where the port returns:`);
  for (const note of raises.slice(0, 10)) console.log(`  - ${note}`);
  if (raises.length > 10) console.log(`  … and ${raises.length - 10} more.`);
}

if (faults.length) {
  // Group, so one broken helper reads as one problem rather than as ten thousand.
  const byHelper = new Map();
  for (const fault of faults) {
    const helper = fault.slice(0, fault.indexOf("("));
    byHelper.set(helper, (byHelper.get(helper) ?? 0) + 1);
  }
  console.error(`\n${faults.length} disagreement(s), in ${byHelper.size} helper(s):`);
  for (const [helper, count] of [...byHelper].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(count).padStart(7)}  ${helper}`);
  }
  console.error("");
  for (const fault of faults.slice(0, 30)) console.error(`  - ${fault}`);
  if (faults.length > 30) {
    console.error(`  … and ${faults.length - 30} more, not shown.`);
  }
  process.exit(1);
}
console.log("Every ported helper answers exactly as the pipeline's own does.");
