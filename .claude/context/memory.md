# Session memory

Working memory for the TVSM operations dashboard. Read at session start; update and
push whenever a session produces a durable fact. Keep entries true — prune what
expires rather than appending forever.

**Nothing secret goes in this file.** It is no longer literally fetchable — the old
static site served the repository, the Next.js app serves only what it builds, and
`/.claude/` is excluded from both the Vercel upload and the container image. But that
is now three ignore rules deep, one anchored pattern away from being wrong, and the
repo is served by two public deployments. The rule stands on that, not on the file
being reachable today.

_Last updated: 2026-08-14 (the refresh reads the dump tables now, not the stored cell grid —
which moved the transfer figures and nothing else, after retyping sixteen view columns that
were unpadding SAP codes and rekeying zmat on the row rather than the code and plant)._

## What this is

An operations dashboard for Tata Steel Tubes' TVSM business, built daily from mailed
Excel dumps and read behind a login. The repo is `apoorvgupta0709/rmtrackersupabase`.
Eleven tabs plus an Admin tab; the full list and every business rule are in `SKILL.md`
— do not restate them here.

**It is no longer a static site, and the difference matters in three places.** A refresh
writes a *build* into Supabase rather than a file into the repo; the page reads that
build through the reader's own client so RLS decides what they see; and `index.html`,
`data.json` and `access.json` at the repo root are the **old** dashboard's artefacts,
superseded and deliberately served by nothing. Anything phrased as "publish `index.html`"
or "reproduce `data.json`" is describing the model before 10 August.

The pipeline is still `scripts/refresh_dashboard.py` and does all the work; the GitHub
Action's entry point is `scripts/refresh_from_supabase.py`, which only hands it a
different source of frames and a different place to put the answer.

**A port of that pipeline to TypeScript began 15 Aug**, so that the logic lives in the
app and the Action can be deleted. Python stays authoritative until a section's parity is
proven; nothing switches over on faith. **State, the eight traps found so far, the recipe
for the next section and every check command are in `progress.md` at the repo root — read
that before touching the port.** Plan at
`~/.claude/plans/how-is-the-upload-witty-moore.md`. Sized at **14–18 weeks** — `main()` is
one ~5,500-line function and the surface is 29 payload keys, 30 sections and 34 drill-down
prefixes. Why it is portable at all: the pipeline is *not* pandas-shaped — one `.merge()`,
no `merge_asof`/`rolling`/`pivot`, 56 row loops, and the seven `np.*` uses are `np.where`
and NaN cleanup. pandas is an Excel reader and a `GROUP BY` engine.

- **Done so far:** `tools/compare_pipeline_implementations.mjs` (payload differ, ported
  from `compare_pipeline_backends.py`'s rules), `lib/pipeline/format.ts` (`fmtG`,
  `pyRound`) and `lib/pipeline/normalise.ts` (19 helpers), each with a check that asks
  CPython rather than a transcription — `tools/check_format_g.mjs`,
  `tools/check_normalise.mjs`. The repo's `.venv` already holds the pinned pandas 2.3.3.
- **Python rounds half to even and JavaScript rounds half away from zero**, in *both*
  `round()` and `%g`. `toFixed`/`toPrecision`/`Math.round` therefore cannot be used
  anywhere a key or a governed gauge is decided: `2814.125` formats as `2814.12` against
  `2814.13`, and a wall written 1.225 picks a different `THICKNESS_GROUPS` fold. Both are
  now computed off the exact decimal expansion in BigInt.
- **The two languages switch to exponential notation at different magnitudes** — Python
  outside a decimal exponent of `[-4, 16)`, JavaScript outside `(-7, 21)`. Nine helpers are
  `str()` followed by a regex, so this alone moved twenty answers. `pyStr` handles it. The
  seam that *cannot* be closed: Python distinguishes `int` from `float`, so `str(5.0)` is
  `"5.0"` where JavaScript writes `"5"`; a column pandas typed float against one a snapshot
  view typed `text` can disagree with neither side wrong.
- **`0` is falsy in Python and `NaN` is truthy** — `str(key or "")` makes `key_family(0)`
  None, and `if not bucket` lets a NaN through, which is how `"nan-0.46"` was built.
  `Number("")` is `0` where `float("")` raises, so float literals are validated, not coerced.
- **Two latent defects in the pipeline, found by the harness and not reproduced:**
  `fmt_nos` of an infinity raises OverflowError (`float("inf")` succeeds, `round()` refuses,
  and only TypeError/ValueError are caught), and `make_ctl_bucket` calls `float(length_m)`
  unguarded. Neither is reachable from a current dump; both would be worth fixing in place.
- **The database is at 410 MB of the free plan's 500 MB** — `detail_rows` 152 MB,
  `tsl_sales` 101 MB for 22,419 rows (4.6 KB each, the whole line kept as `row jsonb`),
  `raw_rows` 67 MB. A build is ~28,000 rows and ~22 MB, so **the parity harness must never
  write shadow builds**; it diffs payloads in memory. Promoting the ~15 columns the
  pipeline reads out of `tsl_sales.row` into typed columns would return 60–70 MB.
- **Concurrency for the ported trigger is a `refresh_runs` claim row, not an advisory
  lock** — PostgREST pools connections, so a session lock can outlive its request. And the
  Supabase HTTP gateway cuts a request at ~60s (`service_role` itself has no
  `statement_timeout`), so no single RPC may be the whole run.

The daily pack now includes `orders.xlsx`, the sales-planning order book (sheets
`jsr`, `hk_so`, `hk_str`). It feeds the **Order logged** column on the long-length
tracker and **Orders logged as per sales planning** on the Megh tab, beside the
`vsm stock` plan's OMS figure. Optional, like the other planning files. **Lines marked
`c` in each sheet's remarks column are not live demand** and pool into neither tracker —
59% of the 31 July book. Both figures are published side by side so a smaller order
column reads as the filter working, not as demand collapsing.
**`zmat.xlsx` is the only material master.** A mapping extract is merged into it with
`scripts/merge_material_mapping.py`, then the extract is discarded and never stored.
Two traps, both documented in §5e.4: filter on unseen *descriptions* not codes, and
align columns by *name* not position — the files order their columns differently, so a
positional rename transposes the whole file. After merging, copy over
`assets/masters/zmat.xlsx` and update `config/master_manifest.json`.

A value looked up and not resolved reads **`lookup error`**, on the page and in the
exports — never a blank. On these queues the empty cells are the work.

Every bucket is put through `norm_bucket` as it enters from a sheet — a trailing space
makes it a different string that renders identically, so it splits into its own row and
its own pool. Found when the TVSM sheet wrote `25.4-0-2.5-ERW 1-FC ` and 60.304 MT of
sales landed on a phantom row. Headline cards sum the sheet's columns, not the buckets,
so nothing reconciled it — worth remembering when a figure looks doubled or halved.

The **Past sales trend** tab reads the archived sales dumps (Sheet1 only — the other
sheets duplicate it) beside the daily dump, through the one `derive_sales` function.
Two parties, never merged: ancillaries where the OEM key says TVS, and Megh under
943209, matched on the code because the OEM key calls it Direct.

**August is live.** `aug0826 rm tracker v1.xlsx` is the approved master (canonical slot
name stays `july0626_rm_tracker_v1.xlsx`), and **its schedule sheet is still called
`Schedule July` while holding August demand** — the sheet name is a slot, not a month.
`SCHEDULE_MONTH` declares the month and is now 8; set it whenever a new workbook lands.
The mismatch banner keys off it and is silent while they agree.

**Customer schedules reach the workbook, not the pipeline.** In August the owner's first
workbook carried 8 of 18 customers and I built the rest from the mails they send — ten
different shapes, a PDF, two tables living only in a mail body. The owner then returned
v15 with every customer filled in, so that supplement is retired and the workbook is the
single source. If a future workbook is short again, the readers are still in
`.claude/skills/refresh-tvsm-dashboard/scripts/schedules/` with the traps in its README —
but check with the owner before mapping, because my pass got several things wrong that
their correction exposed: **R/L means 1 m not 6 m**; the customer's ID column on an ERW
row is a derived inner diameter, **not a governed bore**, and putting it in the match key
loses the line; a CEW size is not governed as written (19.05 x 3.2 is `19-12.5-3.25-CEW`,
30.15 x 2.32 is `30-25.5-2.25-CEW`, and 21.7 CEW maps to its **mother tube**
`22.23-0-2-ERW 1-FC`); and a customer's file is their whole Tata Steel requirement, not
their TVSM part — Rajsriya's six plant blocks total 733,000 pieces where the owner
scheduled 136,000.

Sizes a customer schedules that no bucket governs get **their own table on the Missing
mappings tab**, "Schedule sizes with no governed bucket", with a copy button and a
`Schedule` option on the type filter. They were only in the generic first table at
first, which is described as being about materials and customers — findable in the data
and not on the page. **A queue nobody can find is not a queue.** Every row names its size
in the form the customer sent it; a row reading `lookup error` there is a bug, not a gap.
On 5 August, after v16: empty — the owner's master governs every scheduled size.

**Near-value dimensions fold onto the governed one**, via `OD_GROUPS` and
`THICKNESS_GROUPS`. Customers write what their drawing says; `Bucketting` holds one
number and nothing near it — 22.23 never 22.2, 41.28 never 41.3, 1.2 never 1.21/1.22,
1.6 never 1.62/1.63. Confirmed by counting buckets before adding each. Add the pair when
a size reaches no bucket and `Bucketting` clearly governs it under a neighbouring number.
**Since 22 Aug the fold tables are data, not code**: `public.size_folds` (38 seeded
pairs, identity entries kept), edited on two "Master · Size folds" tables on the Missing
mappings tab under the `thickness_fold`/`od_fold` scopes of `/api/assign`, applied at the
next refresh, echoed to `config/size_folds.json` — which is the file **both** languages
seed from at import, so `check_normalise.mjs` stays a proof unchanged. The pipeline
refreshes them database-first at the top of `main()` and mutates the dicts in place; the
migration is `20260822084116`. Adding the next 1.22 is now a row on the tab, not a code
change. The move was proven payload-neutral by a full before/after oracle diff.

**Never take tonnage from `Bucketting.kG/nos`.** The column carries two units: kilograms
per *piece* on a cut-length row, kilograms per *metre* on a 5.6 m or 6 m one — 25.4 x 3.5
reads 1.889346 for both a 0.247 m piece's 0.4667 kg and the 5.6 m row. Reading it as
per-piece gave a 935 mm piece a 283 mm piece's weight; reading it as per-metre left
Narasipur 25 MT light. Schedule tonnage is the customer's own stated figure, or blank so
the pipeline's formula computes it — that formula agrees with the trustworthy rows to
0.05% and governs every other tonnage on the page.

**`THICKNESS_GROUPS` was missing 1.22.** Srikam, Rajsriya and NMPL write a 1.22 wall
where the governed value is 1.20 — `Bucketting` has 256 buckets at 1.2 and none at 1.21
or 1.22 — so 85,500 pieces of August schedule met no bucket. Added beside 1.21. It also
corrected a second thing: code `3884381` had been counted as present in `Bucketting`
when it is not there at all.

**Month boundaries broke two more things on 1 August; both are fixed.**
The daily dump only covers the month in progress, so (a) `code_oem` built from it alone
resolved only 66.75% of schedule OEMs on 3 August and failed the 99% gate, and (b) July
vanished from the trend entirely, 3,344.836 MT, because no quarterly extract covers it.
`code_oem` now reads the full history, and the trend takes each month from one source —
daily dump first, archives filling the rest — which makes archiving safe.
**Archive each month's `sales.xlsx` as `sales_<mon>.xlsx` when the month closes and add
it to `SALES_TREND_FILES`.** July is archived as `dumps/sales_jul.xlsx`.

**Orders are shown as two columns on the long-length and Megh tabs** — signed off and
not signed off — from `signoff.xlsx`, so a SKU's coverage can be read against firm demand
separately from the rest. Its three sheets share only the material code: `jsr` has a Y/N
flag (the line's whole balance goes one way), `hosur` states signed MT against the order,
`khopoli` states both halves and its "Order Qty in MT" is pieces. **Ignore jsr's
`Sign Off Qty`** — it exceeds the balance on 9 of 27 rows. On 5 August: 3,471.163 MT
signed, 4,284.275 not across the two tabs; 41 codes reaching no bucket or SKU
(476.301 MT) are on the Missing mappings tab under `Order sign-off`.

**Each quantity column of a drill-down totals its own field.** Sign-off is the first
breakup with more than one, and one total computed from `qty` and repeated across all
three showed 22.23-0-2-ERW 1-PE as 337.71 MT signed, 337.71 not signed and 337.71
ordered — a row saying both that everything was signed off and that nothing was. Fixed
5 Aug; the line values and `data.json` were right throughout, only the totals row was
not. A test fails if a shared total returns.

**The Megh SKU key is stated by the plan, not derived.** From 13 Aug the `vsm stock`
sheet carries a **`length key`** column and it is the join key: the governed bucket with
the finished length appended, `22.23-0-2-ERW 1-PE-5.951`. It replaced a key the pipeline
assembled as `OD-ID-thickness-length-grade-cuttype`, whose cut token came from the
bucket's end condition — so wherever the plan and `Bucketting` disagreed there, the two
sides built different keys and the tonnage went to the unmapped queue instead of a SKU.
Adopting it moved 32.349 MT out of that queue (mapped 87.569 → 119.918 MT, unmapped
86.141 → 53.792, the pair still summing to the 173.711 MT the sales file holds) and took
the tracker from 73 SKUs to 89. `sources.py` now *requires* the column, so a tracker
without it stops the run rather than silently resurrecting the guess. Two corrections
only, in `norm_length_key`, both where the row could otherwise not join at all: collapse
whitespace, and render a trailing length above 20 in metres. **The `Megh-` prefix is read
off the length key, not `key`** — four rows carry it there while `key` still names a
governed bucket, and per the owner the prefix means the size goes onward to RE or HMSIL,
so those rows hold no TVS bucket and stop counting toward TVSM coverage.

**The Megh tab's *Sales to Megh* is the current month only.** A bucket showing zero there
is not evidence of no sales: `22.23-0-2-ERW 1-PE` reads zero in August and TSL still
billed Megh ~180 MT of it across Feb, Mar, Apr, Jun and Jul. The month-by-month figures
live on the Past sales trend tab, and that tab is keyed on buckets while the Megh tab is
keyed on length SKUs — searching one for the other's key finds nothing by construction.

**The customer tracker's history cell is an average month**, headed *Avg month sales*,
with a tooltip naming how many months it averages over. The figures beside it are one
month of schedule and one month of dispatch; the window total read as a SKU running six
times its rate. Cell, history-table column and card all use the same months-that-moved
denominator, so the three agree.

**A month-by-month drill-down closes on an average month, not a total** — `LLHISTORY`
and `SKUHISTORY`, divided by the months listed, which are only the months that moved.
Adding a history gives the size of the window, not of a month. Labelled *Average month*.
Every other card still totals.

**The long-length tracker carries the last complete month's billing**, named by its
month ("Jul 26 sales") beside the current month's Total sales, opening the whole billing
window split between the ancillaries and Megh 943209. Last *complete* month, not the last
held: the window runs to the month in progress. It is TSL's own billing — `tsl_sales_mt`
plus the Megh line — and does **not** carry Megh's dispatch to TVSM, so it is not meant to
tie to Total sales beside it. On 5 August: 3,216.778 MT over 88 of 90 buckets.

**Never rebuild `ll_tracker` from `ll_rows`.** Order book and sign-off are added to the
frame as columns long after that list is last touched, so `pd.DataFrame(ll_rows)` a
second time drops them silently — it published 0 MT ordered and 0 MT signed off across
all 90 rows before the totals row gave it away. Write onto the frame with `.map`.

**The Past sales trend tab switches between tonnes and pieces** on one control that
drives every table on it — cards, month strip, buckets, customer SKUs, plants. The plant
summary's own unit selector is gone: two switches that can disagree are worse than one.
Breakup cards show both units regardless.

**A cut length's past sales are shown in pieces as well as tonnage.** CTL is ordered in
pieces — the customer's schedule is written that way — so 12.197 MT of a 2.59 m piece is
a figure nobody plans against and 4,710 pieces is. `months_nos` rides beside `months` on
both the customer tracker's sales history and the Past sales trend SKU table, from the
same frame so the two can never disagree, and prints under the tonnage in each month
cell, the totals row and the drill-down. Long-length rows are left alone. Two figures in
one cell read back as one run of text, so such cells state what they paste as and what
unit they are in — `primaryText` skips the sub-line, which is what stopped the month
totals losing their "MT".

**A per-row rate is averaged in the totals row, never added.** The customer tracker's
sales history ends in Months and Avg active month MT, and the totals row added them like
every other column: 197 months over an eight-month window, and an "average" of 214.291 MT
for a customer whose busiest month was 260 and quietest 129, because a SKU selling in
three months and one selling in eight each contributed one number. Both now come off the
month columns beside them — the months the visible rows sold in at all, and the tonnage
over exactly those — following the scope filter and search with them. Divide the
unrounded Total MT column, not the months added up: `data.json` rounds each month and the
total separately. The row reads **Total · avg** where it carries both.

**A totals row must match its header.** Adding these two columns left the Megh totals row
two cells short; `refreshAllTotals` then wrote past the end of the row, threw, and no
rows rendered on either tab. A test now compares every table's counts. Beware
`re.findall("<th", ...)` when counting — it matches `<thead>` too, and made every table
look one short.

The customer tracker carries the selected customer's **sales history** — a per-line
column and a table of every SKU it has bought over the trend window, including ones with
no schedule this month. Join it on the customer's **own SAP codes**, never on the name
and never through `display_by_code`: that map drops codes shared across Helper Customers,
which is right for STRs and wrong here — it emptied the table for Balaji Press Product
and ELKAYEM AUTO Hosur across 45 lines. Three codes are shared; where one is, the note
names the other customer. An empty history states its cause, never a blank table.

The top sales card is **two** cards: sales to TVSM (direct + Megh onward, the RM
tracker's `VSM Sales`) and TSL billed (direct + TSL's sales to Megh). Neither is a
subtotal of the other. Unused card positions are hidden per view.

The `TVSM` sheet ends with **its own grand total** — no key, repeating the whole column.
Per-bucket figures group past it and stay right, so only a whole-column sum sees it; it
doubled the sales-to-TVSM card once. `sheet_total_rows` drops it at the read. Before
summing any sheet column whole, check for one.

**The business is a vendor service model.** Tata Steel supplies Megh Steel; Megh Steel
supplies **TVSM, Royal Enfield and HMSIL**. The `vsm stock` plan covers all three, so
the Megh tab is not a TVSM-only view.

Its **`key` column carries two shapes** with the same five parts, told apart by the
`Megh-` prefix: without it a governed TVS bucket
(`OD-ID-thickness-grade-endcondition`) bound for TVSM, with it an **RE or HMSIL** size
(`Megh-OD-ID-thickness-length`). The prefix says which OEM, not that the size is
ungoverned — a prefixed size has no TVS bucket by design, so keep it out of the
assign-a-bucket and add-to-Bucketting queues. Which of RE and HMSIL comes from the
conversion-agent code that bought it (943210 HMSIL, 943211 RE) over the full sales
window; unsold ones read `RE or HMSIL` and answer to both filters. Route to stock and
sales is the plan's own `056`/`0789`/`0788` codes, used after the bucket join.

**BOP items** — sizes Megh buys finished rather than converting — are governed in
`MEGH_BOP_ITEMS` from the owner's list (17 sizes, 584 nos) and flagged with a column and
filter on the Megh tab. Matched on bucket dim1-dim2-thickness then nearest length within
**50 mm**, one claim per line and per SKU. Send a new list and update that constant.
The band was 200 mm and pulled `19.05 x 2.0 x 6000` onto the plan's 5.8 m row; the owner
ruled that a gap that size is a **separate line item**. So a listed size the plan has no
row for now becomes its own row, badged *off plan*, with the plan-fed columns at zero and
the long-length columns joined for real — the plan is what is short, not the match.

The **Megh length-bucketing** on the Megh tab is the plan's own length-specific
mapping, built because `Bucketting` does not carry every code the plan names.
Its "Codes not in Bucketting" column is a live queue for the owner.

**The Megh SKU tracker is read as a size sheet**, on the owner's instruction: material
codes, OD, ID, thickness, length, grade, cut type, bucket, end OEM and BOP, then the nine
quantities, each of which opens its own breakup. Nineteen columns. The plan key, family,
on-plan, cover days, cover days post order, BOP nos, BOP stated size and plan note came
off. **The SKU is no longer a column but is still on every row**, and every drill-down key
and title is still built from it — `MEGHSCHEDULE|{sku}`, `{sku} · signed off` — which is
why dropping the column broke nothing and why `tools/check_detail_keys.mjs` is what proves
that after any such change. An **empty bucket is an answer, not a gap**: 21 of the 73 rows
go onward to RE or HMSIL, which Bucketting does not govern, and two are the off-plan
bought-out sizes that have no plan row to read one off.

**Sales to Megh opens months, not plants.** Alone among the figures on that tab it answers
"how has this size sold over time" rather than "where is this month's tonnage", so its
breakup is a small table: a material code per row, a month per column, and the footer
adding each month down its own column — which means **the published month's column totals
to the very figure that was clicked**. That tie is the test. Two things it depends on:
every month column says `add: True`, because `kind: "mt"` is not summable on its own; and
`MEGHSALES` stays out of `AVERAGE_BY_MONTH`, which is right where the rows are months and
wrong where they are codes. It is guarded on `sales_months`, not on `sales_mt` — **38 of
the 48 sizes with a history sold nothing in the published month**, and those are precisely
the rows whose history is worth reading. Guarding on a nulled key instead would be weaker:
any build that wrote the key unconditionally, as this one used to, would turn every unsold
size into a button onto nothing.

**A method nothing calls does nothing, and every test passed anyway.** `absorb_sales`
shipped written, unit-tested against a fake client, and never wired into
`refresh_from_supabase.py`; the first cloud refresh died on `KeyError: 'CUSTOMER  CD'` — a
column present in every sales file, and never the problem, because the frame had no
columns at all. Nothing caught it: the offline `dumps/` run uses `ExcelSources`, which
builds the ledger from files and so has no call site to forget, and the unit test called
the method directly rather than reaching it through `main`. Every piece worked and the one
line joining them was missing. **Where a backend-specific step is the only thing standing
between an upload and the pipeline, assert the call site and its ordering** — which is
what `test_the_refresh_absorbs_before_it_reads_the_ledger` does. Testing the method proves
nothing about whether anything invokes it.

Owner: Apoorv Gupta (apoorvgupta.dce@gmail.com; work mail apoorv.gupta@tatasteel.com,
which forwards the dumps). Direct publication to `main` is authorized. The repo is
also the skill's home. **Everything Claude reads lives under `.claude/`** — the project
instructions at `.claude/CLAUDE.md`, this file at `.claude/context/memory.md`, and the
package at `.claude/skills/refresh-tvsm-dashboard/`, which is where Claude Code
discovers a skill, so `/refresh-tvsm-dashboard` works without being pointed at. The
day's inputs live in `dumps/`, **which shows the current month only** — a closed month's
set moves to `dumps/YYYY-MM/` via `scripts/archive_month.py`, and the schedule workbook
goes with it (July's is `dumps/2026-07/july0626_rm_tracker_v1.xlsx`). The canonical slot
is `rm_tracker_model.xlsx`, month-neutral, because a filename asserting July while
holding August demand could not be archived without taking the live month with it.
Refresh `dumps/` and its `README.md` manifest with every daily publish. A clean clone
plus `--input-dir dumps` must still reproduce the pipeline's output — but that output is
now a Supabase build, not a byte-identical `index.html`.

**The GitHub repo is private; both deployments of it are public.** Nothing at the
repository root is reachable through either — the app serves only what it builds, and
Next serves user files only from `public/`, which does not exist here. Three separate
lists keep it that way and all three must be checked before adding a path that holds
commercial data: `.vercelignore` for Vercel, `.dockerignore` for the container image, and
`.gitignore` for what is committed at all. `/dumps/`, `/.claude/`, `/data.json`,
`/access.json` and `/index.html` are excluded from the first two. Tests assert the
Vercel exclusions hold, that the masters in `dumps/` match the checksum manifest, and
that the package still sits where Claude Code looks — the repo root is
`SKILL_ROOT.parents[2]`, and deriving it by counting was what would have failed silently.

## How it runs day to day

- Dumps arrive in the AgentMail inbox `reco_agent@agentmail.to`, usually around
  11:00–12:30 IST, often split across several mails minutes apart. The API key is
  NOT in this repo — it is embedded in the scheduled Routine's prompt and known to
  the owner; ask if a fresh session needs it.
- A scheduled Routine (`trig_01SEgdP2ay2g25zm8yyVearV`, daily 06:38 UTC ≈ 12:08 IST,
  environment `env_0126Cef6Yq3SodXJjh2og7xr`) runs the refresh unattended. Its
  prompt carries the full procedure including the staleness checks; it must never
  overwrite the committed `access.json`.
- **Two different workbooks are both called "RM tracker"; do not conflate them.**
  `aug0826 rm tracker v1.xlsx` is the approved master — `Bucketting`, `OEM_key_1_rev
  codes` and `Schedule <Month>`, canonical `rm_tracker_model.xlsx`, 58 sheets.
  `RM Tracker_18092025.xlsx` is the TVSM workbook — `vsm req`, `vsm stock`, `TVSM`,
  canonical `rm_tracker_tvsm.xlsx`, 4 sheets. Confirmed by the owner on 10 Aug after a
  first pass assumed the dated name was the master.
- **The uploader recognises a dump by name, then by its sheets, then by hand.** Real
  files never arrive under the canonical name. Stem equality on the name, never a prefix
  — `sales`, `sales_history`, `sales_jul`, `sales_q1`, `sales_q4` all begin "sales".
  Then distinctive sheet names; `Sheet1` identifies nothing, and `wip`, `sales`,
  `transfer`, `yf65` and `zmat` each hold only a `Sheet1`, so those can only be assigned
  by hand — which is right, because a filename fragment is how the sales dump once
  reached the transfer slot. **A `Schedule <Month>` sheet corroborates and never
  identifies**: the master alone holds four sheets starting "Schedule", so a stray one
  elsewhere would fill the schedule slot from the wrong workbook. It counts only beside
  `Bucketting` or `OEM_key_1_rev codes`.
- **Compare dump content, not size.** On 7 August `rfd_4731.xlsx` arrived at exactly
  yesterday's 57,435 bytes with a different sha256: a size check alone would have called
  a genuinely new extract stale and skipped it.
- The stock extract is chronically re-sent stale (three times so far). The tell:
  max `Ageing days` in PLANT STOCKS advances by exactly one per day (28 Jul = 1111,
  29 Jul = 1112, 30 Jul = 1113). The corrected extract follows in its own mail
  within the hour, as a lone `stock.XLSX` or as `FG STROCK REPORT DD.MM.YYYY.XLSX`.
  Build on the freshest stock held; publish; pick up the correction when it lands.
- Commits made just after a container restart may be signed with a key GitHub does
  not yet recognise; the fix is the stop-hook's rebase (`--reset-author` re-signs)
  and a `--force-with-lease` push. Also check `git branch --show-current` after a
  restart — the checkout can silently sit on the designated feature branch while
  `push origin main` no-ops against a stale local `main`; push `HEAD:main`.
- **The app has two homes and every push to `main` deploys to both.** Vercel — project
  `rmtracker-supabase`, git-connected, production at `rmtracker-supabase.vercel.app` —
  and since 11 Aug a container on the Hostinger VPS `168.231.102.230` at
  `rmtracker.thecuriouspandas.cloud`. `.github/workflows/deploy.yml` builds the image,
  pushes it to GHCR tagged with the commit SHA, and rolls it out over SSH; the host
  holds only `/srv/rmtracker/{docker-compose.yml,app.env}` and the compose file is
  re-copied from `deploy/` every run, so the host cannot drift from the repo. Roll back
  with `cd /srv/rmtracker && IMAGE_TAG=<older-sha> docker compose up -d`.
- **A build setting for one home can break the other, silently.** `output: "standalone"`
  in `next.config.ts` is what the container needs and it is *not* inert on Vercel: it
  folds the file trace into `.next/standalone` instead of writing
  `.next/next-server.js.nft.json`, which Vercel's `onBuildComplete` hook opens by name.
  The build compiles, typechecks, generates every page, then dies `ENOENT` on the last
  line. Two commits shipped green to the VPS and red on Vercel before anyone looked. It
  is now behind `BUILD_STANDALONE=1`, set only in the Dockerfile. **After a change to
  `next.config.ts`, the Dockerfile or the workflows, check both** — the second home only
  helps if it is not failing unwatched: `gh run list --workflow=deploy.yml` and
  `vercel ls --scope apoorvgupta0709s-projects`.
- **Nothing sets `GITHUB_REPOSITORY` for free, Vercel least of all.** It is a GitHub
  Actions variable; Vercel's own pair is `VERCEL_GIT_REPO_OWNER` and
  `VERCEL_GIT_REPO_SLUG`, and the slug is the bare name. On 12 Aug the Vercel deployment
  held that bare name, so Refresh posted to `/repos/rmtrackersupabase/dispatches` and
  GitHub — reading it as the two-segment `/repos/{owner}/{repo}` — answered 404 against
  *repos#update-a-repository*, which looks exactly like a dead token. **The tell is the
  `documentation_url`**: `update-a-repository` means the path was one segment short,
  `create-a-repository-dispatch-event` means the path was right and the repo or the
  token's sight of it was wrong. The route now rejects a value without a slash by name
  and falls back to Vercel's owner/slug pair; the VPS gets it from
  `provision-vps.sh`, which hardcodes the full path.
- **That box also runs n8n, and the dashboard borrows its Traefik** rather than starting
  a proxy: Traefik owns :80/:443 and holds the Let's Encrypt account, so a second one
  could neither bind the ports nor get a certificate. Its resolver is named
  `mytlschallenge` and its network is `root_default` — both must be named exactly, and
  `traefik.enable=true` is required because the daemon runs `exposedbydefault=false`.
- **`/srv/rmtracker` is a 30 GB loop-mounted ext4 image**, so nothing the dashboard writes
  can starve n8n. It must be made with `mkfs.ext4 -E nodiscard` and mounted `nodiscard`:
  mkfs TRIMs by default, the loop driver turns that into hole-punching on the backing
  file, and the reservation silently evaporates into a ceiling with no space actually held.
  Check with `du -h /var/lib/rmtracker.img` — allocated must be ~30 G, not ~130 M.

## Accounts and access

- **All eleven tabs are rendered by the web app.** `app/dashboard/[view]/views.ts`
  declares each one — the sections it is built from and the columns worth putting on
  screen — and `page.tsx` fetches them. `section_views` still decides which tab a section
  belongs to, so a view naming a section the reader has no grant for renders empty rather
  than leaking. **A column is totalled only when it says `total: true`**: rates, coverage
  days, prices, ages, percentages and shared stock pools carry no sum. The old rule was
  "total every numeric column except a short list", which is the wrong way round — it
  shipped the customer tracker's shared pools summed under a note saying they must not be.
- **Every table filters, searches and sorts itself**, client-side, in `table.tsx` — one
  Excel-style filter per header over that column's distinct values, a search box across
  the whole row, and click-to-sort cycling ascending, descending, off. Four rules hold it
  together, each of which was wrong in some earlier form: the filters **compose** — the
  values a header offers come from the rows the *other* headers still allow, and a header
  always still offers its own unticked values so a selection can be widened again;
  filtering and text sort run on the **rendered text**, not the underlying value, so a
  null is `—` in the list and in the column and ticking a value hides exactly the rows
  showing it; **the totals row re-adds over what survived**, average-month rule included
  (filter a SKU history to rows that only moved in July and Months reads 1, not 2); and
  the count says `80 of 240 rows` whenever anything is active, because `80 rows` beside a
  filtered table reads as the whole truth. State lives in the component, never on the
  rows — the server re-renders the whole table on every navigation.
- **Every table copies as TSV, and four tables copy a specified document.** The bespoke
  formats live in `app/dashboard/[view]/copies.ts`, declared per table by `copies:` in
  `views.ts` as a serializable kind — a function cannot cross into the client. They are
  **byte-identical to the static page's output**, proved by running the old page's own
  functions against `data.json` beside the new ones: 36 comparisons over all 16 customers
  and all 3 quarters. Keep that equivalence when touching them; these strings land in
  someone else's document. Two traps it caught: the old `fmt` sets only
  `maximumFractionDigits`, so a 5.1 MT shortfall reads `5.1` and not `5.100`; and
  quantities keep their thousand separators while *dimensions* drop them, because
  "1,130 mm" reads as a quantity on a phone.
- **The clearance list and dispatch plan take their customer from the column filter**, not
  from a selector of their own — narrow Customer to one and the button knows who it is
  addressed to; anything else is refused, because a clearance request sent to the wrong
  customer quotes them someone else's stock. Two controls that can disagree are worse
  than one.
- **Every figure that opened a breakup on the old page opens one again**, as of 11 Aug:
  53 columns over ten tabs, 7,155 buttons, 30 of the 34 prefixes. A column says so with
  `detail: { key, title, when? }` in `views.ts` — both **templates resolved against the
  row**, because the keys are built two ways (`{stock_detail_key}` where the pipeline
  precomputed one, `LLSCHEDULE|{bucket}` where it is composed). It is data, not a
  function, for the same reason `copies` is: columns cross to the client as props.
  `DetailPanel` in `app/dashboard/[view]/detail.tsx` fetches one key at a time from
  `detail_rows` on `(build_id, prefix, detail_key)` — the prefix explicitly, because it
  leads the primary key *and* is what `can_read_prefix` checks a grant against — and
  caches it per build. `detail_columns` rides along with `metadata` on every tab.
  Three rules govern its footer, each of which was wrong once: no total on the four
  formula prefixes (`LLCOVERAGE`, `LLGAP`, `LLGAP45`, `BALANCE`), an **average month**
  rather than a total on `LLHISTORY` and `SKUHISTORY`, and **each quantity column
  totalling its own field**. `kind: "mt"` is not summable — only `kind: "qty"` or an
  explicit `add: true`.
- **A placeholder that resolves to nothing leaves the cell as plain text**, and `when`
  guards the figure itself where the key exists but the breakup does not. Both matter:
  on the 7 Aug build the Megh tab writes a key onto all 73 rows for things 64 of them
  have none of, and `TRENDBUCKET` has no entry for a month a bucket did not sell in — 618
  buttons that would each have opened an explanation of nothing. Guard on the figure, not
  on the key, wherever the pipeline writes the key unconditionally. 195 buttons still
  open a pool whose list is genuinely empty; the panel says so rather than staying blank.
- **`tools/check_detail_keys.mjs` resolves every template against `data.json`** and fails
  if a key reaches no breakup, if a whole column opens nothing, or if a prefix is missing
  from `detail_prefix_views`. Run it after any pipeline rename — nothing else catches a
  drill-down that silently stopped pointing anywhere. It is wired into the pytest suite.
  `BALANCE`, `SCHEDULE` and `TRENDMONTH` are expected to be unreached: those were the
  headline-card breakups, and the fact strip that replaced the cards does not open them.
- **The customer tracker asks for a customer before it answers.** 396 lines across
  sixteen customers answers nobody's question, which is why the static page never showed
  any until one was picked. The selection lives in the **URL** (`?customer=`), like the
  tonnes/pieces switch, so the server narrows every table and none of them can disagree:
  `ViewSpec.pick` declares it, `TableSpec.pickField` names the field each table narrows
  on, and a table without one — the summary you choose from — is always shown.
  Narrowing happens **before** `flatten`, so a flatten that joins across sections sees one
  customer's rows; that is how the history's *On schedule* column is this customer's
  schedule and not everybody's. The tab carries three tables: schedule lines, the **CRFH
  book** split out for Marathwada and Sri Balaji Gear (`hideWhenEmpty`, matched on the
  bucket so no customer list needs maintaining), and the customer's **sales history**,
  which needed `('trend_customer_sku_history','customerView')` in `section_views`.
  Its columns are the static page's own thirteen, in its order — a test compares them
  against `dashboard_template.html` because the two had already drifted: the piece
  columns were missing, the CTL pool was in tonnes where the page shows pieces, and a WIP
  column had appeared that the page does not carry.
- **The dispatch plan and the clearance list read the customer's whole line set, not the
  visible rows** — the one exception to "what is copied is what is left". They are sent
  to someone: a plan that quietly omits a SKU because a search box was still filled in,
  or because the CRFH book is now its own table, is a wrong document in the dispatch
  team's hands and nothing about it looks wrong. The customer is read off the rows they
  are handed; the lines off `ctx.sections.customer_lines`. **`tools/compare_copy_formats.mjs`
  re-proves byte-identity** with the static page by running its own functions out of
  `index.html` — 32 of 32 documents over all 16 customers — and runs in the pytest suite.
  Run it after any change to what a table hands a copy button.
- **The Missing mappings tab writes.** It is the one tab that does, and it is why the app
  exists rather than the static page. Assigning a bucket to a material code saves to
  `public.bucket_assignments`, which is **deliberately not build-scoped** — a build is
  replaced wholesale every refresh, so scoping the decision to one would reproduce the
  defect it fixes, a day later. The pipeline reads it at the start of a run and applies it
  at the single point a code becomes a bucket, `material_bucket` in `refresh_dashboard.py`,
  as an **override not a fallback**: a code the master resolves *wrongly* is exactly the
  case being corrected. Proved end to end on 11 Aug — assigning `2386079` (79.157 MT at
  788) dropped `stock_unmapped` from 116 rows/514.916 MT to 115/435.759, and moved
  `stock_analysis`, `str_plan` and `qc` with it. Its holder is a non-TVS party, so the
  tonnage correctly did **not** enter the TVS cover pool; an assignment governs the code,
  the business rules still decide where it lands.
- **An assignment applies at the next refresh, and the cell says so.** Rewriting a
  published build in place would leave every figure derived from that bucket — coverage,
  risk, the STR plan — stale with nothing to signal it. The cell reads *saved · applies at
  the next refresh* rather than implying the other tabs have moved.
- **The run writes what it used to `config/bucket_assignments.json`**, committed with the
  build. That is what keeps the clean-clone rebuild reproducible: the browser writes to a
  database no clean clone can reach, so without the file the reproducibility check would
  start failing the first time anybody assigned anything. A database that cannot be
  reached is not an error — the run uses the committed set.
- **Writing is the admin's, and the policy is what enforces it**, not the hidden control:
  `/api/assign` goes through the *caller's* client, never the service role, so a forged
  request is refused by the database and the refusal is shown in the cell.
- **The overdue drill-down writes too, and it is the counter-example to the rule above.**
  A free-text remark against an overdue invoice — why it has not been paid — saves to
  `public.invoice_remarks` via `/api/remark`, keyed on `invoice_no` (`Billing Doc`) and
  likewise **not build-scoped**: drill-down rows key on `seq`, a sort position, so a remark
  written onto one would be gone by morning. Two differences from an assignment, and both
  are easy to get wrong by copying `assign.tsx` too faithfully. It **applies immediately**,
  because it feeds no figure and nothing downstream has to be recomputed — the cell must
  not say *applies at the next refresh*, and a test asserts it does not. And **any reader
  of the tab may write one**, not the admin alone: the person who knows why an invoice is
  stuck is rarely the person who published the build. Both read and write are gated on
  `can_read_view('overdueView')`. The pipeline neither reads nor writes remarks, so unlike
  `bucket_assignments` there is no committed JSON echo and the clean-clone rebuild is
  untouched. `detail.tsx` holds remarks **outside** its module-level row cache, which is
  keyed by build — together they would serve a stale remark the moment one was saved.
- **`metadata` is fetched on every tab** for its `as_of`, which dates the copied
  documents. It is not `admin_only`, so any reader who can see a tab can see it.
- **Measure a DOM node inside the event handler, not inside a lazy state updater.** The
  header filter anchors its popup to the `th`'s rect; reading `e.currentTarget` inside
  `setOpen(state => …)` threw on every click, because React clears `currentTarget` once
  the handler returns and the updater runs after that. The popup is also portalled to
  `document.body` with fixed positioning: the table sits in an `overflow-x: auto` box,
  which clips an absolutely positioned child, and the last column's list is the one that
  most needs reaching.
- **Every query against `build_sections`, `build_scalars` and `detail_rows` must filter on
  `current_build_id()`** — `currentBuildId()` in `lib/supabase/server.ts`. The policies
  hold a viewer to the current build but deliberately let an admin read every build, so an
  unfiltered query merges them: with three builds published against 7 August the customer
  tracker rendered 1,188 rows for a 396-row section, and the overview's cards silently took
  whichever copy of `summary` came back last.
- **The web app signs in by email through Supabase Auth, not by username.** As of
  10 Aug 2026 there is exactly **one** account: `apoorvgupta.dce@gmail.com` = admin
  (changed from `it@itarang.com` the same day). The two `@itarang.com` viewer accounts
  were deleted on the owner's instruction — `mes` (Megh Steel tracker) and `groupbuy`
  (the six commercial tabs for the group buy meeting: customer tracker, long-length,
  sales summary, past sales trend, SKU pricing, stock analysis). **Megh Steel and the
  group-buy attendees have no access until someone recreates and re-grants them**; the
  grants are gone with the rows, so the tab lists above are the record of what they had.
- Admin needs no grants: `app/dashboard/layout.tsx` gives `role = 'admin'` every tab
  regardless of `view_grants`, which is why the admin row has none.
- Change an address with the Admin API, never `update auth.users`: GoTrue also keeps
  the address on `auth.identities`, and a direct UPDATE leaves the two disagreeing and
  sign-in broken in a way nothing surfaces. Update `public.profiles.email` alongside —
  the sync trigger is on insert only.
- **The login form's `minLength={8}` is the real password floor**, not Supabase's
  (which defaults to 6). A password of 7 characters stores fine and then cannot be
  typed into the form, so the account is unusable.
- `access.json` and `scripts/manage_users.py` are the **old static site's** model
  (username + salted sha256) and no longer govern anything the app serves;
  `.vercelignore` keeps `access.json` off the deployment entirely.
- Sign-in is now real access control, not presentation: reads go through the caller's
  own client so RLS policies decide, rather than the old model where `data.json` was
  publicly fetchable whatever the grants said.
- **Vercel Deployment Protection is on, but set to `all_except_custom_domains`** — so it
  walls the per-deployment `…-<hash>-…vercel.app` preview URLs (302 to a Vercel SSO
  page) and does **not** wall production. Both
  `rmtracker-supabase.vercel.app` and `rmtracker.thecuriouspandas.cloud` answer a signed-
  out visitor with the app's own login page. Either can be given to `mes` and `groupbuy`;
  what they are actually waiting on is the Admin tab, not this setting.
- **So the app's own sign-in and RLS are the only gate on production**, on both hosts.
  That is the design rather than a gap — reads go through the caller's client and the
  policies decide — but it is load-bearing in a way it was not while anyone believed an
  SSO wall sat in front of it.
- **Runtime secrets on the VPS live in `/srv/rmtracker/app.env` (0600) and nowhere else.**
  Only the two `NEXT_PUBLIC_` values are baked into the image, because Next inlines those
  into the browser bundle at build time and they arrive too late via `docker run`. The
  file must also carry `GITHUB_REPOSITORY`: Vercel supplies it for free, and without it
  the Refresh button answers 501 with advice to check Vercel settings.

- **The SKU pricing tab asks for a customer, and two of its columns are now written.**
  Each quarter shows three columns — the calculated price, the customer's PO price and the
  gap — where it used to show the price, the per-metre figure and the contract base per
  tonne; the last two are in the build-up the price opens and were repeated on the row for
  no reason. `money()` went with them, and with it the defect that the one tab whose note
  says no price column is ever subtotalled was subtotalling one.
- **A SKU's operations are correctable, and the correction is an override.** Every SKU
  where the view disagrees with a customer's own reconciliation is an operation question,
  and in all six NMPL cases the schedule's flag said something and it was wrong — so a
  fallback would have corrected none of them. Kept in `public.sku_operations`, alongside
  `public.customer_po_prices`; neither is build-scoped, both are read at admin, both are
  gated on `can_read_view('pricingView')` rather than on `using (true)` as
  `bucket_assignments` is, because an operation set and a PO price are commercial where a
  bucket mapping is not.
- **Unlike an assignment, these apply immediately, and the cell must not say otherwise.**
  The price is arithmetic over figures already on the row, so the browser redoes it —
  `app/dashboard/[view]/pricing.ts` holds the formula for the cell, the build-up and the
  copy, and `tools/check_pricing_formula.mjs` proves it reproduces the pipeline's over
  every price and every build-up line of a build. Run that against a **fresh** build after
  touching either side: the committed `data.json` predates the published base per metre and
  is only checked to a tenth of a paisa.
- **The price build-up key was not unique, and now includes the bucket.** Metalman
  schedules code 3768904 at 878 mm as both a 1.6 and a 2.5 wall; the two wrote different
  workings to one `PRICEBUILD` key, so the 1.6 row opened the 2.5's — another weight,
  another contract row, a price 44% higher, nothing on screen to say so. The override key
  is the same four parts, with the length written through `float`/`Number` on both sides so
  `189` and `189.0` cannot become two keys. The contract `kg/m` is published to six
  decimals now, not four: it multiplies a rate in thousands.
- **`config/pricing_overrides.json` is the committed echo of both tables**, exactly as
  `config/bucket_assignments.json` is. Neither is committed by the refresh workflow — there
  is no commit step in `refresh.yml` — so both are only updated when somebody runs the
  refresh locally and commits.
- **The quarterly CN/DN working is a drill-down, not a section.** A quarter is around eight
  thousand billing lines and a tab fetches a section whole, so it is written under a `RECO`
  prefix keyed `RECO|customer|quarter`, and `ViewSpec.prefetchDetails` fetches the picked
  customer's keys server-side — a copy has to be built inside the click that asked for it,
  because the clipboard is not writable after an `await`. The document pastes into
  `Price Working <Q> <customer>.xlsx`, which the `reco` skill reads. Quarters offered are
  the ones the build holds billing for, not the three the contract prices.
- **`Quantity` on a sales extract is kilograms whatever the sales unit says.** `qty in no`
  is pieces and `Domain for z_qty_meter` is metres; `MATERIAL VAL = RATE/UNIT x (quantity in
  the sales unit)` confirms it on all three. The CN/DN working carries all three columns and
  leaves rejection blank, because the dashboard cannot know it and a zero reads as "none".
- **The trend tab groups a customer's SAP names.** The sales file writes a ship-to's own
  spelling — 26 of them for about thirteen customers, Rajsriya under six — so each row
  carries `customer_group` beside the raw `customer`, and the tab has two selectors, the
  ship-to narrowing inside the customer. A code claimed by two Helper Customers keeps its
  raw name rather than being guessed at, which leaves the Elkayem/Rajsriya Hosur pair and
  two Sandhar ship-tos ungrouped. "SKU trend by customer" closes on an average month now,
  not a window total. `ViewSpec.picks` is a list and `TableSpec.pickFields` a map because of
  this; the unit toggle had to stop rebuilding the URL from scratch, which would have
  cleared the selection on the first tab to carry both controls.
- **A long table scrolls inside `.scroll-box`, bounded at 72vh, with a sticky header and
  totals row.** `overflow-x: auto` alone already makes a box a scroll container in both
  axes, so a header sticking to `top: 0` in an unbounded one never moves — bounding the
  height is what makes it stick at all. The header needs an opaque background and its rule
  drawn as an inset shadow, because `border-collapse: collapse` drops a sticky cell's
  border. The column filter now **follows** the header instead of closing on scroll: it
  used to close because the `th` moved away, and with a sticky header that reads as the
  panel dismissing itself for no reason.
- **Uploading is a tab, and every source shows what was read off it.** It sits in the strip
  with the eleven views and is deliberately not a `dashboard_views` row, so it cannot be
  granted to a viewer; who sees it is a role. Each parsed sheet reports which of the columns
  the pipeline reads it found, with five rows under the header, and a sheet missing one is
  **not loaded** — a stored sheet the refresh cannot read fails hours later as a `KeyError`
  when nobody is holding the workbook. The columns are declared per slot in `sources.py`
  (`key_column`, `required`), projected into `lib/dumps/adapters.ts`, and named in the
  browser by `lib/dumps/columns.ts`, which reproduces `name_columns` including the trailing
  empty-unnamed-column trim. `tools/check_upload_columns.mjs` proves the two agree on all 23
  slots, and `generate_adapters.py --check` is finally wired into the suite — both the
  script and the generated header had been claiming a test enforced it and none did.
- **The upload write path existed only in the live database.** `promote_upload`,
  `is_uploader` and the three insert policies `lib/dumps/upload.ts` depends on were applied
  by hand and in no migration, so any branch or fresh project had an uploader who could not
  upload. Recorded in `20260812130000_...`, written to be a no-op where they already exist.
- **`lib/dumps/*` and `copies.ts` import each other with an explicit `.ts` suffix**, and
  `allowImportingTsExtensions` is on. Node's ESM resolver needs the extension, and it is
  what lets the checks in `tools/` import the app's own modules rather than keeping a second
  copy of the pricing formula and the column naming.

- **Megh's claim is a different calculation, and three quarters of it is now pinned.**
  An ancillary buys a tube and is billed for it; Megh *converts*, so what it should have
  been billed is what it can sell on at less what converting costs it. Their workbook
  goal-seeks the ex-JSR rate at which landed cost equals realisation; the cost is linear
  in that rate, so `megh_ex_jsr_rate` solves it in closed form and reproduces **all 2,304
  TVS lines of both their quarters**. The closing arithmetic — proposed less charged, per
  kilogram, times kilograms — reproduces **all 3,175 lines across all four OEMs**.
- **What is missing is Megh's base-price master**, looked up by material number in a
  workbook the dashboard does not hold. It agrees with `contract.xlsx` on most sizes and
  not on all: deriving the base from the contract instead reproduces 1,060 of 1,207 lines
  and overstates a Rs 1.76 crore quarter by **Rs 5.05 lakh**. So `MEGHRECO` publishes
  every line, its quantities in all three units and the price actually charged, and
  leaves the claim columns **blank**. A claim right seven times in eight is not a claim.
- **Megh converts for four OEMs, not three.** `943213` is Megh-Rane and was missing from
  `CONVERSION_AGENT_OEM_BY_CODE`. The effect was narrower than it looks — the OEM key
  already files that one code under `Rane` where it files the other three under `Direct`,
  so only the **code repository** was wrong, three combinations at 150.631 MT that could
  never reach a price change request. Spelt `Rane`, as the OEM key spells it: `RANE`
  would be a second name for one OEM and a duplicate row in any summary fed by both.
- **`sales_q4.xlsx` and `sales_q1.xlsx` hold the southern plants only.** No Jamshedpur
  and no Khopoli, where `sales_jul.xlsx` and the daily dump hold every plant. For Megh
  alone that is 125 of the 200 invoices in Q1 FY27, and on the complete months those two
  plants are 17.7% of lines. **Both quarterly workings therefore print the plants they
  stand on**, computed per quarter against the plants the whole window has seen. The
  coverage is stated and never judged: a plant absent from one quarter is either a gap in
  the extract or a plant that shipped nothing, 4318 really did stop, and a boolean there
  would be a guess in a fact's clothing. Re-archiving those two extracts with every plant
  is the fix, and until then Q4 FY26 and Q1 FY27 are short on both workings.
- **Every dump now has a name you can select from, and the registry says which kind it
  is.** `sources.TABLES` declares, per slot, where its rows are kept; `table_for()` raises
  on a slot that says nothing, so a slot added without deciding fails a test rather than
  silently reaching no table. Two kinds:
  - **Snapshot → a view over the current batch.** `dump_stock`, `dump_wip`,
    `dump_receivables`, `dump_rfd`, `dump_schedule`, `dump_vsm_stock`, `dump_vsm_tvsm`,
    `dump_orders_*`, `dump_signoff_*`. Nothing is copied: the view filters
    `status = 'current'`, so superseding the batch replaces the table in the same
    statement that made the upload current. Zero storage, no absorption to fail, no way to
    move a published number. Generated by `tools/generate_dump_views.py` — regenerate with
    `--write`, never hand-edit the migration. `contract:*` gets none on purpose: read with
    `header=None`, it has no column names to give columns.
  - **Accumulating → a real table, absorbed from `raw_batches`.** `tsl_sales`,
    `tsl_transfers`, `dump_bucketing`, `dump_oem_key`, `dump_zmat`.
- **`plant_code` and `material_code` canonicalise on the way in, and both have a SQL
  twin.** The dumps disagree with each other *and with themselves*: `stock.Plant` holds
  `0788` and `789` in one column, zmat holds `788`, the transfer dump holds `788.0`; SAP
  pads a material number to eighteen characters on the transfer dump and WIP, on none of
  stock or bucketing, and on 6,539 of the sales ledger's 22,419 because the daily dump and
  the quarterly archives disagree. **Joined raw, 0 of 1,088 transfer lines reached a
  bucket.** Canonical takes the plain column name; the file's own spelling is kept beside
  it as `*_raw`.
- **`prune_upload_rows` drops the rows and keeps the manifest.** `prune_uploads` deletes
  the whole `raw_batches` row after a fortnight, taking the upload history with it — what
  arrived, when, from whom, the digest `previouslySeen` checks. The rows behind a
  superseded batch are spent much sooner, and they are what the space is: 52 MB against a
  few hundred bytes an upload. Runs at `keep_days=1` after a successful publish.
  `rows_pruned_at` records it, so a reclaimed batch never reads as a dump that arrived
  empty. Live: 395 MB before this work → 439 with the tables → **376 MB, 75% of the free
  plan** after.
- **The refresh now reads the dump tables, not the stored cell grid.**
  `refresh_from_supabase.py` builds a `TableSources`, so every slot comes out of its table
  or view; `PostgresSources` still reads the grid and is what the harnesses compare
  against. The offline `dumps/` run is untouched. For the thirteen snapshot slots the two
  are the same rows and the switch changed nothing; for the four accumulating ones beyond
  sales it changed what the pipeline can see, and **only the transfer figures moved**: 220
  lines → 255, 1,898.021 → 2,128.824 MT, in transit 415.952 → 438.623. Everything else in
  `data.json` is identical, proved before the switch by
  `tools/compare_pipeline_backends.py`, which runs the pipeline both ways and diffs the
  payload. `tools/compare_table_sources.py` does the same one frame at a time.
- **What the table says a column is, is what it is** — the rule the read back settles on.
  A view column typed `text` reads back as text even where today's file holds numbers
  there; re-guessing from whichever extract arrived this morning is what makes a column
  int64 on Tuesday and object on Wednesday. Two exceptions, both round trips: a
  canonicalised `_raw` column, where `text` is only how `plant_code` is given something to
  work on, so `'788'` becomes 788 and `'0788'` stays a string; and an ISO moment, because
  JSON has no date type — `2026-07-14T00:00:00` round-trips and becomes a Timestamp,
  `2026-07-14` does not and stays text. `config/dump_columns.json` carries the mapping
  from a view's snake-case name back to the file's own header, generated beside the DDL by
  `tools/generate_dump_views.py` because a cloud run has no `dumps/` to read headers off.
- **A view's column types are baked from one file, and that is its one silent failure.**
  `dumps/yf65.xlsx` writes the accounting document number as a *number*, so the view was
  generated `dump_numeric`; the uploaded `yf65.XLSX` writes it zero-padded, `0071029066`,
  and the padding is stripped **in SQL**, where no read can undo it. It reached the page as
  `DP 36388067` against a true `DP 0036388067`. Sixteen columns across five slots had it,
  `000000000110102155` reading as 110102155 and `00001` as 1. Identifier columns are now
  typed by name in `generate_dump_views.TEXT_COLUMNS`, and
  **`tools/compare_table_sources.py --drift` is what finds the next one** — it asks of
  every column of every slot which are typed numeric while the upload holds padded text.
  A view column cannot change type in place, so each fix is a `drop`+`create`.
- **`dump_zmat` is keyed on the row's content, not on `(code, plant)`.** That pair is
  coarser than the data: it dropped 1,104 rows the file carries, which read as noise — an
  end finish and a surface finish swapped, `10` against `010` — and are not, because the
  pipeline identifies a material by code, description and an attribute key over both
  diameters, thickness, specification and both finishes. Collapsed, nine stock rows
  stopped resolving to a bucket, the STR plan lost two lines and a long-length SKU's
  signed-off tonnage read 4.925 MT against a true 7.205. Third key part is a sha1 of the
  row's stored values (`sources._row_digest`); `source_seq` rides along and is the read
  order, because the pipeline deduplicates again with `keep="first"`. 64,697 rows now
  against 64,074, the 481 byte-identical repeats still collapsing.
- **TSL sales is one accumulating table, `public.tsl_sales`, keyed on billing document
  and billing item.** Sales is the one input that accumulates where every other dump
  supersedes, because a billed line is a fact with a date on it and the daily dump holds
  only the month in progress. `raw_batches` still ingests every sales extract unchanged;
  each is then absorbed once into the ledger, adding only lines it has never seen, and
  `raw_batches.absorbed_at` records that. Absorption runs over every *un-absorbed* batch
  and not over the current one — `promote_upload` supersedes the previous batch, so two
  uploads between refreshes would lose the first — and `prune_uploads` now refuses to
  delete a sales batch that has not been absorbed.
  - **The key was verified before it was relied on**: unique in all four extracts, 786 /
    4,941 / 7,948 / 7,932 rows with zero duplicate pairs and zero collisions between any
    two files. Both halves are **text**, through `whole_number_text`: a daily dump carries
    a grand-total row and so reads float, a quarterly archive has none and reads int, and
    untexted the same invoice keys as `4731002954.0` and `4731002954` and is stored twice.
  - **The grand-total row is dropped, not deduplicated.** Every daily dump ends with one —
    no customer, no date, no billing document, and `Quantity` 968,438 kg against a month's
    real 786 lines. The key is required, so the row is discarded for having none.
  - **The one-month-one-source rule is retired.** It deduplicated whole months because it
    had no finer key, which made a *partial* backfill impossible: an extract that finally
    carried Jamshedpur for a closed month could only replace that month or be ignored.
    The line key lets it merge. Re-archiving q4 and q1 is still the fix for the plant gap,
    but it is now an upload rather than a re-cut of the pipeline.
  - **Ledger order is settled chronologically, in `sources.sales_ledger_order`.** Several
    published fields are read off `group.iloc[0]` — `trend_customer_skus` takes its length,
    bucket and segment that way — so frame order decides them. Left alone the file backend
    would order by what sits in `dumps/` and the Postgres one by primary key, and the two
    would disagree about the length shown against a long-length SKU. `sales_orders` sorts
    `kind="stable"` for the same reason; the default quicksort is not.
- **`public.tsl_transfers` is the transfer ledger, same key as sales, opposite merge
  rule.** 1,088 distinct lines from four overlapping dumps, 8 July to 13 August. Keyed on
  billing document and item — verified unique across all 844 transfer lines of the file
  held — but resolved with **`merge-duplicates` where sales uses `ignore-duplicates`**.
  A billed sale is finished when it is billed; a transfer is not finished until it is
  received, and `GR DATE` fills in on a later dump. 227 of the 1,088 did exactly that, and
  keep-first froze every one of them: the table read **445 in transit against a true 218**,
  invisibly, because each line looked right on its own.
  - **The `Invoice Type contains 'Transfer'` filter moved to absorb time.** The mail has
    more than once carried the sales dump under the transfer filename (27 July, byte
    identical). A snapshot cleared it next upload; an accumulating table would hold those
    sales invoices for ever with no way to remove them. A batch carrying no transfer
    invoice type at all is refused — and **skipped, not raised**, so one bad file cannot
    stop the sales ledger the pipeline reads next. It stays un-absorbed, which repeats the
    complaint every refresh and keeps pruning off it.
- **`dump_bucketing` is keyed on `Material Codes`, not on `Bucket`.** `ReadSpec.key_column`
  is a *display* key — the column that says what a row is about — and `Bucket` is a label
  shared across codes: 167 distinct buckets over 1,538 rows, `12.7-0-1.6-ERW 1-PE` alone
  covering 27. Keyed on it the master would hold 167 rows, lose nine tenths of the
  mapping, and fail at nothing. Same trap waits on every slot: `stock.Material` is 595
  distinct over 2,467 rows, `transfers.MATERAIL NUMBER` 84 over 845.
- **The two mapping masters and zmat let the newer workbook win** (`merge-duplicates`).
  The owner's call: codes get re-bucketed and OEM spellings get corrected, and keep-first
  would mean neither ever landed — `bucket_assignments`, which exists to *override* the
  master, would become the only way to correct it. `dump_oem_key`'s rule is an assumption
  by analogy with bucketing (same workbook); it has not been confirmed.
- **`dump_zmat` is keyed on (material code, plant), typed columns, 64,074 rows.** The
  plant is the half of the key the table exists for — it answers whether a code is
  extended at both ends of a transfer lane, which is the groundwork for an 8406 stock
  transfer plan. 1,257 codes are extended at 8406, 100 of those at 4731 too. **No column
  combination in the file is unique** — 480 rows are byte-identical repeats and
  `(Column1, PLANT)` still leaves 1,104 — so the absorber deduplicates in **frame order,
  first wins**, before inserting; `ignore-duplicates` would resolve against whatever
  shared a 2,000-row chunk. Typed rather than JSONB because 24 columns whose names are
  longer than their values cost 59 MB stored as named objects against 15. The price: one
  cell of `OUTER DIAMETER OF MATERIAL` is the text `o`, and it failed the insert for its
  whole chunk. Non-numeric coerces to null now; the original is still in `raw_rows`.

## Open threads

- **`dump_oem_key`'s merge rule is an assumption.** The owner chose keep-first for the
  masters and then flipped bucketing to last-wins; the OEM key was not revisited and is
  last-wins by analogy, both sheets coming off the same approved workbook. One line in
  `sources.TABLES` to flip if that is wrong.
- **Most codes transferred into 8406 are not extended at 8406 in zmat.** On the lines
  held: 8 of 227 on `56 → 8406`, 58 of 193 on `788 → 8406`, 32 of 110 on `789 → 8406`.
  Either the zmat extract is narrower than the plants it covers, or the transfers are
  being raised against codes not extended there. Worth asking the owner before any
  transfer plan is built on the join — the query is right, the reading of it is not
  settled.
- **Re-archive `sales_q4.xlsx` and `sales_q1.xlsx` with all plants.** Until then every
  figure drawn from January to June is southern-plants-only — the trend, the code
  repository window, both CN/DN workings and the Megh tab's month-by-month sales. Now an
  upload rather than a pipeline change: the ledger keys on the invoice line, so a fuller
  extract merges its missing lines into the closed months instead of replacing them.
- **The ledger is live: 22,419 lines, January to August.** Filled 13 Aug at 22,233; the
  14 Aug work canonicalised its material codes and plants, which added no lines. All sales
  batches absorbed, the three August snapshots collapsing exactly as the key promises. Its
  month-by-month plant coverage is the clearest statement of the southern-plants gap there
  is: Jan–Apr `789, 4318, 4731, 8406`, May–Jun the same less 4318, then **July and August
  carrying 56 and 788** where no earlier month does. (Plant codes read canonical now —
  `056` and `0788` were the same two plants.)
- **The first absorption is slow and later ones are free.** Roughly a minute per batch —
  each is paged out of `raw_rows` a thousand at a time and inserted back — so that first
  run spent about seven minutes on ten batches before the pipeline even started, and the
  whole refresh took ten. Every run after it absorbs only what has been uploaded since.
  A refresh that looks hung after an upload of several archives is probably this. zmat is
  the outlier the other way: 64,074 rows in 43s, because its table is typed rather than
  JSONB.
- ~~The `Schedule` column of the `vsm stock` sheet is empty.~~ **Resolved 13 Aug** by the
  owner's `RM_Tracker_18092025.xlsx`, which carries 1,696.5 MT of schedule across 89
  tracked rows where the previous file read zero on all 119.
- **Megh's base-price master is the one input the reco still wants.** Send the workbook
  the `Key2` / `VSM Base Price` VLOOKUP points at and the TVS half fills in; RE, HMSIL
  and Rane also need their own cost constants, which are pasted values in the sheets sent
  and so are not recoverable from them. HMSIL does not goal-seek at all — its proposed
  rate is set some other way.

- **Migration filenames in the repo have drifted from the versions actually applied**, and
  the 14 Aug work widened the gap deliberately: production carries **45**, the repo 20
  files. **The ledger is what differs, not the schema — verified 15 Aug** by comparing
  production against the repo directly: all 13 snapshot views match on column count *and*
  on every type the late fixes retyped (`billing_doc`, `po_no`, `matl_no`, `item_no`,
  `custno`, `column1`/`column2`, the receivables org codes); all 14 expected functions,
  all 21 tables, all 25 indexes and all 41 policies exist and are created by some repo
  file; the `trend_customer_sku_history → customerView` grant is present. So a version
  stamp missing from `list_migrations` does **not** imply a missing object — check the
  object, not the stamp.
  - **Going forward, keep the two aligned**: apply new SQL with the MCP `apply_migration`,
    then commit the repo file under the *same* version stamp the tool assigned. Never run
    `supabase db push` — most repo files are not idempotent (`create table` and
    `create policy` without guards), so a replay against production would fail partway. Eight of those forty-five are the retyped views and the zmat rekey, applied one
  statement at a time and *not* written to a repo file of their own — the view DDL is
  regenerated from `tools/generate_dump_views.py --write`, which is the reproducible
  definition, and `20260814123112` is the last of them. The MCP tool takes SQL rather than a file, and the views were applied in batches
  small enough to paste accurately after two transcription slips, so one repo file
  (`20260814070000_a_view_per_snapshot_dump.sql`) corresponds to fourteen applied
  versions, `dump_cell_helpers_and_plant_code` through
  `views_canonicalise_material_codes_signoff_khopoli`. **Read the applied list with
  `list_migrations`; the directory answers a different question.** The repo files are the
  reproducible definition — regenerate the views with
  `python3 tools/generate_dump_views.py --write` — and every applied name is recorded in
  the header of the file it came from.
  - `SUPABASE_DB_URL` in `.env.local` has a **stale password** — `psql` fails
    authentication against it, which is why none of this could be applied from a file.
    Worth fixing: it would make the next migration one command.
  - Earlier state, still true. Production carried 13 on 13 Aug: the
  pricing and upload-path ones the previous session recorded as unapplied are in fact
  applied, as `20260812073426` and `20260812073526`; `megh_reco_prefix_grant` landed as
  `20260812165102` against a repo file named `..._megh_reco_and_the_fourth_conversion_code`;
  and `20260809185703 uploader_write_policies` is carried by
  `20260812130000_record_the_upload_path_the_database_already_has.sql`, which holds
  `is_uploader`, `promote_upload` and the three insert policies (it was written to be a
  no-op where they already exist — so it is *recorded*, not missing).
  Nothing is applied automatically — there is no `supabase db push` in any workflow — so
  check with `list_migrations` rather than by reading `supabase/migrations/`.
- **"SKU trend by customer" and "SKU history — average month" now close on the same two
  figures** and differ only by a Segment and a Length-m column. One of them is probably
  redundant; not resolved without the owner.
- **The Admin tab is the only control still missing.** Filters, search, sort and every
  copy button were ported on 10 Aug; the drill-downs, the customer selector and the
  bucket-assignment write on 11 Aug. Grants are therefore still changed by SQL, which is
  what `mes` and `groupbuy` are waiting on.
- **Every assignable scope is now consumed, and a test says so.** Closed 17 Aug. `bucket`
  overrides `material_bucket`; `megh_sku` overrides `vsm_key` on all three frames, just
  after the two lookups that try to reach a plan key; `ctl_bucket` is new, for the RFD
  queue, which resolves through the material master's own `CTL Bucket` column and so could
  never be reached by a bucket assignment. `test_every_scope_the_browser_can_write_is_one_the_pipeline_reads`
  fails if a fourth scope is added with nowhere to apply it — which is what let `megh_sku`
  sit written-but-unread for a fortnight.
- **One RFD row in four cannot be answered from the dashboard**, and that is not a bug to
  fix here. A CTL assignment is keyed on the listed `CTL Code`, and 15 of the 60 positive
  rows on the 28 July file have none — the row names nothing to hold a decision against.
  The cell reads `no code` and the table's note says the fix is to give the line a code in
  `rfd_4731.xlsx`.
- **PCR code repository window**: still the current month only. The trend tab's
  quarterly extracts are not wired into the repository — worth doing so a code last
  billed in April appears in a price change request.
- **Order book gaps**: on the 31 July live book (302 lines, 6,361.620 MT after the
  `c` filter), 35 lines and 953.110 MT reach no long-length tracker row — 850.334 MT on
  buckets carrying no schedule, 102.776 MT with no governed bucket. 483.376 MT of that is
  still on the Megh tab; **469.734 MT over 17 lines shows nowhere**, which is the number
  worth chasing. Each is listed on the Missing mappings tab with which view it is missing
  from and which still shows it; the excluded lines sit on the same sheet labelled
  *Excluded on purpose* and sorted last. Including those, 100 lines and **1,790.970 MT**
  reach no LL row — mailed to the owner as a workbook on 1 Aug. Open judgement call,
  unchanged: the LL tracker's rows are the buckets carrying a schedule, so orders on
  unscheduled buckets reach no LL row. Offered to widen that row universe; not yet taken
  up, and re-put in that mail.
- **August schedules, part done.** All 16 customer mails are parsed (8 customers; two
  sent their schedule as a table in the mail body, Narasipur as a PDF). 172 of 206
  lines — 91% of 2.7 m pieces — match a row that already carries its code and bucket.
  **34 are sizes new in August; 18 of those have no `Bucketting` entry at all** and 5
  match more than one bucket family, so they cannot be mapped without the owner. Nothing
  is written back yet. Working files are in the session scratchpad, not the repo.
- **Bucketting queue from the length-bucketing**: 2 codes on TVS-range sizes that
  `Bucketting` does not carry. The other 7 sit on `Megh-` sizes and are expected.
- **Megh SKU mapping worksheet**: the owner's 31 Jul plan closed most of it. Now 94
  rows with 24 needing something (141.5 MT) — 21 want a material code, 2 a `Bucketting`
  entry, 1 a key/grade/cut type. No row asks for a bucket any more.
- **Unmapped materials queue**: `3531649` (Metalman) and `3781665` (Srikam) carry
  no governed bucket; ~40 mother-tube descriptions (~400 MT WIP) have no `TUB-`
  FG equivalent in zmat, so no STR can be raised on them. Owner assigns buckets
  via the Missing mappings tab.
- **Stale stock sender**: worth the owner asking the sender to re-run the extract
  daily rather than re-attaching; the FG STOCK SUMMARY version has been the
  correct one each time.
- **Contract roll-over**: `contract.xlsx` (approved master) covers Q3 FY26–Q1 FY27.
  A new sheet is needed when pricing rolls to Q2 FY27.
- **August schedule workbook — the live blocker.** The 3 August dumps are published
  against `Schedule July`, so every balance figure on the customer and long-length
  tabs is last month's demand against this month's dispatch. The banner says so, but
  the numbers stay uncomparable until the workbook arrives. Ask for it; on arrival,
  update `SCHEDULE_SHEET`/`SCHEDULE_MONTH`, refresh `assets/masters/` and the
  checksums in `config/master_manifest.json`.
- **Order book** is still the 31 July `consolidated_30072026.xlsx`; no newer one has
  been sent, so its line ages lag the as-of date.

## Decisions already made (do not re-open without cause)

- Stale-file detection, WhatsApp clearance format, RFD weight-based
  reconciliation, Megh keying off the plan's own `length key`, ERW 2 pricing off the
  `-HST` contract variant, STR per-plant columns, per-quarter price audit at
  1 m for LL — all specified with reasons in `SKILL.md` and the data contract.
- Figures in the data contract are dated; its header says which set they describe.
- Tabs and tables are named, never numbered, in rules — ordinals broke twice.
- The six NMPL reco price mismatches are hand adjustments in the customer's
  sheet, documented deliberately, not formula errors to "fix".
- **Offsets on the overdue tab are credit-side only, and the two gross columns are
  gone.** An offset is told by `Nature` — credit note, other credit balance,
  collection — and `OTHER DEBIT BALANCE` is excluded from the figure, its count and
  its breakup alike, because a debit balance adds to the exposure rather than
  reducing it; 1,846 of them were netting +₹34.0 lakh against −₹121.8 lakh of credits
  and making the figure a net of two unrelated things. `Doc Type` cannot decide this:
  `AB` carries both. `Debits INR` and `Credits INR` left the tab on 12 Aug 2026; the
  split is still recorded in `qc_summary.json`, as is everything the two whitelists
  exclude, per `Nature`.
- **Every `.vercelignore` pattern is anchored with a leading slash, and must stay
  that way.** Unanchored, gitignore semantics match a directory of that name at *any*
  depth: `dumps/` also swallowed `lib/dumps/` and `supabase/` also swallowed
  `lib/supabase/` — between them the whole of `lib/`. The app's ten `@/lib/...`
  imports then resolved to nothing and every deployment died with `Module not found`
  before it could serve a page, while the local build stayed green because the files
  are only missing from the *upload*. Check with
  `git -c core.excludesFile=.vercelignore check-ignore -v --no-index lib/supabase/server.ts`
  — it must match nothing.

- **All mapping is manual and answerable in one place.** The owner's instruction, 18 Aug:
  do not infer a mapping on their behalf — put it in Missing mappings and let them
  answer it. The masters therefore sit on that same tab rather than a separate one, each
  editable, with an **Only unanswered** toggle to hide what has been done. There is one
  tab you write to and it is that one.
  The owner's model, stated 19–20 Aug: **each master maps its own domain and nothing
  crosses over** — OEM key maps sales customers to OEMs (for the LL tracker), the Megh
  length key maps material codes to plan SKUs (for the Megh tab), Bucketting maps TVSM
  ancillaries sales to buckets, and Bucketting's bucket must agree with the plan's
  `key` where both name a code.
  **Done for Megh (20 Aug):** `vsm_key` on stock, sales, WIP, the order book and the
  ledger history is the plan's plant columns under `megh_sku` assignments — the
  bucket+length derivation is gone as a join and survives only as the queue's
  suggestion column. It had been misrouting both ways: 155.6 MT the plan names sat in
  the queue over PE/FC and 6.001/6 spelling splits, while 37.5 MT landed on SKUs no
  master tied the code to. Locked by
  `test_a_megh_sku_is_reached_only_by_a_statement`.
  **Done for Bucketting too (22 Aug):** the `attr_key` attribute inference is removed
  from S1 in both implementations — a code resolves only off a Bucketting row or an
  owner assignment. ~1,474 MT that rode on inference now stands in the queues
  (missing_mappings +947, stock +237, WIP +290 MT on the 21 Aug dumps). The hard
  floors were recalibrated in the same change — sales 0.90→0.80, stock 0.95→0.85 —
  because with manual mapping a sub-95% resolution is a queue mid-answer, not a read
  fault; a truncated read still collapses resolution to a fraction and still fails.
  The 6 codes where Bucketting and the plan disagree on the bucket still need the
  owner to say which master wins.
- **A scope is assignable only once the pipeline reads it back by the same string.**
  Five places have to agree: the cell, `/api/assign`'s `SCOPES`, the check constraint,
  `views.ts`, and `refresh_dashboard.py`. Miss the last and the write succeeds, the cell
  says *saved · applies at the next refresh*, the row leaves the queue, and no figure
  ever moves. `megh_sku` sat that way a fortnight; `oem` for eight hours on 17 Aug and
  was withdrawn by migration rather than shipped. `oem` returned 19 Aug once
  `oem_map` applied it. Both `test_the_assignable_spaces_agree_everywhere` and
  `tools/check_mapping_tab.mjs` now fail on a scope nothing consumes.
- **An OEM assignment is the widest single answer on the dashboard.** `oem_map` is the
  one place a customer name becomes an OEM, and the sales frame, the schedule, stock,
  receivables, the code repository and the trend segments all read it — one correction
  moves six tabs at the next refresh. Both sides key through `norm_text`.
- **"Immediately effective" for a mapping means rebuild, and the rebuild keeps the
  build's own as-of.** The Apply-mappings button on the Missing mappings tab (20 Aug)
  dispatches the refresh with `client_payload.as_of` = the current build's date, so the
  same dumps republish under the date they arrived on; only the daily flow, whose dumps
  really did just arrive, stamps today. Locked by
  `test_an_applied_mapping_rebuilds_under_the_builds_own_date`. Completion is detected
  by polling `GET /api/refresh` for a changed build id, never estimated.
- **Every column header carries an ⓘ derivation note.** Authored text where a real
  calculation sits behind the figure (mapping tab in full, LL tracker, STR plan);
  everywhere else a structural default built from what the code knows — source
  section/master, formatting, severity thresholds, totals behaviour — assembled in
  `explainColumn` in `table.tsx` so it cannot drift from what the code does. Add
  `explain` to a Column (the `ex()` helper in views.ts) to author one.
- **Migrations: the additive half first, the withdrawal last.** Not "always after the
  deploy" — the rule that actually holds. Inserting the `mappingsView` row before its
  code shipped made production advertise a tab that 404ed (17 Aug); moving
  `megh_length_bucketing`'s grant to `mappingView` *before* the deploy is safe, because
  an unused grant does nothing. Stamp the repo file with whatever version
  `apply_migration` assigned — check `list_migrations` and rename.

## Owner's working preferences

- Voice-transcribed messages: expect typos ("pheth", "udate", "STROCK");
  interpret by intent, confirm when genuinely ambiguous.
- **ⓘ lineage lines must be concrete, not prose.** The owner's correction, 22 Aug, on
  the Megh tab's notes ("too confusing", "too verbose"): a Source line reads
  `file.xlsx › sheet: columns`, and a Mapped-on line names the key plus the joining
  columns of each table — never a description of where things conceptually come from.
  All eleven views were swept to this form on 22 Aug — every authored note and every
  lineage block names its file, sheet and columns. In the same message the owner
  restated that Megh Steel sales maps material codes **only** through the plan key,
  never Bucketting — which the 20 Aug rule already implements and
  `test_a_megh_sku_is_reached_only_by_a_statement` locks; the only Bucketting mentions
  left on that tab are the "Codes not in Bucketting" queue columns, which report
  rather than map.
- **An ⓘ note is the column's own, never a shared block.** The owner's second
  correction the same day ("generic and same for all"): the unit line, the totals
  line, the click line and the table lineage were appended to every column, so five
  shared sentences buried the one specific one. `explainColumn` now appends that
  block only where no authored note exists — an authored note stands alone with its
  severity bands — and every Megh-view column's note is self-contained:
  `file.xlsx › sheet › column` plus the mapping route that lands the figure on the
  row. The full sweep across all 39 tables (22 Aug) made every authored note
  self-contained the same way — and caught two notes that were *wrong*, which is what
  the concrete form is for: both order tables claimed their tonnage was "kg ÷ 1,000"
  where the orders.xlsx sheets state MT directly, and the Bucketting master's note
  still described the attribute inference retired that same day.
- Wants outcomes first, tables for movement vs the previous day, and defects
  stated plainly with what changed and why.
- Copy buttons are load-bearing: dispatch plan, clearance list (WhatsApp
  format), STR list, PCR — each has a specified format in the skill.
- Publishes daily; expects the skill, docs and tests to be kept in sync with
  every code change, verified by clean clone.
