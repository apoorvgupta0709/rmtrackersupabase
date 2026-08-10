# Session memory

Working memory for the TVSM operations dashboard. Read at session start; update and
push whenever a session produces a durable fact. Keep entries true — prune what
expires rather than appending forever. Nothing secret goes in this file: the repo is
served publicly through Vercel, so this file is fetchable by URL.

_Last updated: 2026-08-07 (as-of 7 August build, schedule from v16)._

## What this is

A static operations dashboard for Tata Steel Tubes' TVSM business, built daily from
mailed Excel dumps by `.claude/skills/refresh-tvsm-dashboard/scripts/refresh_dashboard.py` and
published to `main` of `apoorvgupta0709/rmtrackerchatgpt`, which Vercel serves at
`rmtrackerchatgpt.vercel.app`. Eleven tabs plus an Admin tab; the full list and every
business rule are in `SKILL.md` — do not restate them here.

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
holding August demand could not be archived without taking the live month with it. A
clean clone plus `--input-dir dumps` must reproduce
the published `index.html` byte-identically. Refresh `dumps/` and its `README.md`
manifest with every daily publish.

**The GitHub repo is private; the Vercel deployment is not.** It serves whatever it
receives at a guessable URL with no auth — verified by fetching `CLAUDE.md` from the
live site. `.vercelignore` holds `dumps/` and `.claude/` out of it; only `index.html`,
`data.json` and `access.json` are served. Never add a path holding commercial data
without checking that file. Tests assert both stay ignored, that the masters in `dumps/`
match the checksum manifest, and that the package still sits where Claude Code looks —
the repo root is `SKILL_ROOT.parents[2]` now, and deriving it by counting was what would
have failed silently in this move.

## How it runs day to day

- Dumps arrive in the AgentMail inbox `reco_agent@agentmail.to`, usually around
  11:00–12:30 IST, often split across several mails minutes apart. The API key is
  NOT in this repo — it is embedded in the scheduled Routine's prompt and known to
  the owner; ask if a fresh session needs it.
- A scheduled Routine (`trig_01SEgdP2ay2g25zm8yyVearV`, daily 06:38 UTC ≈ 12:08 IST,
  environment `env_0126Cef6Yq3SodXJjh2og7xr`) runs the refresh unattended. Its
  prompt carries the full procedure including the staleness checks; it must never
  overwrite the committed `access.json`.
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

## Accounts and access

- **The web app signs in by email through Supabase Auth, not by username.** Three
  accounts, all confirmed: `apoorvgupta.dce@gmail.com` = admin (changed from
  `it@itarang.com` on 10 Aug 2026); `mes@itarang.com` = the Megh Steel tracker only;
  `groupbuy@itarang.com` = the six commercial tabs for the group buy meeting (customer
  tracker, long-length, sales summary, past sales trend, SKU pricing, stock analysis) —
  no mapping, STR, transfers or overdue queues.
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
  publicly fetchable whatever the grants said. Vercel Deployment Protection is also on,
  which puts a Vercel SSO wall in front of every URL — fine for the owner, but it locks
  out `mes` and `groupbuy` until it is turned off in Project Settings.

## Open threads

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
  reconciliation, Megh keying off the governed bucket, ERW 2 pricing off the
  `-HST` contract variant, STR per-plant columns, per-quarter price audit at
  1 m for LL — all specified with reasons in `SKILL.md` and the data contract.
- Figures in the data contract are dated; its header says which set they describe.
- Tabs and tables are named, never numbered, in rules — ordinals broke twice.
- The six NMPL reco price mismatches are hand adjustments in the customer's
  sheet, documented deliberately, not formula errors to "fix".
- **Every `.vercelignore` pattern is anchored with a leading slash, and must stay
  that way.** Unanchored, gitignore semantics match a directory of that name at *any*
  depth: `dumps/` also swallowed `lib/dumps/` and `supabase/` also swallowed
  `lib/supabase/` — between them the whole of `lib/`. The app's ten `@/lib/...`
  imports then resolved to nothing and every deployment died with `Module not found`
  before it could serve a page, while the local build stayed green because the files
  are only missing from the *upload*. Check with
  `git -c core.excludesFile=.vercelignore check-ignore -v --no-index lib/supabase/server.ts`
  — it must match nothing.

## Owner's working preferences

- Voice-transcribed messages: expect typos ("pheth", "udate", "STROCK");
  interpret by intent, confirm when genuinely ambiguous.
- Wants outcomes first, tables for movement vs the previous day, and defects
  stated plainly with what changed and why.
- Copy buttons are load-bearing: dispatch plan, clearance list (WhatsApp
  format), STR list, PCR — each has a specified format in the skill.
- Publishes daily; expects the skill, docs and tests to be kept in sync with
  every code change, verified by clean clone.
