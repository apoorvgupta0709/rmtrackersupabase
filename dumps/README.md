# Reference dumps

**`dumps/` shows the current month only.** Every file here is the latest of its kind for
the month being published, so the folder answers one question at a glance: what is this
month built from. When a month closes its set moves down into `dumps/YYYY-MM/`, run by
`.claude/skills/refresh-tvsm-dashboard/scripts/archive_month.py`:

```bash
python3 .claude/skills/refresh-tvsm-dashboard/scripts/archive_month.py \
  --dumps dumps --month 2026-08 --dry-run
```

Files move rather than copy, so nothing exists twice and drifts. Three things stay on
top because the pipeline reads them every day whatever month sent them: the trend
sources (`sales_q4.xlsx`, `sales_q1.xlsx`, `sales_<mon>.xlsx`) and the two masters
(`zmat.xlsx`, `contract.xlsx`). The schedule workbook is not one of those — it belongs
to its month and archives with it.

| Month | Folder |
|---|---|
| July 2026 | `dumps/2026-07/` — including `july0626_rm_tracker_v1.xlsx`, that month's schedule workbook |

## Current month — 7 August 2026 build

Every file the owner shared for the published 7 August 2026 dashboard, under the
canonical filenames the pipeline expects. Nothing else is kept here except one
worksheet that belongs with them — `megh_sku_mapping.csv`, below. The dashboard's own
outputs live at the repository root (`index.html`, `data.json`) and the code under
`.claude/skills/refresh-tvsm-dashboard/`.

Rebuild the published dashboard from this folder alone:

```bash
python3 .claude/skills/refresh-tvsm-dashboard/scripts/refresh_dashboard.py \
  --input-dir dumps --output-dir /tmp/out --as-of 2026-08-07
```

**Not served on the web.** `.vercelignore` keeps this folder out of the Vercel
deployment. The GitHub repository is private, the deployment is not, and these files
hold sales transactions, receivables ageing and customer contract prices.

| Canonical name | Sent as | Source | Bytes | sha256 |
|---|---|---|---:|---|
| `rm_tracker_model.xlsx` | `aug0826 rm tracker v1.xlsx` (v16, Rajsriya scheduled) | 2026-08-05T12:07:38Z | 1,988,868 | `c232d66c7bc13949…` |
| `zmat.xlsx` | `zmat.xlsx + material mapping_30072026.XLSX merged in` | master, 30 Jul | 6,942,220 | `2dfffaf1c795d49e…` |
| `contract.xlsx` | `tsl tubes contract q4 q1 fy27 08072026.xlsx` | approved master, 28 Jul | 135,455 | `5d029e7214e23f23…` |
| `sales.xlsx` | `sales.XLSX` | 2026-08-07T06:58:22Z | 718,587 | `eacefa9852dbad79…` |
| `sales_q4.xlsx` | `Q4 Sales Dump.xlsx` | 2026-07-31T06:40:54Z | 8,371,564 | `fdc5155cd012a999…` |
| `sales_q1.xlsx` | `Q1 sales Dump.xlsx` | 2026-07-31T06:40:54Z | 9,900,624 | `a5a8cdc0db40ee11…` |
| `stock.xlsx` | `stock.XLSX` | 2026-08-07T06:58:22Z | 2,903,567 | `b3bb6a5efe77f31e…` |
| `wip.xlsx` | `wip ystockn.xlsx` | 2026-08-07T06:58:22Z | 37,779 | `f76517bd79ee1c17…` |
| `rfd_4731.xlsx` | `rfd_4731.xlsx` | 2026-08-07T06:58:22Z | 57,435 | `5b1889d9410fcc12…` |
| `transfer.xlsx` | `transfer.XLSX` | 2026-08-07T06:58:22Z | 741,197 | `5b08d8a0476fd4b8…` |
| `yf65.xlsx` | `yf65.XLSX` | 2026-08-07T06:58:22Z | 382,281 | `99f8aaed27face8e…` |
| `rm_tracker_tvsm.xlsx` | `RM Tracker_18092025.xlsx` | 2026-08-07T06:58:22Z | 70,165 | `c63b0af0523e9dd6…` |
| `orders.xlsx` | `consolidated_30072026.xlsx` | 2026-07-31T08:28:37Z | 177,817 | `4e73917fdad0ec74…` |
| `sales_jul.xlsx` | `sales.XLSX, July archived on close` | 2026-07-31T06:40:44Z | 4,430,391 | `dc4ca9556dc908c0…` |
| `signoff.xlsx` | `signoff.xlsx` | 2026-08-04T11:37:47Z | 139,805 | `3301447ffeb74289…` |

## Deliverables

`deliverables/` holds files built for a person rather than for the pipeline. They are
outputs, not inputs — the refresh never reads them, and they are covered by the same
`.vercelignore` rule as the rest of this folder.

| File | What it is |
|---|---|
| `aug0826_rm_tracker_v1_august_schedules.xlsx` | The owner's master workbook with the August schedules for all 18 customers written into `Schedule July` — 425 active rows, all 58 sheets intact. **Quantities only:** `SCHEDULE IN MT` is a formula over the dimensions and the quantity, so it is left alone and fills in when Excel opens the file. Read with anything but Excel it shows a blank MT column. Built by `scripts/schedules/merge_into_master.py` |

## What each file is for

- **`rm_tracker_model.xlsx`** — the month's schedule sheet, Bucketting, OEM key 1 rev — the governing
  mapping workbook. This is the canonical *slot* name; the file itself is now
  the owner's corrected `aug0826 rm tracker v1` (v16), whose **`Schedule August`** sheet carries
  the August demand for every customer. The sheet is now named for its month, and the
  pipeline resolves it from the as-of date
- **`zmat.xlsx`** — ZMAT material master: attributes, description-to-code, FG code behind
  a mother tube. **The only material master.** The 30 July material-mapping extract is
  merged into this file — 20 rows for `TUB-O-N-AUT-AN-FC-70.00X3.200X6.00 HST`, code
  `3499608`, at 20 plants — and the extract itself is not kept. Merge a future one with
  `scripts/merge_material_mapping.py`, then copy the result over
  `assets/masters/zmat.xlsx` and update the checksum in `config/master_manifest.json`
- **`contract.xlsx`** — Customer contract base prices by quarter — drives SKU pricing
- **`sales.xlsx`** — August sales, 1–7 August billed. The daily dump only ever covers
  the month in progress
- **`stock.xlsx`** — PLANT STOCKS finished-goods stock. New: max ageing 1121 against
  1120 yesterday, the one-per-day step that says the extract is today's
- **`wip.xlsx`** — WIP / ystockn mother-tube stock
- **`rfd_4731.xlsx`** — 4731 RFD cut-length stock
- **`transfer.xlsx`** — Inter-plant transfer movements
- **`yf65.xlsx`** — Receivables ageing for ancillary overdue
- **`rm_tracker_tvsm.xlsx`** — TVSM and vsm stock plan sheets
- **`sales_q4.xlsx`, `sales_q1.xlsx`, `sales_jul.xlsx`** — archived sales, `Sheet1` only,
  driving the past sales trend tab. `sales_jul.xlsx` is July's daily dump kept on after the
  month closed: the trend loses a month otherwise. **Archive each month this way as it ends.**
  A month held by both an archive and the daily dump is counted once, from the daily dump
- **`signoff.xlsx`** — order sign-off by plant, sheets `jsr`, `hosur`, `khopoli`. Each
  states the signed-off quantity in its own way and they do not agree on units, so read
  each sheet on its own terms
- **`orders.xlsx`** — Sales-planning order book: jsr, hk_so, hk_str. Still the 31 July
  book; no newer one has been sent, so its line ages lag the as-of date
- **`schedule_supplement.xlsx`** — no longer present. The ten customers it carried are
  typed into the owner's corrected `aug0826 rm tracker v1` (v16), so the master is the
  single source for August demand. The pipeline still reads the slot if a future month
  needs it

## The three approved masters

`july0626_rm_tracker_v1.xlsx`, `zmat.xlsx` and `contract.xlsx` are also held under
`.claude/skills/refresh-tvsm-dashboard/assets/masters/`, checksummed in
`config/master_manifest.json`. The copies here are byte-identical, and a test
asserts they stay that way — two copies that drift would be worse than one.

- `july0626_rm_tracker_v1.xlsx` — matches the approved master
- `zmat.xlsx` — matches the approved master
- `contract.xlsx` — matches the approved master

## Replacing these for a later build

Overwrite in place under the same canonical names, keeping one internally
consistent dump set — never mix same-category files from different dump dates. Check
each file is genuinely new first: the stock extract has been re-sent unchanged more
than once, and the tell is `Ageing days` in `PLANT STOCKS`, whose maximum advances by
exactly one per day. **Compare content, not size** — on 7 August `rfd_4731.xlsx` arrived
at exactly yesterday's 57,435 bytes with a different sha256, so a size check alone would
have called a new extract stale. `SKILL.md` carries the full daily procedure.

## `megh_sku_mapping.csv` — the worksheet to fill in

Not a dump: the Megh Steel length-specific SKU list, written to be completed and sent
back. Megh buys length-specific sizes, so the governing mapping is the bucket **plus**
the length, and the `vsm stock` plan does not supply all of it.

93 rows — 85 that reach a SKU key and 8 plan rows that reach none. 47 are complete;
**46 need something, covering 544.0 MT of schedule**. Rows needing work come first,
largest schedule first. `what_is_needed` says which of four things is missing:

| `what_is_needed` | Rows | Meaning |
|---|---:|---|
| `assign bucket` | 13 | the plan's own `key` cell is empty, so nothing governs the size |
| `assign bucket; name a material code` | 9 | neither the bucket nor a code is stated |
| `state bucket key, grade, cut type, then assign bucket` | 8 | a plan row with no key at all, identified only by its dimensions |
| `assign bucket; add code to Bucketting` | 8 | both: govern the size, and add the code |
| `name a material code` | 7 | the bucket is governed, but no plant column names a code |
| `add code to Bucketting` | 1 | the plan names a code `Bucketting` does not carry |
| `complete` | 47 | nothing needed |

Fill in the four blank columns and leave the rest as they are — they are what the
pipeline currently derives, and changing them in place would hide what moved:

- **`assign_length_bucket`** — the length-specific bucket for this size
- **`assign_bucket`** — the base bucket, where `current_bucket` is empty
- **`assign_material_code`** — the code, where none is named
- **`remark`** — anything worth recording against the row

`length_mm` and `length_m` state the same length twice, in each unit, because the plan
itself mixes them: three rows state millimetres (650, 780, 572.5) in a column otherwise
in metres. The pipeline divides those down; see `SKILL.md`.
