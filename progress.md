# Porting the refresh pipeline to TypeScript — progress

Working notes for the port of `refresh_dashboard.py` to TypeScript, so the business logic
lives in the Next.js app and `.github/workflows/refresh.yml` can be deleted.

**Read `.claude/context/memory.md` first** for the project itself. This file only covers the
port. The plan it executes is at `~/.claude/plans/how-is-the-upload-witty-moore.md`.

_Last updated: 2026-08-15, after S2._

---

## Why

The upload tab already writes straight to Supabase — the browser parses the workbook,
inserts `raw_batches`/`raw_rows`, calls `promote_upload`. GitHub is not involved. The Action
exists only to run the *derived* build, and it is Python purely by accident of history: the
pandas pipeline was the product first (`c406157`, 9 Aug), the Next.js app wrapped its output
a day later (`6eada6b`), and the Action followed the same day (`8c2e439`).

It ports because it is not pandas-shaped. In `refresh_dashboard.py`: `.merge()` × 1;
`merge_asof`, `rolling`, `pivot`, `np.select`, `groupby.apply` × 0; `groupby()` × 86;
`iterrows`/`itertuples` × 56; plain `for` × 179; `np.*` × 7, all `np.where` and NaN cleanup.
pandas is an Excel reader and a `GROUP BY` engine.

**Sized at 14–18 weeks.** `main()` is one ~5,500-line function; the surface is 29 payload
keys, 30 sections, 34 drill-down prefixes.

### What this port does NOT change

Two questions must not be conflated. **What language the logic is in** — that is this work.
**When the numbers are computed** — batch, into an immutable published build. *That stays.*

Computing live per page load would lose four properties with recorded saves behind them:
refusal (a FAIL leaves yesterday's dashboard standing — it already caught a 998-of-1,750-row
silent truncation); honest `as_of` (it feeds ageing arithmetic and is an operator assertion
that today's dumps arrived — `refresh.yml:3-6` calls this "the one failure this whole rebuild
exists to stop"); atomic cross-tab consistency via `current_build_id()`; and section-level RLS.

---

## State

| Phase | Status |
|---|---|
| 0 — parity harness | **done** |
| 0 — migration drift | **done** (false alarm; see below) |
| 1 — absorption into SQL | **not started** |
| 2 — helpers + config | **done** |
| 3 — sections | **3 of 17** (S1, S2, S10) |
| 4–6 — QC gate, cutover, retire Python | not started |

### Ported and proven

| File | What | Proven by |
|---|---|---|
| `lib/pipeline/format.ts` | `fmtG` (Python `%g`), `pyRound` (Python `round`) | 28,583 values vs CPython, at 3 precisions |
| `lib/pipeline/normalise.ts` | 20 helpers, config tables, UTC date helpers | 647,491 comparisons vs the pipeline's own functions |
| `lib/pipeline/source.ts` | `readSlot`, `readSalesLedger` | used by the section checks |
| `lib/pipeline/sections/material.ts` | **S1** governed material dimension | 300,023 keys across 9 maps |
| `lib/pipeline/sections/sales.ts` | **S2** sales mapping | 2,063 keys across 7 lookups |
| `lib/pipeline/sections/overdue.ts` | **S10** overdue analysis | payload section + 38 drill-downs |

### Changes made to the Python

All verified payload-neutral except the one intended ordering change.

- `kind="mergesort"` on both sorts in S10 — the default `quicksort` is not stable, so the
  drill-down order for tied rows was decided by the sort's internals. *This one moved 137
  rows, intentionally.*
- `OverflowError` added to `fmt_nos`'s guard — an infinity passes `float()` and is refused
  by `round()`.
- `try/except` around `float(length_m)` in `make_ctl_bucket` — it returned `None` for an
  absent length but raised for an unreadable one.
- `_plain()` module-level helper, plus two **env-gated** dumps (`DUMP_MATERIAL_DIMENSION`,
  `DUMP_SALES_MAPS`) that write internal maps for the parity checks. Never on the build's path.

---

## How to run everything

```bash
# The repo's own venv already has the pinned pandas 2.3.3 / numpy 2.5.2.
./.venv/bin/python -m pytest -q .claude/skills/refresh-tvsm-dashboard/tests   # 91 tests
npx tsc --noEmit

# Regenerate the oracles. ~95s. Read-only in practice: all sales slots are already
# absorbed, so `absorb_sales()` is a no-op. Verify that first if unsure:
#   select slot,status,absorbed_at is null from raw_batches ...
SC=/tmp/port
mkdir -p $SC
DUMP_MATERIAL_DIMENSION=$SC/dim.json DUMP_SALES_MAPS=$SC/sales.json \
  ./.venv/bin/python .claude/skills/refresh-tvsm-dashboard/scripts/refresh_from_supabase.py \
    --as-of 2026-08-14 --dry-run
# It prints the temp dir it left data.json in; copy that to $SC/oracle.json.

# The checks. All exit non-zero on any disagreement.
node tools/check_format_g.mjs                                  # no oracle needed
node tools/check_normalise.mjs                                 # needs .venv
node tools/check_section_material.mjs $SC/dim.json
node tools/check_section_sales.mjs    $SC/sales.json $SC/dim.json
node tools/check_section_overdue.mjs  $SC/oracle.json --as-of 2026-08-14

# Diff two whole payloads (used to prove a pipeline change moved nothing else).
node tools/compare_pipeline_implementations.mjs a.json b.json --only ll_tracker --top 40

# Pre-existing harnesses that must stay green.
node tools/check_pricing_formula.mjs
node tools/check_detail_keys.mjs
node tools/check_upload_columns.mjs
```

**The oracle must be fresh.** The committed `data.json` is the frozen 7 August build; the
dumps have moved since, so diffing against it reports the calendar as a defect.

---

## The traps — read this before porting anything

Eight silent faults in four sections. **None threw an exception. All would have shipped as
wrong numbers that reconciled.** Assume the next one is there too.

1. **Python rounds half to even; JavaScript rounds half away from zero** — in *both*
   `round()` and `%g`. So `toFixed`, `toPrecision` and `Math.round` cannot be used anywhere
   a key or a governed gauge is decided. `2814.125` → `2814.12` vs `2814.13`; a wall written
   `1.225` picks a different `THICKNESS_GROUPS` fold, i.e. a different bucket. Use `fmtG`
   and `pyRound`, which work off the exact decimal expansion in BigInt.
2. **The two languages switch to exponential notation at different magnitudes** — Python
   outside a decimal exponent of `[-4, 16)`, JavaScript outside `(-7, 21)`. Nine helpers are
   `str()` followed by a regex, so this alone moved twenty answers. Use `pyStr`.
3. **`0` is falsy in Python and `NaN` is truthy** — `str(key or "")` makes `key_family(0)`
   null; `if not bucket` lets a NaN through, which is how `"nan-0.46"` was built. Neither is
   true in JavaScript. `pyOr` and `isNa` exist for this.
4. **`Number("")` is `0` where `float("")` raises** — an empty cell would normalise to the
   size `"0"`. Use `pyFloat`/`toNumber`, which validate the literal rather than coercing.
5. **`sort_values` defaults to `kind="quicksort"`, which is not stable.** Any "first match"
   or tied sort is therefore arbitrary in the original. Check whether the differences are
   *only* ties before assuming your port is wrong — and prefer fixing the Python to be
   stable, since its order was never a decision.
6. **Accumulating tables key `row` jsonb by the sheet's header; `raw_rows` holds a
   positional array.** Reading one as the other does not error — it maps every column to
   null. That produced 174 OEM rows with no OEM on any of them.
7. **Read order is load-bearing, not paging hygiene.** `zmat` reads by `source_seq` because
   the pipeline deduplicates again with `keep="first"`, so "first" must mean the sheet's
   first. See `READ_ORDER` in `source.ts` — it mirrors `sources.TABLES`.
8. **`Date.parse` reads a bare date as UTC but a bare date-*time* as LOCAL.** The ledger
   stores `2026-08-01T00:00:00` for all 22,642 lines, so east of Greenwich an invoice billed
   at midnight on the 1st lands in the previous month — 76 August lines vanished and every
   derived figure was quietly light. pandas converts nothing. Use `toUtcMillis`/`toUtcDay`/
   `toUtcMonth`, never `Date.parse` directly. The VPS container must also run `TZ=UTC`.

Also standing: **`groupby` sorts its keys** and `dropna=False` puts the null group last, so
insertion order silently reorders every section (`build_sections.seq` is a sort position).
`sortedGroupKeys` in `overdue.ts` is the pattern.

---

## The recipe for the next section

This is now repeatable; four sections in, it has not needed changing.

1. **Read the Python block.** Section boundaries are numbered comments (table below).
2. **Check its dependencies** — `grep` the range for `material_bucket`, `description_bucket`,
   `material_length`, `oem_map`, `sales`, `schedule_lines`.
3. **Get an oracle.** If it is a payload section, the fresh `data.json` is the oracle. If it
   is an intermediate, add an env-gated `DUMP_*` block beside the existing two and use
   `_plain()`; tuple keys join with `|`.
4. **Port it pure** — inputs in, result out, no network — into `lib/pipeline/sections/`.
5. **Write `tools/check_section_<name>.mjs`.** Enumerate every key; do not sample.
   **Compare counts before values** — that is what turned 28 wrong sums into one timezone bug.
6. **Iterate to zero differences**, then run the whole suite, then commit.

---

## Section map and what is left

Line numbers are current as of 2026-08-15 (`refresh_dashboard.py` is 6,788 lines).

| # | Section | Line | Depends on | Status |
|---|---|---|---|---|
| 1 | Governed material dimension | 1361 | — | **done** |
| 2 | Map sales | 1513 | S1 | **done** |
| 3 | Schedule-line facts + SO join | 1670 | S1, S2 | next |
| 4 | Map current stock (+ RFD 4731 write-off at 1985) | 1771 | S1 | |
| 5 | WIP / ystockn | 2102 | S1 | |
| 6 | TVSM LL tracker | 2246 | S1, S4, S5 | |
| 7 | Sales summary | 2409 | S2 | |
| 8 | Missing mappings queues | 2459 | S1–S5 | |
| 9 | Stock analysis | 2639 | S1, S4 | |
| 10 | Overdue analysis | 2990 | — | **done** |
| 11 | Megh SKU tracker | 3128 | S1, S2, S4 | largest block, 796 lines |
| 12 | Inter-plant transfers | 3924 | S1 | |
| 13 | STR plan (Hosur 8406) | 4122 | S1, S4, S12 | allocation waterfall at ~4345 |
| 14 | SKU pricing | 4542 | S1, S3 | **`pricing.ts` already ports the formula** |
| 15 | Code repository | 5332 | S1, S2 | |
| 16 | Order book (+ sign-off at 5171) | 4849 | S1 | |
| 17 | Past sales trend | 5432 | S2 | dynamic month columns |

**`overdue_analysis` was the only section standing free of the material dimension.** Every
other one joins through S1 and/or S2, which is why those two came first.

Per the plan, S3–S6 and S9 share intermediates and should move as **one or two batches, not
five independent ports**. All four hard QC floors go live with them, so that is the phase
that will overrun.

### The five algorithms that need real thought

1. **Megh BOP nearest-length global assignment** (~3410) — mutual-exclusion greedy match,
   candidates sorted by gap *globally*, each side claimed once. Per-row nearest is wrong and
   the comment says why (19.05 × 2.0 listed at both 5840 and 6000). **Keep it imperative.**
2. **STR allocation waterfall** (~4345) — drain a requirement across source plants
   largest-first. Maps to a running `SUM() OVER (ORDER BY qty DESC)`, minding the
   `outstanding > 0` gate.
3. **Contract price 4-stage narrowing** (~4597) — the `filtered or candidates` idiom.
   Becomes preference scoring with `ORDER BY CASE`, *not* filtering. The `via` string is
   displayed and must be reproduced.
4. **Sales-order 4-level cascade** (~2567) — `customer_codes` is an *ordered* list and the
   order is the specificity. Unnest `WITH ORDINALITY`; joining on a single code loses it.
   This is the Balaji Press Product failure mode.
5. **RFD 4731 write-off set difference** (1985) — `unnest(string_to_array(ctl_code, '|'))`
   and an `EXCEPT`.

---

## Architecture decisions already taken

- **Where it will run:** in-process in `/api/refresh`, single-flight on a `refresh_runs`
  claim row — **not** `pg_try_advisory_lock`, because PostgREST pools connections and a
  session lock can outlive its request. Stronger than the Action's `concurrency:` group,
  which never covered a hand-run.
- **~60s Supabase HTTP gateway ceiling.** `service_role` has no `statement_timeout`, so the
  database will not kill a long RPC — the gateway will. **No single RPC may be the whole
  run**; one per section, each well under 10s.
- **Storage is the tightest constraint: 410 MB of the free plan's 500 MB.** `detail_rows`
  152 MB, `tsl_sales` 101 MB for 22,419 rows (4.6 KB each — the whole line as `row` jsonb),
  `raw_rows` 67 MB. A build is ~28,000 rows and ~22 MB, so **the harness must never write
  shadow builds**; it diffs payloads as files and keeps nothing. Promoting the ~15 columns
  the pipeline actually reads out of `tsl_sales.row` into typed columns would return
  60–70 MB.
- **Make FAIL-doesn't-publish unfalsifiable** when porting the gate (Phase 4): a
  `check (published_at is null or status <> 'FAIL')` constraint plus a `publish_build()`
  SECURITY DEFINER RPC granted to `service_role` only. Stronger than the current Python `if`.

### Migration drift — resolved, do not re-open

Production carries 45 stamps against the repo's 20, but **the ledger differs, not the
schema.** Verified 15 Aug: all 13 snapshot views match on column count and on every late
type fix; all 14 functions, 21 tables, 25 indexes and 41 policies exist and are each created
by some repo file. A stamp missing from `list_migrations` does not imply a missing object —
check the object.

Going forward: apply with the MCP `apply_migration`, then commit the repo file under the
**same** stamp the tool assigned. **Never run `supabase db push`** — most repo files are not
idempotent and a replay would fail partway. `SUPABASE_DB_URL` in `.env.local` has a stale
password so `psql` fails; nothing here needs it.

---

## Housekeeping

- **Every push to `main` deploys twice** — Vercel and the VPS container. Confirm both:
  `gh run list --workflow=deploy.yml` and `vercel ls --scope apoorvgupta0709s-projects`.
- Anything touching `next.config.ts`, the `Dockerfile` or `.github/workflows/` needs both
  checked especially — `output: "standalone"` suits the container and fails Vercel on the
  last line of an otherwise green build.
- `.claude/**` and `**/*.md` are `paths-ignore`d by the deploy workflow, so pipeline-only and
  docs-only commits do not trigger a VPS build.

## Still open

- **Phase 1 (absorption into SQL) is unstarted and independently worthwhile.** It removes the
  ~1 min/batch worst case that justified the Action's 30-minute timeout. Strong proof
  available: 53 batches are already absorbed by Python, so the SQL version can be replayed
  against every one and checked row-for-row with no shadow period.
- The uploader still requires a **manual second click** and never reports the outcome —
  `/api/refresh` fires and prints a static "takes about a minute"; nothing polls. Fixing that
  is ~a day and is independent of the port.
- `sheet_total_rows` and the data tables (`MEGH_BOP_ITEMS`, `PRICING_SHEETS`, the 14
  `*_DETAIL_COLUMNS` layouts) are deliberately deferred to the sections that use them, where
  their behaviour can be checked against real output.
