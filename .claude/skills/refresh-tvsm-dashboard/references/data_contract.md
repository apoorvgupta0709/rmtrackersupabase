# TVSM Customer Schedule and Long-Length Tracker — Logic Specification

**Prepared from:** 29 July 2026 operational dumps, 27 July 2026 approved masters (`july0626 rm tracker v1.xlsx`, `zmat.xlsx`), and the Q4 FY26 / Q1 FY27 tubes contract
**Purpose:** Define auditable logic for a customer-wise schedule tracker, a TVSM long-length coverage tracker, plant and transfer analysis, and contract SKU pricing.
**Figures below are from the 29 July 2026 set** unless a line names its own date; earlier dates are kept where they record how a defect was found.
## 1. Source files and their roles

| File / sheet | Rows used | Role in logic |
|---|---:|---|
| `july0626 rm tracker v1.xlsx` → `Schedule July` | 423 active schedule rows | Authoritative customer schedule and planned finished length |
| `july0626 rm tracker v1.xlsx` → `Bucketting` | 1,750 material mappings | Governed material-to-bucket, CTL/LL, CTL-length, `FC/PE` and `Annealed` |
| `july0626 rm tracker v1.xlsx` → `OEM_key_1_rev codes` | 174 mappings | Customer-to-OEM and CAM mapping |
| `zmat.xlsx` → `Sheet1` | 65,158 material-master rows | Fallback material attributes, product equivalence, and the FG code behind a mother tube |
| `sales.XLSX` | 4,418 transaction rows | July sales through 29 July; also the default code repository window |
| `stock.XLSX` → `PLANT STOCKS` | 2,407 stock rows | Current finished-goods stock by material, customer, plant and CTL/LL. Also arrives as `FG STROCK REPORT DD.MM.YYYY.XLSX` under a *FG STOCK SUMMARY* subject, same sheets and columns |
| `stock.XLSX` → `TRANSIT STOCK` | 88 rows | **Not read.** Duplicates the transit rows already inside `PLANT STOCKS` |
| `wip ystockn.XLSX` | 686 populated material rows | Approved shared LL stock source, and the STR source pool at 0789 |
| `RM Tracker_18092025.xlsx` → `TVSM`, `vsm stock` | 94 tracked plan rows, 86 SKUs | VSM requirement, sales and stock by TVSM long-length bucket |
| `rfd_4731.xlsx` → `Sheet5` | 59 rows carrying stock | 4731 CTL stock; `RFD Qty.` is pieces, `WEIGHT` is MT and is what the reconciliation compares |
| `transfer.XLSX` | 172 transfer lines | Inter-plant movements; drives the transfers view and STR cover. Optional |
| `yf65.XLSX` | 3,346 rows, 1,327 billing documents | Receivables ageing; source for the ancillary overdue tab. Optional |
| `contract.xlsx` → `Tata _ERW-Q4 FY26`, `Tata_CEW - Q1 FY27` | 149 contracted sizes | Base price per tonne and per metre by quarter; drives SKU pricing. Optional |
| `sales_history.xlsx` | as supplied | Longer sales window for the code repository, in the sales dump's format. Optional |
| `sales_q4.xlsx` → `Sheet1` | 7,932 lines, Jan–Mar 2026 | Quarterly sales extract for the trend view. Optional |
| `sales_q1.xlsx` → `Sheet1` | 7,948 lines, Apr–Jun 2026 | Quarterly sales extract for the trend view. Optional |
| `orders.xlsx` → `jsr`, `hk_so`, `hk_str` | 76 + 1,074 + 98 open order lines | Sales-planning order book by despatching origin; drives the order columns on the long-length and Megh Steel tabs. Optional |

## 1a. Where the pipeline reads those files from

The table above names the files. Since 14 August the cloud refresh does not read them:
it reads the **dump tables** every upload lands in. The offline `dumps/` run is unchanged
and still reads the workbooks, which is what keeps it usable as the control.

An uploaded dump goes to two places, and the distinction matters:

- **`raw_batches` / `raw_rows`** — the sheet, cell for cell, exactly as the browser parsed
  it. This is the audit trail and it is what `PostgresSources` reads.
- **a named table or view** — what anybody querying the data would reach for, and what
  `TableSources` reads. This is now the refresh's source.

The two are the same rows for a **snapshot** dump: stock, WIP, the RFD extract,
receivables, the schedule, both RM tracker sheets, the order book and the sign-off sheets
are each replaced whole on upload, so their view is a window onto the current batch and
reading it changes nothing. Proved rather than assumed —
`tools/compare_pipeline_backends.py` runs the pipeline both ways and diffs `data.json`,
and across all thirteen the only difference is the timestamp.

For an **accumulating** dump the two are not the same rows, and that is the whole point:

| Table | Holds | Where the current upload falls short |
|---|---|---|
| `tsl_sales` | every invoice line ever uploaded | the daily dump is the month in progress |
| `tsl_transfers` | every transfer line since 8 July, 1,088 | the newest dump carries 987 rows |
| `dump_bucketing` | every code ever mastered, 1,538 | a code the newest workbook omits is gone |
| `dump_oem_key` | every customer ever mastered, 174 | as above |
| `dump_zmat` | every code × plant SAP has extracted, 64,697 | a narrower extract shrinks the master |

`tsl_sales` was already read this way. Moving the other four is what changed the page, and
it changed exactly one thing: the transfer figures. 220 lines became 255, 1,898.021 MT
became 2,128.824, and in-transit 415.952 MT became 438.623 — July's transfers, which the
ledger had been holding and the pipeline had not been reading. Everything else in
`data.json` is identical.

### 1a.1 Reading a table back as the frame the pipeline expects

The pipeline addresses every column by the header the file wrote — `CUSTOMER  CD` with
two spaces, `Material No` with a non-breaking one, `Chamferring ` with a trailing space.
The views name their columns in snake case, because an Excel header is not an identifier
and quoting them would push that onto every query anybody ever writes.

`config/dump_columns.json` is the mapping between the two. It is generated by
`tools/generate_dump_views.py --write`, beside the view DDL, from the same read of the
same file — the DDL says which position becomes which name, and the manifest says which
name was which header. It cannot be derived at refresh time, because a cloud run has no
`dumps/` folder to read the headers off, so it is committed and `--check` fails if it
drifts.

Three rules govern the read back, and each was wrong in an earlier form:

- **What the table says a column is, is what it is.** A view column typed `text` is read
  back as text even where today's file happens to hold numbers there. Re-guessing the type
  from whichever extract arrived this morning is what makes a column int64 on Tuesday and
  object on Wednesday, and it is exactly what moving onto the tables is meant to end.
- **A canonicalised column is the exception**, because there `text` is not a statement
  about the column — it is how `plant_code` and `material_code` are given something to
  work on. The `_raw` column beside the canonical one is revived by a round trip: `'788'`
  is the text of the number 788 and becomes one, `'0788'` is not the text of any number
  and stays the string it has to stay.
- **A date is revived the same way.** JSON has no date type, so a Timestamp is stored as
  its own ISO text and comes back indistinguishable from a cell that held that text.
  `2026-07-14T00:00:00` round-trips and becomes a Timestamp; `2026-07-14` does not and is
  left alone. Without this a whole column of dates reads as text, every `.dt` accessor
  downstream stops working, and a date comparison silently becomes a string comparison —
  which orders `2026-1-9` after `2026-10-9`.

### 1a.2 The one thing a view gets wrong that no read can put right

A view's column types are baked from one file in `dumps/`, once. `yf65.xlsx` there writes
the accounting document number as a **number**, so the view was generated `dump_numeric`.
The uploaded `yf65.XLSX` writes the same column as **zero-padded text**, `0071029066`, and
`dump_numeric` strips the padding in SQL — before any read can see it. It reached the
page: the overdue drill-down showed `DP 36388067` where the invoice is `DP 0036388067`, in
a document people paste into a mail. Sixteen columns across five slots had the same fault;
`000000000110102155` was reading as 110102155 and `00001` as 1.

Two things follow, and both are load-bearing:

- **Identifier columns are typed by name**, in `generate_dump_views.TEXT_COLUMNS`, rather
  than by whichever file was to hand. An account number, a document number, a line item
  and a plant are never added up, so nothing is lost by holding them as text.
- **`tools/compare_table_sources.py --drift` asks the question of every column of every
  slot**, against the uploads actually held: which columns does a view type numeric while
  the file writes them padded? Anything it names belongs in that set. Nothing about this
  failure is loud — the view keeps working and the column keeps a plausible value — so
  the check is the only way to see it.

### 1a.3 zmat is keyed on the row, not on the code and the plant

zmat has no natural key: no combination of its 24 columns is unique. Keyed on
`(material_code, plant)` the table dropped 1,104 rows the file carries. They read as noise
— an end finish and a surface finish swapped, a specification written `10` on one row and
`010` on the next — and they are not. The pipeline identifies a material by its code, its
description and an attribute key built from both diameters, the thickness, the
specification and both finishes (§5e), so two rows that pair calls the same are two
different materials to everything downstream.

Measured, reading the pipeline off the table against off the sheet: **nine stock rows
stopped resolving to a bucket**, the STR plan lost two lines, a long-length SKU's
signed-off tonnage read 4.925 MT against a true 7.205, and the missing-mappings queue
gained a row that is not missing.

So the third part of the key is a digest of the row's own content, written by
`sources._row_digest`. Byte-identical repeats still collapse — 481 of them — and anything
the file wrote differently is kept: 64,697 rows against the 64,074 the old key allowed.
`source_seq` rides along and is what the table is read back in order of, because the
pipeline deduplicates again with `keep="first"` and "first" has to mean the row the sheet
wrote first.

## 2. Important data findings

### 2.0a A sheet's own grand total, summed as if it were data

The RM tracker's `TVSM` sheet ends with its own grand total — row 93 on the 31 July
file: no key, `VSM Requirement` blank, `VSM Sales` 990.836 and `VSM Stock` 2,335.240,
each repeating the whole column.

Every per-bucket figure groups on the key, and the total row has none, so all of them
step past it and stay correct. **Only a whole-column sum sees it**, which is why it went
unnoticed until a card was built on one: *Sales to TVSM* read 1,981.672 MT — exactly
twice the truth of 990.836.

Identify such a row by what makes it a total, not by where it sits: **it carries no key
and its value equals the sum of every other row in that column.** Position is not
reliable — the sheet has a blank row after it, and a genuine keyless line carrying
1.468 MT sits above it. Drop it at the read, so no consumer can sum it, and report what
was dropped in `qc_summary.json` so the figures reconcile against the workbook by eye.

The `vsm stock` sheet in the same workbook carries no such row; the WIP dump carries
several and has been handling them since the beginning, on the same principle.

### 2.0 A bucket with a trailing space is a different bucket

`Bucket` is the join key every view shares, so it cannot depend on typing. The RM
tracker's `TVSM` sheet wrote `25.4-0-2.5-ERW 1-FC ` on one row — one trailing space. It
renders identically to `25.4-0-2.5-ERW 1-FC` and is a different string, so it became its
own long-length tracker row and its own stock pool:

| | `25.4-0-2.5-ERW 1-FC` | `25.4-0-2.5-ERW 1-FC ` |
|---|---:|---:|
| VSM requirement | 56.000 | 0 |
| VSM sales | **0** | **60.304** |
| Balance | 64.046 | — |
| Risk | Low | No demand |

The bucket reported a 56 MT VSM gap it had already dispatched, and a second row appeared
in the tracker with no demand, no stock and 60.304 MT of sales against nothing. The
headline cards were unaffected — they sum the sheet's columns rather than the buckets —
which is exactly why it survived: nothing reconciled.

Normalise every bucket as it enters from a sheet: trim it, collapse runs of whitespace,
and treat a non-breaking space as a space (the same cells carry `\xa0`). Apply it to
`Bucketting` `Bucket` and `CTL Bucket`, `Schedule July` `Bucket` and `CTL Bucket`, and
the RM tracker's `key` on both the `TVSM` and `vsm stock` sheets — everywhere a bucket
enters, not only where a sheet has been seen to be dirty. A test asserts each of those
six columns goes through `norm_bucket`.


1. **Material codes stored as text are corrupted on read, not in the dump.** `pandas`
   infers a float dtype for code columns stored as text and silently drops the last
   digit: `3907863` reads as `3907860` on 3,603 of 3,989 sales rows, and `111120634`
   as `111120630` on 626 of 706 WIP rows. The dumps themselves are correct — the raw
   cells hold `000000000111120634`, matching SAP exactly.

   Read `sales.XLSX` → `MATERAIL NUMBER` and `wip ystockn.XLSX` → `Material No` with
   an explicit string dtype. Those two columns are the only affected ones: customer
   codes, SO numbers, billing documents, `PLANT STOCKS` materials, `rfd_4731` codes,
   `Bucketting`, `Schedule July` and `zmat` all read correctly.

   This corruption is what made the material number look unusable as a join key and
   made one code appear to carry several unrelated descriptions. Reading the column as
   text lifts TVS sales bucket resolution from 96.4% to 99.71% and clears that warning
   from the publication banner. Verify a code against SAP before concluding a dump is
   wrong: here the reader was at fault, not the file.

2. **TVS mapping coverage is usable but needs an exception queue.**
   - TVS sales bucket resolution: **96.36%**
   - TVS plant-stock bucket resolution: **98.26%**
   - WIP bucket resolution: **89.63%**
3. **Stock is a shared pool.** A long-length bucket can support multiple customers and finished lengths. Repeating the full stock on every customer row and then summing the rows will double-count stock.
4. **Transit appears twice in the stock file.** `PLANT STOCKS` carries 100 rows whose `CUSTOMER NAME` is `TRANSIT STOCK`, and the separate `TRANSIT STOCK` sheet holds 99 of the same batches with identical tonnage. Read `PLANT STOCKS` only; consuming both double counts. `transfer.XLSX` remains movement history and is never added.
   The `Plant` column on those rows is the receiving plant. `PLANT STOCKS` has no despatch-plant column — `Storage location` is uniformly `R001` for them — so the despatch plant is not recoverable from the sheet the pipeline reads.
5. **Avoid 4731 double counting.** Use RFD 4731 as the CTL source and exclude plant 4731 CTL rows from `PLANT STOCKS`.
6. **The old `TVSM LL Tracker.xlsx` is not safe to reuse directly.** Its `GAP current month` formulas contain broken `#REF!` references.
7. **`Schedule July` contains only TVS customers.** All 396 grouped lines resolve to OEM `TVS`, so TVS-scoped totals equal sheet totals today. Scope the TVS filter explicitly anyway; publish `all_oem_schedule_mt` beside `tsl_schedule_mt` so a non-TVS customer entering the schedule is visible immediately rather than silently inflating the cards.
8. **`Direct` is not a customer group; it is the Megh Steels conversion agent.** The group holds exactly three codes, each naming the OEM it converts for: 943209 `- TVS A`, 943210 `- HMSIL`, 943211 `- RE`. Routing each to its named OEM dissolves `Direct`, leaves the sales grand total unchanged, and makes the sales-summary `TVS` row equal the TVS total sales card.
9. **Conversion-agent stock is invisible without an explicit override.** Megh Steels holds 426.9 MT of long length in `PLANT STOCKS` under OEM `Direct`. A TVS-only pool filter hides all of it: bucket `42.7-0-4-ERW 1-FC` reported zero available stock while 211.6 MT sat at plants 788, 8406 and 4731. Attribute proxy-customer stock to the TVS pool through a separate `pool_oem`, keeping the OEM key result intact for sales reporting.
10. **The `CTL/LL` flag and the 3.5 m rule each miss cases.** No row is flagged `CTL` at 3.5 m or longer, but 16 rows totalling 18.4 MT carry a length range in the description (`...X04-05`) and sit at `LENGTH` 0 while correctly flagged `LL`. A length-only rule strands those; take the union of both signals.
11. **`yf65` payment terms are inconsistent, and its flags cannot be trusted.** `Net Due Date − Document Date` is 0 days on 1,896 rows, 45 on 1,052 and 51 on 218, so the file's own `Due Status` mixes terms. Apply the governed 47-day term from the invoice date instead. `Nature = BILLING` is exactly doc types `RV` (1,288) and `RD` (39). `Billing Doc` is the invoice number and is populated on all 1,327 billing rows and none of the 1,792 `AB` rows; `Document Number` is the accounting document.
12. **`rfd_4731` lists more codes than it stocks.** 120 distinct `CTL Code` values appear but only 37 carry a positive `RFD Qty.`. Reconcile on positive quantity only; matching on mere presence understates the write-off list. On the 24 July dump 82 of 101 SAP 4731 CTL materials (79.119 MT) have no RFD backing.
13. **Resolve a sales order from the most specific evidence available.** A sales order belongs to a customer, so quoting another customer's order number on a dispatch plan would be wrong. Try in order: same customer and material code, same customer and CTL bucket, same material code, same CTL bucket. Material tiers only became usable once codes read correctly per finding 1; adding them lifts resolution from 277 to 291 of 396 lines and open-balance lines carrying an order from 201 to 215 of 320, gaining 13 lines and losing none. Three lines also moved to a stricter rule, one of which had been borrowing another customer's order.
14. **Plant is named by location in the schedule and by code everywhere else.** `Schedule July` uses `Hosur`, `Khopoli`, `JSR`; stock and sales use `0789`, `0788`, `4731`, `8406`, `0056`. Sales gives the mapping directly — `Hosur Tube Plant → 0789`, `Khopoli Tube Plant → 0788`, `Tata Steel Ltd INDICO INFRA → 4731`. Learn it from matched lines rather than hardcoding it.

15. **Guard a code-derived bucket against the description.** One WIP code appearing to
    carry several unrelated descriptions was the read artefact in finding 1, not a
    property of the dump. The guard is still worth keeping: accept a code-derived
    bucket only when the description's own OD, ID and thickness agree with it, and
    leave the row unresolved otherwise, so a genuine mapping error surfaces in the
    queue rather than silently placing material in the wrong bucket.

    The dump also ends with a plant subtotal and a grand total, both carrying no
    material code and each repeating the file's entire tonnage: 1,108.602 MT twice
    against 1,108.602 MT of real rows, so the file appears to hold 3,325.806 MT. Drop
    rows without a material code before anything else.

    Publish what remains unresolved as an assignment queue on the missing-mappings tab,
    with the reason, the bucket the material code claimed, and a dropdown of governed
    buckets. On the 27 July set that is 25 lines and 126.798 MT: 111.024 MT with no
    governed mapping at all and 15.774 MT whose code bucket contradicts the description.

    Apply this guard to WIP only. `PLANT STOCKS` descriptions are not uniform — a
    `TUB-I-` description reads OD x ID x length rather than OD x thickness x length,
    and thicknesses such as 1.42 fall outside the grouping table — so the same check
    raises false positives there and must not be used until those formats are handled.

## 3. Governed keys

### 3.1 Canonical code rules

- Customer code: trim spaces, remove Excel `.0`, preserve the numeric code as text.
- Material code: trim spaces and remove Excel `.0`.
- Customer name: uppercase, remove punctuation, collapse spaces.
- Plant: store as text (`0789`, `0788`, `4731`, `8406`, `0056`).
- UoM: uppercase and standardize `m` to `M`.

### 3.2 Product family key — `Bucket`

`Bucket` represents the mother-tube family and excludes finished length:

```text
OD | ID | normalized thickness | normalized grade/specification | end condition
```

Use the governed `Bucketting` table where available. For unmapped materials, infer the bucket using a unique product-equivalence match in `zmat` based on:

```text
OD + ID + normalized thickness + material specification + end finish + surface finish
```

Confirmed normalization rules:

- OD `22.20` and `22.23` → `22.23`
- Surface `AW/AP/HR` → `AW`
- Surface `AN/BH/NR` → `AN`
- Thickness groups:
  - `1/1.01/1.02 → 1`
  - `1.2/1.21 → 1.2`
  - `1.5/1.6/1.63 → 1.6`
  - `1.9/1.95/2/2.03 → 2`
  - `2.25/2.32 → 2.25`
  - `2.3/2.34 → 2.3`
  - `2.41/2.45/2.5 → 2.5`
  - `2.6/2.65 → 2.6`
  - `2.7/2.75/2.8 → 2.8`
  - `3/3.02 → 3`
  - `3.4/3.5 → 3.5`

Mappings that resolve to `check TDC`, `No Key`, multiple conflicting buckets, or missing critical attributes must enter an exception queue and must not be silently assigned.

### 3.3 Finished-length key — `CTL Bucket`

```text
CTL Bucket = Bucket + "|" + normalized finished length in metres
```

- `CTL`: length below 3.5 m; use actual normalized length.
- `LL`: length at or above 3.5 m; retain the `Bucket` as the operative planning key.

Length at or above 3.5 m is the definition of a long length. The stock file's
`CTL/LL` flag implements that rule but is not sufficient on its own, so classify
plant stock from both signals:

```text
is_long_length = (CTL/LL flag = LL) OR (LENGTH >= 3.5)
is_ctl         = (CTL/LL flag = CTL) AND (LENGTH < 3.5)
```

Take the union because rows that carry a length range in the description (for
example `...X04-05`, meaning 4-5 m) leave the `LENGTH` column at 0 while being
correctly flagged `LL`. A length-only rule would strand that stock; a flag-only
rule would strand any row where the flag is wrong. Requiring both signals to
agree before treating a row as CTL keeps long material out of the exact-length
pool.

### 3.4 Customer schedule key

```text
Customer Schedule Key =
OEM + Customer Code Set + Bucket + CTL Bucket + UoM + Supply Plant
```

`CUSTOMER CODE` can contain multiple SAP customer codes separated by `|`. Expand this list only for joining sales; preserve the original code set on the output.

## 4. Tracker A — customer-wise schedule, sales, balance, CTL stock and LL stock

### 4.1 Schedule fact

Read active rows from `Schedule July` where `SCHEDULE in nos > 0`.

Group by:

```text
OEM
Helper Customer
Customer Code Set
Bucket
CTL Bucket
UoM
Supply Plant
```

Use the workbook’s `SCHEDULE IN MT` when present. Otherwise:

```text
kg_per_m = π × (OD − thickness) × thickness × 7.85 / 1000
Schedule_MT = kg_per_m × length_m × schedule_nos / 1000
```

**Bucket recovery for blank schedule lines.** `Schedule July` leaves some lines
with no `Bucket` or `CTL Bucket` even though they name a `MATERIAL NO`. Where the
sheet is blank, map that code through `Bucketting` and take its bucket and CTL
bucket; where `Bucketting` has the bucket but no CTL bucket, derive the CTL bucket
from the bucket plus the code's governed length. The sheet's own value always wins,
so this only fills gaps. On the 27 July set it recovers two Rajsriya Hosur lines
worth 17.889 MT — codes `4141595` and `4228296` — which would otherwise carry
demand that reaches no bucket and disappears from the long-length and STR views.

Lines with neither a `Bucket` nor a `MATERIAL NO` remain unbucketed. They cannot be
matched to stock; report the tonnage rather than absorbing it.

### 4.2 Sales mapping and aggregation

Material mapping priority:

1. normalized material description → unique `zmat` product → governed bucket;
2. physical-attribute equivalence key → governed bucket;
3. raw sales material number only when a unique match exists;
4. otherwise exception queue.

Aggregate sales by:

```text
Customer Code + CTL Bucket
```

Sales quantity:

- schedule UoM `NOS` → sum `qty in no`
- schedule UoM `M` → sum `Domain for z_qty_meter`
- sales MT → sum `Quantity / 1000`

For a schedule row containing multiple customer codes, sum sales across all codes in that row’s code set.

### 4.3 Balance

```text
Balance_Qty = Schedule_Qty − Sales_Qty
Balance_MT = Schedule_MT − Sales_MT
Open_Balance_MT = max(Balance_MT, 0)
Over_Dispatch_MT = max(−Balance_MT, 0)
Compliance_% =
    if Schedule_MT > 0
    then min(Sales_MT / Schedule_MT, 1)
    else null
```

Keep over-dispatch separate; do not force the displayed balance to zero without preserving the excess.

### 4.4 CTL stock

Use only these CTL sources:

```text
0789 CTL = PLANT STOCKS where Plant = 0789 and CTL/LL = CTL
4731 CTL = rfd_4731 RFD Qty. mapped by CTL Code to CTL Bucket
CTL Stock Pool NOS = 0789 CTL NOS + mapped 4731 RFD Qty.
```

Do not add CTL rows from any other plant. Do not add plant-stock 4731 CTL on top of RFD.

Stock must be split into:

- **dedicated stock:** stock customer maps to the schedule customer;
- **shared/other stock:** same OEM and CTL bucket but not assigned to that customer.

Allocation order:

1. dedicated CTL stock to its customer;
2. shared CTL stock by earliest commitment date;
3. if commitment date is absent, allocate proportionally to open balance.

```text
Proportional_Allocation_i =
min(
  Open_Balance_i,
  Shared_CTL_Pool × Open_Balance_i / Total_Open_Balance_for_CTL_Bucket
)
```

The raw pool may be displayed on schedule lines for context, but label it **“Pool — do not sum.”**

### 4.4a Pool attribution for the TVS proxy customer

Customer 943209 (`MEGH STEELS PRIVATE LIMITED - TVS A`) processes for TVS but is
classified `Direct` in `OEM_key_1_rev codes`. Attribute its stock to the TVS pool:

```text
Pool_OEM = "TVS" if stock customer is a TVS proxy customer else OEM key result
```

Key every CTL and LL pool, and every pool drill-down, on `Pool_OEM` so TVS
schedule rows can see this stock. Keep `Pool_OEM` separate from the OEM key
result so the sales-by-OEM view continues to report the OEM key unchanged.
Without this, TVS long-length buckets stocked at Megh Steels report zero
available stock even when the plant holds material against them.

### 4.4b Transit stock

`PLANT STOCKS` marks pipeline stock with customer name `TRANSIT STOCK` instead of
an owning customer. Include it in available stock as a shared bucket-level pool:

```text
Shared_Transit_MT = sum PLANT STOCKS MT where customer = TRANSIT STOCK, by Bucket
LL Stock Pool = plant LL by Pool_OEM + mapped WIP ystockn + Shared_Transit_MT
```

Because transit has no owning customer it behaves like WIP: shared, bucket-level,
and `do_not_sum` across customer rows. Remove these rows from the owned CTL and LL
pools so the same tonnage is never counted twice.

Read stock from the `PLANT STOCKS` sheet only. Do not read the `TRANSIT STOCK`
sheet: it describes the same material — 99 of 100 batches match with identical
tonnage — so consuming both would double count, and `PLANT STOCKS` already carries
the full set.

Label these drill-down rows `Transit` and show the `PLANT STOCKS` `Plant` value as
the source plant. Note that this is the plant the stock is booked against, not the
despatch plant; `PLANT STOCKS` carries no despatch-plant column, and `Storage
location` is uniformly `R001` for transit rows.

`transfer.xlsx` is movement history and is never added to the customer or LL
transit snapshot. It is read for the transfers view and the STR plan only
(sections 5f and 5g).

### 4.4c Plant 4731 CTL reconciliation against RFD

`rfd_4731` is the authoritative list of CTL stock physically available at plant 4731.
Whatever `PLANT STOCKS` holds there above what RFD backs is not physically present
and has to be written off.

**Reconcile on weight, and on quantity rather than presence.** Two defects hid behind
a presence-only flag:

- **A material can be in RFD and still be overstated in SAP.** `3136139` holds
  10.637 MT at 4731 against 10.131 MT in RFD; calling the line "Backed by RFD" leaves
  0.506 MT on the books that is not there. Eleven materials are partly backed this
  way on the 29 July set.
- **The NOS column at 4731 is kilograms.** SAP holds 4731 and 8406 in weight only and
  repeats `KG` in `NOS` on all 167 of the 4731 cut-length rows — base unit `KG`
  throughout. Comparing that to RFD's real piece count is kilograms against units:
  `3910648` reads 6,123 "nos" against 3,000 pieces in RFD and looks half short, when
  the true comparison is 6.123 MT against 6.321 MT and it is backed in full. Plants
  0789 and 0788 carry genuine piece counts, so the defect is specific to the two
  external locations.

So compare **MT to MT**, state both sides, and publish no piece count for a plant that
does not hold one:

```text
RFD backs 10.131 of 10.637 MT (5,500 nos) - write off 0.506 MT
Fully backed by RFD - 1.171 MT (2,500 nos)
Fully backed - RFD holds 6.321 MT (3,000 nos) against 6.123 MT in SAP,
               0.199 MT more than SAP shows
Not in RFD - write off 3.573 MT
```

Where one RFD line names several SAP codes, share its weight between them in
proportion to what SAP holds, so the same physical stock can never back two materials
at once, and say so in the comment. Treat a difference under 10 kg as rounding.

Unbacked tonnage is then the sum of the gaps, not the sum of whole unbacked lines:
49.479 MT across 56 materials on the 29 July set, against 39.923 MT across 44 that a
presence-only test reported.

**`CTL Code` is not a reliable key.** It is blank on 15 of the 60 rows that carry
stock — 34,495 pieces, 32.293 MT on the 28 July file — and where it is populated it
may hold several codes separated by slashes (`3534935/3499239/3682124/3954021`) or a
note (`6 M CODE`). Keyed on the raw cell, all of those back nothing, so a material
that is physically at the plant is told to write itself off. `57.15 x 3 x 460` is the
worked example: RFD line 81 holds 5,500 pieces of it, and SAP material `3136139` was
reported "Not in RFD - remove from SAP".

Resolve the row in three steps:

1. **Split the code cell** on `/`, `|` or `,`, keep the purely numeric entries, and
   take the first that `Bucketting` governs. Carry every listed code, because one RFD
   line can back several SAP materials.
2. **Read the row's own size.** A round row is `OD x thickness x CTL`. A rectangular
   row puts its two outer dimensions in `Section` (`40X30`, `50*30`, `40x20`) and
   leaves `OD` holding the equivalent round diameter, so `Section` is the only place
   its real size appears — matching on `OD` for those rows is wrong.
3. **Match that size against SAP.** Index the 4731 cut-length materials in
   `PLANT STOCKS` by OD, ID and thickness read out of each description plus its
   `LENGTH`, and look the RFD row up in it.

```text
key = (OD, ID, thickness, cut length in m)
ID is 0 for a round tube, on both sides
several SAP codes can share a key -> all of them are backed
the pool takes the recovered bucket only when those codes agree on one
```

On the 28 July file this recovers 10 rows, 26,200 pieces and 28.454 MT, backing 12
SAP materials, lifting resolved rows from 39 to 44 of 60 and cutting the write-off
list from 51 materials (49.419 MT) to 41 (35.652 MT). The 16 rows that still reach no
bucket (32,995 pieces, 19.452 MT) are listed in the missing-mappings view with the
reason each failed, split between a size SAP does not carry at 4731, a code that
reaches no governed bucket, and a size match whose materials carry no bucket either.

**A missing bucket must not build a CTL bucket.** `make_ctl_bucket` guarded its
bucket argument with a truthiness test, and `not float("nan")` is `False`, so a row
with no bucket produced the string `"nan-0.46"`. That string passes `valid_bucket`,
counts as resolved, and matches nothing — so its stock leaves circulation while every
resolution figure still reads 100%. Before the guard was fixed, RFD 4731 reported 60
of 60 positive rows resolved when the true figure is 39, and the 0789 cut-length pool
carried 74,152 pieces in buckets no schedule line could ever reach. Test the argument
for NaN explicitly, and let the honest unresolved count raise its warning.

Beyond the flag, this is a bookkeeping reconciliation only. Coverage already ignores
4731 CTL rows from `PLANT STOCKS` and uses RFD quantity instead, per section 4.4, so
flagging changes no availability figure; the size recovery does, because it puts
10,000 recovered pieces into buckets the schedule can match.

### 4.4d Bucket mapping coverage by source

Every inventory source maps its material to a governed bucket, and whatever fails to
map is stock the coverage views cannot see. Report the shortfall per source rather
than only as a global resolution rate, because the three sources fail for different
reasons and are fixed in different places:

| Source | File | Mapped through |
| --- | --- | --- |
| `PLANT STOCKS` | `stock.xlsx` | material code, then description |
| WIP ystockn | `wip.xlsx` | material code guarded by the description, then description |
| RFD 4731 | `rfd_4731.xlsx` | `CTL Code`, then size match against 4731 SAP stock |

```text
unmapped % = MT reaching no governed bucket / MT in the source
```

On the 28 July file: `PLANT STOCKS` 556.894 of 2,564.689 MT (21.71%), WIP 127.189 of
1,129.531 MT (11.26%), RFD 4731 19.452 of 74.443 MT (26.13%).

`Bucketting` governs the TVS range, so material held for other customers maps at a
lower rate by design — the plant-stock figure is dominated by non-TVS holdings, and
the drill-down names the customer each line is held for so that is visible rather
than assumed. Read the figure as the size of the blind spot, not as an error rate.

Each source's unmapped line items are queued in the missing-mappings view in their own
table, alongside the WIP queue that already existed, so the rows to fix in
`Bucketting` are in one place.

### 4.5 LL stock

For `LL` rows:

```text
LL Stock Pool =
plant LL stock by OEM + Bucket + mapped WIP ystockn by Bucket
```

Long length is shared across all customers and CTL lengths in the same bucket. It must not be treated as customer-owned until allocated.

```text
Residual_Need_After_CTL =
max(Open_Balance_MT − Allocated_CTL_MT, 0)
```

Allocate LL stock by commitment date, then proportionally where dates are unavailable.

Recommended customer output columns:

| Identity | Demand and sales | Inventory | Result |
|---|---|---|---|
| OEM, customer, code set, bucket, CTL bucket, plant | schedule qty/MT, sales qty/MT, balance qty/MT, compliance | dedicated CTL, shared CTL pool, allocated CTL, LL pool by plant, allocated LL, shared WIP | uncovered MT, stock status, exception reason |

### 4.6 Sales history for the selected customer

The tracker answers *how is this month going*. A buying meeting asks *is this month
normal, and what has quietly stopped being ordered*. Both live on the same tab.

**Two places, one source.** Each tracker line carries an **Avg month sales** cell — the
SKU's average month over the trend window, opening the month-by-month card — and a
**Sales history** table under the tracker lists every SKU the customer has bought, month
by month, whether or not it is on this month's schedule. The cell is an average, not the
window total: the figures beside it are one month of schedule and one month of dispatch,
and a six-month total set against them reads as a SKU running six times its real rate.
Averaged over the months that moved, so the cell, the history table's own average column
and the card all agree; the cell's tooltip names how many months that was. Both read `customer_sku_history`,
built from the same trend frame that feeds the Past sales trend tab, so the two tabs can
never disagree.

**Join on the customer's own SAP codes, never on the name and never through
`display_by_code`.** The trend frame names a customer as the sales file writes it
(`BALAJI PRESS PRODUCTS INDIA`), the schedule names it by Helper Customer
(`Balaji Press Product`), so a name join is a guess. `display_by_code` is the wrong
bridge for the opposite reason: it drops any SAP code used under more than one Helper
Customer, which is correct when the decision moves stock — an STR must never go to the
wrong customer — and wrong when it only displays history. Three codes are shared on the
31 July build (`129663` and `948721` across ELKAYEM AUTO Hosur and Rajsriya Automotive
Hosur, `189287` across Balaji Press Product and a one-line `ara` entry), and routing
through it left two real customers with an empty table across 45 tracker lines, which
reads as *bought nothing*. Read `customer_codes_key` instead — it is the codes joined
with `|`, and a customer may hold several legitimately.

**Where a code is shared, say so.** The same history lands under both names; the note
states which other customer it is shared with, so one book is never read as two.

**An empty table must name its cause.** `customer_history_notes` carries either the
shared-code list or a reason. *No sales under code 187702 in the history window* —
Sandhar Technology on this build — and *no code recorded* are different problems with
different fixes, and a blank table states neither.

**Per-SKU figures.** Months active counts the months the SKU actually moved, and the
average divides by that, not by the window. A SKU bought in two of seven months has a
two-month average; dividing by seven would read as a small steady line rather than an
occasional large one, and those are bought differently. The **On schedule** column marks
each history row against this month's tracker, and the scope filter slices it three ways:
every SKU bought, on this month's schedule only, bought before but not scheduled now.

**The tracker's Avg month sales column is not summable.** One SKU scheduled at two
plants is two tracker lines carrying the same history, so a column total would double
count — and an average is not addable in the first place. The history table's own totals
row is safe: it is one row per SKU.

**A drill-down whose rows are months closes on an average month, not a total.** Adding a
history gives the size of the window, not the size of a month: a bucket billed steadily
at about 130 MT a month closed on 928.982 MT, the eight-month total, which is not a
figure any schedule is read against. `LLHISTORY` and `SKUHISTORY` divide each summable
column by the rows listed — and those rows are only the months that moved, the same
denominator the tracker's own average column uses. The row is labelled **Average month**
so it is never read as a total. Every other card still totals: a stock pool, an order
book or a sign-off split is a quantity, and dividing it by its line count would mean
nothing.

**The long-length tracker carries the last complete month's billing.** The tracker sets
one month's schedule against one month's stock, which answers *are we short now* and not
*is this month normal*. The bucket's billing history already exists for the Past sales
trend tab, so the tracker shows the previous complete month beside the current one and
opens the whole window on a click, split between the ancillaries buying direct and Megh
Steel converting for TVS — a month where one replaced the other is not a flat month. Take
the last month *strictly before* the as-of month, not simply the last month held: the
window runs to the month in progress, and five days of August set against a full July
reads as a collapse. The column header names its month, because two adjacent columns
holding different months and labelled only by position invite exactly one mistake. This
figure is TSL's own billing and matches `tsl_sales_mt` plus the Megh 943209 line; it does
**not** carry Megh's dispatch to TVSM, which the current-month **Total sales** column
does. The two answer different questions and are not meant to tie. A bucket never billed
in the window carries no button: a card that opens on nothing is worse than a plain
figure.

**The Past sales trend tab reads in tonnes or pieces, on one switch.** A cut length is
ordered in pieces and a long length by weight, so a trend held only in tonnage answers
half the question. Every frame on the tab carries both — `months_nos` and `total_nos` on
the bucket and customer-SKU tables, `direct_nos`/`megh_nos`, `segment_totals_nos`, and
`total_nos` on each month — and one control at the top reads the whole tab in the chosen
unit: headline cards, month strip, bucket table, SKU table and plant summary together.
**One switch, not one per table**: the plant summary had its own, and two controls that
can disagree about what a page is showing are worse than none. Month columns take their
precision from it, pieces being whole numbers, and a pieces figure carries `nos` rather
than `MT` because a bare 2,100 beside a bare 3,140,000 is exactly the ambiguity the
switch exists to remove. *Not bucketed* is shown only in tonnes: it has no piece count,
and a blank would read as zero pieces. The breakup cards carry both units whatever the
tab is set to, so switching never changes what a breakup says.

**A cut length's history is shown in pieces as well as tonnage.** A CTL size is ordered
in pieces — the customer's own schedule is written that way — so a history in tonnage
alone is in the wrong unit: 12.197 MT of a 2.59 m piece is a figure nobody plans against
and 4,710 pieces is. Both the customer tracker's sales history and the Past sales trend
tab's SKU table carry `months_nos` beside `months`, taken from the same frame as the
tonnage so the two can never disagree, and the page prints the pieces under the tonnage
in each month cell, in the totals row, and in the month-by-month drill-down. Long-length
rows are left alone: they are bought by weight, and a piece count there says nothing a
buyer acts on. Pieces are averaged over active months in the totals row, not added, for
the same reason the tonnage is. A cell holding two figures reads back as one run of
text — `12.197 MT4,710 nos` parses as neither — so it states what it pastes as, and the
clipboard carries the tonnage; the pieces are their own column in both tables.

**A per-row rate is averaged in the totals row, never added.** Months active and the
average month are rates, and the totals row adds every other column, so it added those
too: a customer whose busiest month was 260 MT and whose quiet ones were 129 showed an
"average" of 214.291 MT, because a SKU selling in three months and one selling in eight
each contributed one figure, and the month count reached 197 over an eight-month window.
Both are read off the month columns beside them instead — the months the visible rows
sold in at all, and the tonnage over exactly those months — so the totals row obeys the
same only-count-months-that-moved rule as the rows above it, and follows the filters and
the scope selector with them. The row is labelled **Total · avg** where it carries both,
so an averaged cell is not read as one more thing that was added up. The month columns
themselves are still totals: what every SKU sold in that month is a real quantity.
Because the window's last month is the one in progress, that month's column is a part
month and pulls the average down; it is counted, because excluding it would make the
totals row disagree with the per-SKU averages directly above it.

Dashboard interaction:

- Show a filtered subtotal row beneath every table header, pinned while scrolling. Mark
  summable columns explicitly rather than inferring them: the shared CTL and LL pool
  columns must never be totalled because the same pool repeats across customer rows,
  and coverage days, stock age and days overdue are not additive. Sum the unrounded
  values, not the rendered text, so hundreds of rows do not accumulate rounding error.
- Give every tab's table a copy button that puts the table on the clipboard as
  tab-separated text for pasting into a spreadsheet, including the drill-down modal.
  Strip display grouping separators and unit suffixes from purely numeric cells so
  they paste as numbers; leave dates and codes untouched. Where a tab shows more than
  one table, copy them together under their headings.
- Drill-down column layouts are declared per detail type, so batch and invoice
  breakups carry their own headings rather than the default source/SKU layout.
- Total each quantity column of a drill-down over the field that column displays.
  Every layout had one quantity column until the sign-off breakup arrived with three
  — signed, not signed, order — and one total computed from `qty` and repeated across
  them showed 22.23-0-2-ERW 1-PE as 337.71 MT signed, 337.71 MT not signed and
  337.71 MT ordered: a row asserting both that everything was signed off and that
  nothing was. Formula breakups (`LLCOVERAGE`, `LLGAP`, `LLGAP45`, `BALANCE`) list
  inputs and a result and still carry no total at all.

- Make the schedule, sales, and open-balance cards clickable, each opening its own breakup: schedule into TSL and TVSM components, sales into contributing customers with the rule that admitted each, and open balance into the two totals it nets.
- Scope every global top card to OEM TVS. The "TVS total schedule" card shows Total_Monthly_Demand_MT = TSL_Schedule_MT (Schedule July rows where OEM = TVS) + VSM_Schedule_MT (TVSM sheet VSM Requirement total).
- The "TVS total sales" card shows all TVS dispatch, not just schedule-matched dispatch:

```text
TVS_Total_Sales_MT =
  sum sales MT where OEM_key_1_rev OEM = TVS
+ sum sales MT where customer code = 943209
```

  Use the direct `OEM_key_1_rev codes` result so a Boiler material-group override cannot drop a TVS customer sale. Customer 943209 (Megh Steels - TVS A) maps to `Direct` in the OEM key but supplies TVS, and the two sets are disjoint, so they add without double counting. The card opens a customer-level breakup keyed `SALES|TVS_TOTAL`.
- The "TVS open balance" card nets the two headline totals so the card row reconciles:

```text
TVS_Open_Balance_MT = Total_Monthly_Demand_MT − TVS_Total_Sales_MT
```

  Derive it from the rounded published components, not the raw sums, so the displayed cards subtract exactly. Leave it unclamped at aggregate level so over-dispatch stays visible. The TSL-only figure (TSL schedule minus schedule-matched sales) is retained as `summary.tsl_open_balance_mt`.
- The "TVS active lines" card stays on TSL schedule rows only.
- Render the top-card row only on the customer tracker and long-length tracker views. Hide it on the missing-mappings and sales-summary views, which report across all OEMs.
- Require selection from a customer dropdown before rendering customer rows.
- Show SKU rows where schedule quantity or dispatch quantity is non-zero.
- When a customer is selected, replace the global top-card values with customer-specific totals: schedule MT, sales MT, open-balance MT, unique active SKU count, LL-covered SKU count, and LL-uncovered SKU count.
- Count an LL-uncovered SKU once per unique `CTL Bucket` when it has positive open balance and `LL Stock Pool = 0`. Count an LL-covered SKU once when it has positive open balance and `LL Stock Pool > 0`.
- Keep customer-card totals based on the complete selected-customer dataset so typing in the SKU search box does not change the customer totals.
- Render CTL pool quantity as a NOS button and LL pool quantity as an MT button.
- Each stock button opens a drill-down card containing source/plant, SKU/material description, material code, quantity, and unit.

## 5. Tracker B — TVSM long-length coverage

### 5.1 Demand

At `Bucket` level:

```text
TSL_Schedule_MT = sum TVS Schedule July schedule MT
VSM_Schedule_MT = sum TVSM sheet VSM Requirement
Total_Monthly_Demand_MT = TSL_Schedule_MT + VSM_Schedule_MT
```

Sales:

```text
TSL_Sales_MT = sum July TVS sales MT by Bucket
VSM_Sales_MT = sum TVSM sheet VSM Sales
Total_Sales_MT = TSL_Sales_MT + VSM_Sales_MT
Remaining_Month_Demand_MT =
max(Total_Monthly_Demand_MT − Total_Sales_MT, 0)
```

Demand gap. Net each stream against its own sales, then add:

```text
TVS_Gap_MT   = max(TSL_Schedule_MT − TSL_Sales_MT, 0)
VSM_Gap_MT   = max(VSM_Schedule_MT − VSM_Sales_MT, 0)
Total_Gap_MT = TVS_Gap_MT + VSM_Gap_MT
```

Floor each component before adding. Netting the streams together first lets
over-dispatch on one hide a real gap on the other: on bucket `22.23-0-2-ERW 2-FC` TVS
is over-dispatched by 0.98 MT against a 60.00 MT VSM gap, which a combined net would
report as 59.02 MT. Across all buckets the difference is 2,244.399 MT against
2,227.438 MT. The gap column opens a breakup showing both streams and the total.

### 5.2 Available long-length stock

```text
TSL_LL_Stock_MT =
LL stock for OEM = TVS, summed by Bucket and shown separately by plant

VSM_Stock_MT =
TVSM sheet VSM Stock

Firm_Available_LL_MT =
TSL_LL_Stock_MT + VSM_Stock_MT
```

### 5.3 Coverage

Primary demand basis:

```text
Demand_Base_MT = Total_Monthly_Demand_MT
```

Future enhancement: use `max(current schedule, trailing three-month average sales)` after historical sales are loaded.

```text
Coverage_Days =
Total_LL_Stock_MT / Demand_Base_MT × 30

Current_Month_Shortage_MT =
max(Remaining_Month_Demand_MT − Firm_Available_LL_MT, 0)

Gap_to_30_Days_MT =
max(Demand_Base_MT − Firm_Available_LL_MT, 0)

Gap_to_45_Days_MT =
max(1.5 × Demand_Base_MT − Firm_Available_LL_MT, 0)
```

Risk bands:

| Coverage | Status |
|---:|---|
| `< 15 days` | Critical |
| `15–<30 days` | Low |
| `30–<45 days` | Watch |
| `≥45 days` | Adequate |

Only buckets with a valid demand base should receive a coverage status. Buckets without demand should be shown as `No demand`, not `Adequate`.

Recommended long-length output:

```text
Bucket and risk
Total schedule button
Total sales button
Total stock button
Coverage-days button
Gap-to-45-days button
```

Dashboard interaction:

- Sort buckets in ascending natural numeric order.
- Show TSL schedule and TVSM schedule from `RM Tracker_18092025.xlsx` inside the total-schedule drill-down.
- Consolidate plant LL + WIP ystockn + VSM stock into one total-stock MT button.
- The consolidated button opens a drill-down card with the contributing plant/RM tracker rows, SKU, material code, and quantity.
- Every one of the five metrics opens a drill-down card.

## 5b. Stock analysis view

Report physical `PLANT STOCKS` tonnage by plant in two separate tables:

```text
Cut length table  = rows where is_ctl,        grouped by Plant, sorted by MT desc
Long length table = rows where is_long_length, grouped by Plant, sorted by MT desc
```


Report material line items, not plant totals, grouped by plant, material and the
customer the stock is held for. Carrying the customer on the row is what makes
high-age stock actionable: it names who each aged lot can be liquidated to. Plant and
length type are filters above the tables, and
rows are ordered by descending stock age so the oldest material is first. Each row
shows plant, material code, description, oldest age in days, stock MT, high-age MT,
stock NOS and batch count. Both MT figures open a batch-level drill-down listing
batch, plant, material, description, the customer it is held for, the ageing date,
age in days, age at month end and tonnage.

High-age stock is judged at month end, not at the as-of date:

```text
Ageing_At_Month_End = Ageing days + (month end of as-of date − as-of date)
High_Age            = Ageing_At_Month_End > 60
```

Carrying the ageing forward matters on a mid-month refresh: at as-of 24 July 2026,
300.445 MT exceeds 60 days, but 402.517 MT will exceed it by 31 July. Reporting the
as-of figure would understate the month-end position the KPI is measured on.

This view covers the entire sheet, including transit rows and every OEM, so it is
intentionally wider than the approved coverage sources in sections 4.4 and 4.5. Its
CTL plus LL total reconciles to the positive-tonnage rows of `PLANT STOCKS`.

## 5c. Ancillary overdue view

Source: `yf65.xlsx`, which is optional — publish an empty view when it is absent.

A receivable falls due 47 days after its invoice date. This governed term replaces
both the per-document `Net Due Date` and the file's own `Due Status` flag, whose
payment terms vary by document (`Net Due Date − Document Date` is 0 days on 1,896
rows, 45 on 1,052 and 51 on 218).

```text
Due date     = Document Date + 47 days
Overdue rows = open items where as-of date > Due date
Ancillaries  = rows whose customer name resolves to OEM TVS through OEM_key_1_rev,
               after conversion-agent routing
Days overdue = as-of date − Due date
```

Apply the rule to every open item, not only those the file flags. Open credits —
credit notes, collections and other credit balances — therefore net against overdue
debits, giving each ancillary's net overdue exposure. Record the gross debit and
credit components per ancillary so the netting stays auditable, since netting can
leave an ageing bucket negative. Record them in `qc_summary.json` under
`overdue_analysis.total_debits` and `total_credits` rather than as columns on the tab,
where two more figures sat between the overdue and its ageing.

Count only billing documents:

```text
Billing documents = Doc Type in (RV, RD)
```

These are exactly the rows whose `Nature` is `BILLING` (1,288 RV plus 39 RD). Debit
balances, credit notes and collections are not invoices to chase, so excluding them
also removes the credit netting that could leave an ageing bucket negative.

Per ancillary report total overdue, document count, the oldest days overdue, and the
amount ageing beyond 90 days, sorted by descending overdue. Each amount opens an
invoice-level drill-down, oldest first, with invoice number, document, invoice date,
due date, overdue age in days, amount, and a closing total row. The invoice number is
`Billing Doc`; `Document Number` is the accounting document and is shown separately.

Report open payments and credit notes as one column beside the overdue, opening a
document-level breakup. An offset is a document that *reduces* what is owed, told by
its `Nature`, not by not being a billing document:

```text
Offsets = Nature in (CREDIT NOTE, OTHER CREDIT BALANCE, COLLECTION)
```

`Doc Type` cannot decide this — `AB` carries both `OTHER DEBIT BALANCE` and `OTHER
CREDIT BALANCE` rows. Debit balances are not offsets: they add to the exposure rather
than reducing it, and reporting 1,846 of them beside the credits made the figure a net
of two unrelated things and its breakup a list to read past. They are excluded from
the figure, its document count and its drill-down alike, so the figure adds up to the
lines behind it.

Both lists are whitelists, so a `Nature` nobody has seen is not quietly counted.
Everything neither billing nor an offset is tallied per `Nature` into
`qc_summary.json` under `overdue_analysis.excluded_natures`, with its document count
and amount, so setting the debit balances aside is a figure somebody can check rather
than a disappearance.

### 5c.2 Invoice remarks

Why an invoice is late is the only part of an overdue row that is judgement rather
than arithmetic, so it is the one thing on this view a person writes. A remark is held
against the invoice number in `public.invoice_remarks` and is **not scoped to a
build** — every refresh replaces the build wholesale and drill-down rows key on a sort
position, so a remark written onto one would be gone by morning.

One invoice can arrive as several line items differing only in amount; they are the
same invoice with the same reason for being late and share one remark. Whoever may
read the tab may write one, and the row records who and when.

The pipeline neither reads nor writes remarks. Unlike a bucket assignment they feed no
figure, so they apply the moment they are saved rather than at the next refresh, and a
rebuild from the dumps alone still reproduces the published build exactly.

### 5c.1 Clearance list

A copy on the customer tracker that goes to the customer over WhatsApp, not to a
spreadsheet, which changes the format entirely: tab-separated columns collapse into
an unreadable run there, so it is a numbered plain-text list with `*bold*` and
`_italic_` markers and lines short enough not to wrap on a phone.

```text
*CLEARANCE REQUEST - NMPL*
_Cut length stock as on 29.07.2026_

1. 19.05 x 1.2 x 680 mm (1940189) - 10,418 nos
2. 19.05 x 1.2 x 631 mm (1940188) - 8,706 nos
...
*19 SKUs, 64,248 nos*
Please confirm clearance for despatch.
```

Scope and its reasons:

- **Cut length only, quantity in nos.** Clearance is asked on finished pieces; a
  long-length tonnage is not something the customer can clear.
- **More than 500 nos**, largest first. Below that there is nothing worth asking for.
- **Deduplicate on `CTL Bucket` before listing.** CTL stock is a shared pool and one
  customer can carry the same bucket on more than one row — the grain is customer,
  bucket, CTL bucket, UoM and plant — so listing it twice offers the same pieces
  twice and doubles the total.
- **Dimensions carry no thousand separator.** `1,130 mm` reads as a quantity next to
  `10,418 nos`; `1130 mm` cannot be misread.
- **A placeholder material code is omitted.** `Schedule July` writes `NO MATERIAL
  CODE` where a code is missing, and quoting that back to the customer is worse than
  leaving the size to speak for itself.

## 5d. Dispatch plan

The customer tracker exports a dispatch plan for the selected customer as
tab-separated text, one line per SKU with open balance, ordered by OD, thickness and
cut length:

```text
DATE : DD.MM.YYYY <tab> CUSTOMER
PLANT | ACTUAL OD | OD | ID | THICKNESS | CTL | NOS | MT | SO
... one line per open SKU, closing with a total MT row
```

`NOS` and `MT` are the open balance. The sales order comes from the most recent
earlier invoice of the same material. Resolve it in this order, recording which level
matched:

1. same customer code and CTL bucket;
2. same CTL bucket.

Match on the CTL bucket, never on the sales material number, whose final digit is
systematically zero. A sales order belongs to a customer, so the customer-level match
is preferred; leave the SO blank when no earlier invoice exists rather than quoting an
unrelated order.

The plan quotes a numeric plant code while the schedule names its plant by location.
Take the code from the matched invoice's supply plant, and for lines with no matched
invoice learn the location-to-code mapping from the lines that did match.

Record receivables customers that do not resolve to an OEM in `qc_summary.json` under
`overdue_analysis.unmapped_customers` so unattributed overdue is never silently
dropped.

## 5e. Megh Steel SKU tracker

Megh Steel is a conversion agent: TSL sells it mother tube, which it cuts and supplies
onward to TVS ancillaries. The tab is driven by the RM tracker's `vsm stock` sheet
(header row 3), which is the operating plan for what Megh converts.

Use only rows with a non-zero `Schedule` or `Stock` — 89 of 120 on the 18 September set,
collapsing to 89 SKUs. **The plan states the SKU key; the pipeline does not derive one.**
It is the sheet's own `length key` column:

```text
SKU = governed bucket + "-" + finished length in metres
```

so `22.23-0-2-ERW 1-PE-5.951`, and for a `Megh-` size the prefixed key with its length,
`Megh-12.7-0-1.4-5.67`. Every frame joining to a Megh SKU builds the same shape through
`bucket_vsm_key(bucket, length)`.

The column is taken as written, with two corrections in `norm_length_key` and no others,
because without them the row could not join at all: whitespace collapses, so
`25.4-0-2.5-ERW 1-FC -5.95` meets the key everything else builds; and a trailing length
above `VSM_LENGTH_MM_ABOVE_M` is millimetres — the plan writes 572.5 beside 5.95 — and is
rendered in metres, since stock, sales and WIP all normalise to metres. The sheet is left
as written; only the derived join key moves.

**This replaces a key the pipeline used to assemble** as
`OD-ID-thickness-length-grade-cuttype`, whose cut token came from the governed bucket's
end condition. Wherever the plan and `Bucketting` disagreed there, the two sides built
different keys and never met: the plan keys 22.23 x 2.0 at 5.4 m as `…-ERW 1-FC` while
`Bucketting` governs that row's own material code `2431251` to `…-ERW 1-PE`. Taking the
key from the plan removed 32.349 MT from the unmapped queue on the 18 September set —
mapped Megh sales 87.569 → 119.918 MT, unmapped 86.141 → 53.792, the two still summing to
the 173.711 MT the sales file holds.

A tracked row stating no key at all is an exception, not a silent drop: it reads
`lookup error`, renders on no tab, and is listed in `megh_sku_mapping.csv` with what it
needs. One such row on this set — 25.4 x 3.5 x 5.6 m carrying 3.356 MT of stock.

Never key these SKUs on `CTL Bucket`. That key collapses every length at or above
3.5 m to one LL marker while Megh buys specific lengths, and returns zero for every
long SKU.

### 5e.1 Column sources

| Column | Source |
|---|---|
| Schedule | `vsm stock` → `Schedule` |
| Total stock | `vsm stock` → `Stock` + `In Transit` |
| Orders logged as per OMS | `vsm stock` → sum of the per-plant `... Order` columns |
| Orders logged as per sales planning | `orders.xlsx`, lines whose customer contains `MEGH`, pooled to the VSM SKU key (§5m) |
| Sales to Megh | sales dump, customer codes 943209 / 943210 / 943211 |
| Stock at length | `PLANT STOCKS` + `wip ystockn`, long length only, same SKU key |
| Other length stock | `PLANT STOCKS` + `wip ystockn`, long length only, same family, other length |

The `vsm stock` quantities are kilograms, not tonnes or pieces: `Stock` reconciles to
`NOS x Wt/Len`, and the sheet's own `Coverage` equals `Stock / Schedule x 30`. Divide
by 1000 for MT.

Take the OMS order figure from the per-plant `... Order` columns. `Order qty to be
logged` is the residual still to be raised, not what has been logged; the sheet's
`Coverage post order` confirms this, equalling `(Stock + plant orders) / Schedule x 30`.

The sales-planning order column sits beside the OMS one rather than replacing it. The
two sources disagree on most SKUs — on the 30 July file 37 of the 85 tracked SKUs carry
a planning order at all, and where both are populated they rarely agree — and which is
right is what the planner opens the tab to establish. Coverage days stays on stock; the
existing `coverage_days_post_order` stays on the OMS figure it was defined against.

Restrict the two allocatable columns to long length. A cut piece cannot be re-cut to a
Megh SKU, so offering CTL stock against one would overstate what is available. The
family key for "other length" is the SKU key without its length component.

### 5e.2 Key the plan off its own `length key`

**Superseded by the plan's `length key` column, and kept because it says why the key has
to come from one place.** The disagreements below are exactly what a derived key ran
into; the owner's column ends them by stating the answer. What still holds: the `Megh-`
prefix marks a size supplied onward to RE or HMSIL rather than to TVSM, and it is read
off the **length key**, not `key` — four rows on the 18 September plan carry it there
while their `key` column still names a governed bucket (`34.93-0-1.2-ERW 1-FC`). The
prefix states where the material goes, so it decides: those rows hold no TVS bucket and
stop counting toward TVSM coverage. No row prefixes `key` without also prefixing
`length key`.

#### The disagreements a derived key ran into

`vsm stock` carries both a governed `key` (the Bucketting bucket) and its own `O D`,
`Thk.`, `Grade` and `FC/NFC` cells, and **the two disagree in five different ways**.
Building the SKU key from the cells put the plan on one key and stock, sales and WIP
on another, so a SKU showed no mapped stock while the same material sat in the
long-length tracker:

| Disagreement | Sheet cells | Governed `key` |
| --- | --- | --- |
| Thickness grouped by Bucketting | `41.28 x 3.15` | `41.28-0-3.2-ERW 1-FC` |
| Rectangular section written as an equivalent round OD | `41.28`, `44.45`, `48.6`, `63.5` | `40-25-…`, `40-30-…`, `59-30-…`, `50-50-…` |
| Grade qualifier dropped | `ERW 2`, `HST` | `ERW 2 MAHS`, `ERW 1` |
| Cut type | `NFC` | `FC` (and the reverse) |
| OD and thickness rounding | `28.58 x 2.6` | `28.6-0-2.5-CEW-…` |

Read the `key`, split it as a bucket and add the row's `Length` — exactly the
construction stock, sales and WIP already use. **56 of the 94 tracked rows carry a
key**; the other 38 are sizes Bucketting does not govern, largely the 1.4 mm range
(`12.7 x 1.4`, `15.88 x 1.4`, `19.05 x 1.4`, `25.4 x 1.4`), and they fall back to the
dimension build. Those can never match stock, because a stock row with no governed
bucket produces no key either — which is the honest outcome for an ungoverned size,
not a mapping failure to chase.

**Cut type is answered from two different columns, for two different questions.**
The token inside the key exists only to make the plan meet the stock, sales and WIP
frames, and the sole field all four share is the governed bucket, so it is derived
from the bucket's end condition. What the SKU *is* comes from the plan's own
`FC/NFC` column, which states it outright — `FC` is fin cut, `NFC` is not — and is the
better answer wherever a bucket ends in something that says nothing about finning,
such as `CEW`. The two disagree on 27 SKUs, so a row can legitimately show a key
ending `-NFC` beside a `Fin cut` label; the key is a join, not a description.

On the 29 July set this repairs 20 SKUs: mapped Megh sales rise from 506.150 to
694.223 MT and unmapped fall from 683.700 to 495.627 MT, the two still summing to the
1,189.850 MT the sales file holds. `41.28-0-3.2-5.94-ERW 1-FC` alone gains 66.964 MT
of at-length stock where it previously showed none. The long-length tracker is
unaffected: it already worked in governed buckets.

### 5e.3 Megh length-bucketing

Megh Steel buys **length-specific** sizes, so its governing mapping is the bucket *plus*
the length — and `Bucketting` alone cannot supply it. The plan's own `056`, `0789` and
`0788` columns hold the material code each plant extends for a SKU, and some of those
codes `Bucketting` has never heard of.

That is a real defect, not a curiosity. Code `4149395`:

| Source | What it says |
|---|---|
| `vsm stock` row 38 | key `25.4-0-1.6-ERW 1-FC`, Length 5.84, `0789` = 4149395, Schedule 31 MT |
| `Bucketting` | **no row at all** |

So the SKU `25.4-0-1.6-5.84-ERW 1-FC` rendered on the Megh tab with its schedule, while
an order for the very same code reached no bucket, appeared in no **Order logged**
column and was reported as an unmapped material. The mapping existed — in the plan, not
in `Bucketting`.

The length-bucketing is that mapping, made explicit. One row per length-specific SKU:

| Column | Content |
|---|---|
| `vsm_key` | `OD-ID-thickness-length-grade-cuttype`, the length-specific key |
| `bucket` | the governed bucket from the plan's `key` column, blank where the plan holds none |
| `od`, `thickness`, `length_m`, `grade`, `cut_type` | the size, normalised as everywhere else |
| `material_codes`, `plants` | the codes the plan names and the plant columns they came from |
| `codes_in_bucketting`, `codes_missing_from_bucketting` | the queue to clear in `Bucketting` |
| `plan_note` | a non-numeric entry such as `NEW MCR`, meaning a code is still to be created |
| `tracked_on_megh_tab`, `schedule_mt`, `stock_mt` | whether the SKU renders, and its size |

On the 30 July file: **86 sizes, 83 codes, 9 of them absent from `Bucketting`**, 1 plan
note, 31 sizes with no governed bucket (the plan's `key` is blank), 15 with no code
named at all, 85 of 86 tracked on the tab. It is published below the Megh SKU table,
exported as `megh_length_bucketing.csv`, and both are copyable so the result can be
pasted into the workbook as a length-bucketing sheet.

A non-numeric code entry is a note, never a code. `norm_code` upper-cases text it cannot
read as a number, so `NEW MCR` would otherwise enter the repository and the order book
would try to join on it.

**The plan mixes length units.** `Length` states metres on almost every row and
millimetres on three — 650, 780 and 572.5 beside 5.84 and 6.0. No tube in this business
is 20 m, so a value above 20 is millimetres and is divided down before anything keys on
it. Left alone, a 650 mm cut piece keys as `-650-`, clears the 3.5 m long-length
threshold, is classified as long length and matches no stock ever.

**Test every plan cell for NaN explicitly.** NaN is truthy, so `if not sku` let a row
with no key through to become a mapping key — it reached the payload as a size named
`null` — and `bucket or None` kept a NaN as the bucket, which read as governed and never
reached the assign-a-bucket queue. Same trap as the `"nan-0.46"` CTL buckets (§4.4).

### 5e.2b Two key shapes in one column

Megh Steel runs a **vendor service model**: Tata Steel supplies Megh Steel, and Megh
Steel supplies TVSM, Royal Enfield and HMSIL. The `vsm stock` plan covers all three, so
this tab is not a TVSM-only view.

From the 31 July plan the `vsm stock` `key` column carries **two different things**, and
the `Megh-` prefix is the only thing that tells them apart:

| Shape | Example | Parts mean | Goes to |
|---|---|---|---|
| governed TVS bucket | `12.7-0-1.2-ERW 1-PE` | OD, ID, thickness, grade, end condition | TVSM |
| prefixed size | `Megh-25.4-0-1.4-6.06` | prefix, OD, ID, thickness, **length** | RE or HMSIL |

Both have five hyphen-separated parts. Reading a `Megh-` key as a bucket builds a SKU key
out of the word `Megh` and reads a cut type off a length, so the prefix is tested before
anything parses the key.

On the 31 July plan all 94 tracked rows now carry a key, where 56 did before, and 25 of
them are `Megh-` prefixed. The tab went from 86 SKUs to 93.

**A `Megh-` size has no governed TVS bucket, and that is the answer.** The prefix marks
the size as one Megh Steel supplies onward to RE or HMSIL rather than to TVSM; it does
not say the size is ungoverned. `Bucketting` governs the TVS range by definition, so
those sizes are kept out of the assign-a-bucket queue and out of the
add-the-code-to-`Bucketting` queue, and the length-bucketing names the OEM where a
bucket would be.

**The end OEM is read from the conversion-agent code, not the prefix**, which says only
"not TVSM". 943210 is HMSIL and 943211 is RE, and the attribution runs over the whole
sales window the trend files supply rather than the current month alone, so a size last
sold in April is still attributed. Confirmed on the July dump: the prefixed sizes sell
131.913 MT under HMSIL and 49.521 MT under RE and **nothing at all** under 943209, while
the plain-keyed sizes sell 1,055.378 MT under TVS. A prefixed size no code has bought yet
reads `RE or HMSIL` and answers to both filters.

On the 31 July plan: **69 TVSM, 7 HMSIL, 3 RE and 14 undetermined.** The tab carries a
*Supplied to* column and an end-OEM filter alongside the cut-type and BOP filters. The assignment worksheet's queue fell from 46 rows and 544.0 MT
to 24 rows and 141.5 MT, and no row asks for a bucket any more.

**The plan's per-plant codes are the second route to stock.** With no governed bucket the
bucket join can never reach a Megh-only size, so `056`, `0789` and `0788` give a
code-to-SKU map that fills `vsm_key` on stock, sales and WIP wherever the bucket join
found nothing — bucket first, code only as a fallback, so a governed size keeps the key
every other frame agrees on. On this file that is 22 codes carrying 183.923 MT of stock
and 181.434 MT of sales, and it moves the tab's matched sales from 852.248 to 982.302 MT,
stock at length from 603.507 to 804.320 MT, and unmapped Megh sales down from 621.748 to
491.694 MT. No code appears on two plan rows, so the map has no contested entries.

### 5e.2a Bought-out parts

A BOP item is a size Megh Steel buys finished rather than converting. The list is
governed in `MEGH_BOP_ITEMS` — 17 sizes, 584 pieces — as dimensions, a nominal length,
pieces and plant, exactly as supplied.

**Matching.** A listed line takes the SKU whose bucket agrees on dimension one,
dimension two and thickness, then the nearest length within `MEGH_BOP_LENGTH_TOLERANCE_MM`
— **50 mm**. Keying on the first three bucket parts rather than on OD is what makes a
rectangular section work: the list writes `40 x 25 x 1.6` and the bucket is
`40-25-1.6-…`, while that bucket's OD field holds the equivalent round diameter 41.28.

**One claim each.** Assignment runs nearest-gap-first and claims each listed line and
each SKU once. `19.05 x 2.0` is listed twice, at 5840 and 6000; letting each line take
its own nearest hands `5.841` to both and leaves `5.8` unflagged.

**The tolerance is 50 mm because 200 mm was a different size.** At 200 mm the 6000 line
was matched to the plan's `19.05-0-2-5.8`, and the owner's ruling is that a 200 mm gap is
a separate line item, not a rounding of the same one. The band now sits inside a
cut-length rounding: on the 31 July build the largest surviving gap is 30 mm.

**A listed size the plan has no row for becomes its own row.** It is a size Megh Steel
buys whether or not `vsm stock` names it, so it is a line item on the tab rather than a
footnote under it. Such a row carries `in_plan: false` and shows an **off plan** badge
beside the BOP badge; schedule, stock, both order columns and sales read zero because the
plan holds nothing for it, while *stock at length* and *other length stock* are joined
for real — the long length available to cut it from is the question the row exists to
answer. Grade and cut type come from the plan's own rows of the same diameter and
thickness when they agree, and read `lookup error` when they do not; a guess there would
key the row to the wrong family. `megh_bop_added` lists these and the note under the
table names them, so the queue reads as *the plan is short of this size*, not as a
matching failure. On the 31 July build: one, `19.05 x 2.0 x 6000` → `19.05-0-2-6-ERW 1-NFC`
(10 nos, plant 0788), with 12.72 MT of long length sitting at other lengths.

The column filter slices the tab four ways: BOP and converted, BOP only, converted only,
and BOP sizes not in the plan. 17 of 94 SKUs are BOP, 1 of them off plan.

### 5e.3a The assignment worksheet

`megh_sku_mapping.csv` is the same mapping written to be completed and sent back, kept
in `dumps/` beside the inputs. 93 rows: the 85 keyed sizes plus **8 plan rows that reach
no SKU key at all**, carried on their dimensions alone. Those 8 would otherwise vanish —
one 48.6 x 1.6 x 572.5 mm row holds 20 MT of schedule with its key, grade and `FC/NFC`
cells all empty, so it appears on no tab and in no mapping, which is precisely a size
that needs assigning rather than dropping.

47 rows are complete; **46 need something, covering 544.0 MT of schedule**. Rows needing
work lead, by descending schedule. `what_is_needed` names which of four things is
missing:

| `what_is_needed` | Rows | Fix |
|---|---:|---|
| `assign bucket` | 13 | the plan's `key` cell is empty; govern the size |
| `assign bucket; name a material code` | 9 | neither stated |
| `state bucket key, grade, cut type, then assign bucket` | 8 | a keyless plan row |
| `assign bucket; add code to Bucketting` | 8 | both |
| `name a material code` | 7 | governed, but no plant column names a code |
| `add code to Bucketting` | 1 | the plan names a code `Bucketting` lacks |
| `complete` | 47 | nothing |

The four assignment columns — `assign_length_bucket`, `assign_bucket`,
`assign_material_code`, `remark` — are left blank on purpose. Asking for the answer to be
written over the derived columns would hide what moved between the plan and the reply.

### 5e.3b `lookup error`

A value the pipeline looked up and could not resolve reads as **`lookup error`**, on the
page and in the exports alike, never as an empty cell. On these queues the empty cells
*are* the work, and a blank reads as "nothing to report" and gets skimmed past. It is
coloured as a failure rather than greyed out as an absence, and it copies as the words,
so a pasted sheet carries the same signal. On the 30 July file the worksheet marks 38
sizes with no bucket, 24 with no material code, 12 with no cut type and 8 with no key or
grade at all.

This applies where a lookup was attempted and failed — not to a cell that is legitimately
empty. An RFD row with no `CTL Code` still reads `blank`, because the source cell is
empty by nature rather than unresolved, and 4731 stock with no piece count still reads
`kg only`, because kilograms are what SAP holds there.

### 5e.4 Recovering a material code from a description

The stock-transfer sheet states a description and no material number, so the code is
recovered. Resolution order, for the order book and for anything else that needs a code:

1. the sheet's own code column, where it has one;
2. the `zmat` description;
3. the Megh length-bucketing above.

**ZMAT is the only material master.** When an extract arrives covering descriptions the
standing dump lacks, it is merged into `zmat.xlsx` by
`scripts/merge_material_mapping.py` and then discarded — not kept beside `zmat` as a
second source that has to be read, filtered and reasoned about on every run. After
merging, the file is copied over `assets/masters/zmat.xlsx` and the new checksum goes
into `config/master_manifest.json`. The 30 July extract added 20 rows: one description,
`TUB-O-N-AUT-AN-FC-70.00X3.200X6.00 HST`, code `3499608`, at 20 plants.

Two things about that merge are load-bearing, and each produced wrong output before it
was caught:

- **Filter on the description, never the code.** An extract lists several codes per
  description (380 rows, 51 descriptions), so keeping rows whose *code* is new gives a
  description `zmat` already resolves a second code, `first_unique` sees the ambiguity
  and returns nothing, and 16 stock-transfer lines that had a recovered code lose it.
  Only unseen descriptions may be appended.
- **Align columns by name, never by position.** The two files hold the same 24 columns
  in a *different order* and disagree on two names — pandas writes
  `WEIGHT/METRE OF MATERIAL.1` for a repeated header where `zmat` writes
  `WEIGHT/METRE OF MATERIAL2`. Renaming positionally looks like it handles that and
  instead transposes the file: it wrote descriptions into the code column and plants
  into the material type. Rename only what genuinely differs, reorder to `zmat`'s own
  order, and stop the merge if any column is still unmatched.

Where a description is extended under several codes, **no code is recovered** — naming
one arbitrarily could raise a transfer on the wrong material — but the candidates are
quoted in place of the blank, as `several zmat codes: 3925143, 4189326`. On the 30 July
file 85 of the 98 stock-transfer lines recover a single code and the remaining 13 are
ambiguous in exactly this way; all 13 still reach a bucket through the description.

Test for NaN explicitly wherever a recovered code decides a label. A missing code
arrives as NaN, which is truthy, so `if stated` reports a blank cell as a code the sheet
stated and a line with no recovery as one `zmat` supplied — the same trap that built
`"nan-0.46"` CTL buckets (§4.4).

### 5e.5 Unmapped Megh purchases

Every Megh sales material whose derived key matches no VSM SKU is listed on the
missing-mappings tab with the key derived from the material and a dropdown of all
SKUs. Most are near misses that need judgement rather than a rule — grade `ERW 2 MAHS`
against `ERW 2`, length 6.001 against 6.000, cut type `NFC` against `FC` — which is
why the assignment is manual. Assignments are held in the page for copying back to the
source mapping and are never written into the dump.

On the 24 July set 300.589 MT of 952.138 MT of Megh purchases match a SKU, leaving
46 lines and 651.549 MT to assign.

## 5f. Inter-plant transfers view

`transfer.xlsx` is one row per despatched transfer line. The columns that matter:

| Column | Meaning |
|---|---|
| `DESP P LANT` | sending plant code |
| `PLANT DESC` | sending plant name |
| `CUSTOMER  CD` / `CUSTOMER  NAME` | receiving plant code and name |
| `Billing  Document Number` | transfer invoice |
| `DO/STO NO` | stock transfer order |
| `BILLING  DATE` | despatch date |
| `GR NO` / `GR DATE` / `GR QTY` | goods receipt at the receiving plant |
| `MARK  CUSTOMER` / `MARK DESTINATION` | the end ancillary the line is marked for |
| `Quantity` | kilograms; divide by 1000 for MT |
| `Invoice Type` | `Tax Inv Transfer` or `D.Challan Transfer` |

A line is **in transit until the receiving plant posts a goods receipt**, so an
empty `GR DATE` is the in-transit flag. Days in transit runs to `GR DATE` once
posted and to the as-of date while the line is open.

Keep only rows whose `Invoice Type` contains `Transfer`. This is also the guard
against a mis-sent file: the daily mail has more than once carried a copy of the
sales dump under the transfer filename (the 27 July set arrived byte-identical in
content to `sales.xlsx`, 3,990 rows and 234 columns both). Sales lines carry
`Tax Inv Sale …`, never a transfer type, so an empty result after this filter means
the file is not a transfer extract. Report that and continue; the transfers view and
the STR cover figure are the only things affected.

On the 27 July set the dump carries 652 lines over a rolling month, moving between
five plants:

| Code | Plant |
|---|---|
| `56` | PT Plant (Jamshedpur) |
| `788` | Khopoli Tube Plant |
| `789` | Hosur Tube Plant |
| `4731` | Tata Steel Ltd INDICO INFRA |
| `8406` | Hosur EPA |

Only `4731` and `8406` receive. Map each line to a governed bucket through
`Bucketting` first and the description second; 85.3% of transferred tonnage
resolves on the 27 July set, and unresolved lines still appear in the view but
cannot join the STR plan.

## 5g. Stock transfer plan for Hosur EPA (8406)

The plan holds **15 days of forward cover at plant 8406** for the Hosur ancillary
cluster: Neel Metal (`NMPL`), Rajsriya Hosur, Rajsriya Mysore, Sandhar Hosur and
Sandhar Mysore, named by their `Helper Customer` values in `Schedule July`. STRs
feeding it are raised on 0789, 0788 and 4731.

**Grain is `Bucket` alone — not `CTL Bucket`, and not per customer.** 8406 is an
external processing agent: it receives tube and cuts it to the customer's lengths
on site. Cover measured at exact cut length understates it badly — 52 MT against
107 MT on the 27 July set, because 130 of the 160 stock rows at 8406 are LL. Cover
is not split by customer either, because a single STR line serves whichever plan
customer draws on it first; splitting it would raise the same transfer several
times over.

```text
Daily_MT      = plan-customer Bucket schedule MT / days in the as-of month
Cover_MT      = PLANT STOCKS MT where Plant = 8406 and the row's customer resolves
                to a plan customer, plus everything in transit to 8406
Requirement   = 15 x Daily_MT
Coverage_days = Cover_MT / Daily_MT
STR_required  = max(0, Requirement - Cover_MT)
```

In-transit tonnage counts towards cover because a line on the road will be on the
ground well before the 15 days are out. This is a deliberate change from the first
version of the view, which reported transit alongside the requirement without
netting it: netting it is what makes `STR required` the number the planner places.

Cover states: `Short` under 15 days, `Watch` 15 to under 30, `Covered` at 30 and
above, `No schedule` where the plan customers hold stock at 8406 in a bucket with
no July schedule. The state drives the filter only; the view carries no risk
column.

**Displayed columns.** `Bucket`, cut lengths (the distinct `LENGTH` values in
millimetres that the plan customers schedule against that bucket), schedule MT,
sales MT, the 15-day requirement, cover at 8406 including transit, STR required,
then **one column per sending plant**: at 0789, at 0788, at 4731. An STR is raised on
a single plant, so a combined sending-plant figure cannot be acted on — the planner
has to know which of the three can supply the gap. Every tonnage opens a drill-down:
cover lists ground batches and transit lines, each plant column lists only that
plant's availability. The three plant columns sum to the source pool exactly, so they
can be read across as well as down.

**Bridging customer identity.** `Schedule July` names a customer by `Helper
Customer`; `PLANT STOCKS` names it by SAP customer name only. Bridge the two
through the sales dump's `CUSTOMER  CD`/`CUSTOMER  NAME` pairs, then through the
schedule's `CUSTOMER CODE` to `Helper Customer`. Drop any code the schedule uses
under more than one `Helper Customer` — `129663` and `948721` appear under both
`ELKAYEM AUTO Hosur` and `Rajsriya Unit 5` — so an ambiguous code can never move
stock into the plan. Stock at 8406 that does not resolve to a plan customer is
listed in its own table rather than dropped.

**In-transit is deduplicated across two sources.** `PLANT STOCKS` books the same
pipeline at the receiving plant that `transfer.xlsx` shows on the road: 40 of the
41 transit batches at 8406 on the 27 July set also appear as in-transit transfer
lines, 78.658 of 81.548 MT. Take the transfer dump as authoritative — it names the
sending plant and the invoice — and add only the `PLANT STOCKS` transit batches it
does not already carry.

### 5g.1 Source pool and the STR line list

The requirement is allocated across what the sending plants actually hold, and the
allocation is what the copy button places as STR lines. Two sources feed the pool,
both restricted to plants 0789, 0788 and 4731:

| Source | Rows | Material code used |
| --- | --- | --- |
| `PLANT STOCKS` | non-transit, positive MT, bucket resolved | the row's own code |
| `wip.xlsx` (ystockn) | positive MT, bucket resolved | the finished-goods code recovered from the description |

Offer order is long lengths before cut lengths, finished goods before mother
tubes, largest holding first inside each. 8406 cuts to order, so a long length
serves any of the customer's lengths while a cut length only serves its own; a
cut-length line carries the remark `Cut length only` so the planner can see what
they are being offered. Allocation is greedy down that order until the
requirement is met; whatever is left over is reported per bucket as a shortfall
rather than dropped.

**Mother tubes are transferred under a finished-goods code.** An STR cannot be
raised on a WIP mother tube: its `PTM-` material is semi-finished and not
orderable. The finished goods that will be booked against it carry the same
description under `TUB-`, so swap the prefix and look the description up in
`zmat`, restricted to `MATERIAL TYPE = FERT`:

```text
PTM-O-N-AUT-AW-FC-22.23X2.000X6.0000  ->  TUB-O-N-AUT-AW-FC-22.23X2.000X6.0000
                                          -> material 3410966
```

A description is extended under several codes and only some of them exist at a
given plant, so `zmat`'s `PLANT` column disambiguates first: prefer a code
extended to the despatching plant, then one whose governed bucket matches the
mother tube's, then the lowest code so repeated runs pick the same one. Every line
recovered this way carries the remark `From WIP: <PTM description>`.

On the 27 July set this recovers 114 of the 163 mother-tube descriptions at 0789,
646.789 of 1,108.602 MT of WIP. The 41 descriptions with no `TUB-` equivalent in
`zmat` — 401.99 MT — are reported in the view rather than silently excluded: they
are a `zmat` gap the planner can close.

**Unbucketed schedule is reported, not absorbed.** `Schedule July` leaves a few
plan lines with no `Bucket` — 9.91 MT for Rajsriya Hosur and 6.514 MT for Rajsriya
Mysore on the 27 July set. They cannot be matched to stock and carry no transfer
requirement, so state the tonnage in the view rather than let the plan quietly
understate demand.

### 5g.2 STR list copy format

`Copy STR list` emits the placement list for SAP, honouring the view's filters and
covering only rows with a positive requirement:

```text
STOCK TRANSFER REQUEST	as of <as-of>	15 days cover at 8406
SOURCE PLANT	DESTINATION PLANT	FG MATERIAL CODE	DESCRIPTION	BUCKET	QTY MT	REMARK
```

A bucket the sending plants cannot cover closes with a line carrying the
destination, the bucket and `Short by <MT> MT — no stock at 789/788/4731`, so a
gap is visible in the pasted list rather than absent from it.

## 5h. SKU pricing

Every scheduled SKU is priced off the customer contract, `contract.xlsx`, which
carries one sheet per process route: `Tata _ERW-Q4 FY26` for welded tube and
`Tata_CEW - Q1 FY27` for drawn. Each sheet is one row per contracted size, with
three header bands — quarter group, sub-group, column name — above the data.

**The join is the contract `Key`.** It is written `dimension1-dimension2-thickness`,
with the second dimension left empty for a round tube, which is exactly the shape of
the first three parts of a governed `Bucket`. Normalise both sides numerically and
treat an empty or zero second dimension as `0.0`, because a string comparison fails
on `12.7--1.6` against `12.7-0-1.6` and a `None` never equals itself in a lookup key.

A drawn CEW bucket names its **bore** in the second position (`16.1-10.4-2.7-CEW-CEW`)
where the contract names nothing (`16.1--2.7`). Retry such a bucket against the round
key, but only when the second dimension really is the bore — `dim1 - 2 x thickness`
within 0.6 mm of `dim2` — so a rectangular size can never borrow a round price. This
recovers 21 of the 369 priced SKUs on the 28 July set.

**Choosing among variants of a size.** A size can appear more than once:

| Contract `Type` | Key suffix | Matched when |
| --- | --- | --- |
| `ERW` / `CEW` | none | the ordinary case |
| `HIGH STRENGTH/HST 370 / ERW2` | `-HST` | bucket grade contains `HST` or `ERW 2` |
| `STRUCTURAL TUBES` | `-ST` | only as a fallback; no TVS bucket uses it |
| `CEW-STKM 13` | none | bucket grade contains `STKM` |

The contract heads its high-strength band *"High strength / HST 370/ERW2"*, so **ERW 2
prices off the `-HST` variant** wherever the size has one. This is confirmed against
the NMPL reconciliation, which prices `54-0-3-ERW 2-FC` off key `54--3-HST` at
274.972166 INR/m rather than off `54--3` at 261.77.

### 5h.1 The price formula

```text
operation_INR_per_m = rate_INR_per_tonne x contract_kg_per_m / 1000
price_per_m         = contract base price per m for the quarter
                      + sum(operation_INR_per_m)
LL  price = price_per_m                       quoted INR / m
CTL price = price_per_m x length_m            quoted INR / piece
```

Weight is the contract's own `kg/m`, never a recomputed one, so the price reproduces
the customer's reconciliation exactly. The LL/CTL split is the dashboard's usual one:
3.5 m and above is a long length.

Value-added rates, in INR per tonne, and where each is read:

| Operation | Rate | Source |
| --- | --- | --- |
| Angle cut | 200 | `Schedule July` → `Angle Cut` is `AG` |
| Chamferring | 700 | `Schedule July` → `Chamferring` |
| Fin cut | 250 | `Schedule July` → `FC/NFC` is `FC` or `FIN CUT` |
| Annealing ERW | 1000 | `Bucketting` → `Annealed` is `AN`, or the description carries `-AN-` |
| Annealing CEW | 1250 | as above, on a CEW size |

Annealing is a property of the material rather than of the schedule line, so it is
read from `Bucketting`. The fallback to an `-AN-` segment in the material description
matters: `2417647` (`TUB-O-N-AUT-AN--42.70X3.500`) is not governed by `Bucketting` at
all and would otherwise be priced unannealed.

### 5h.2 Auditing a price

Every quarter's price is a button opening its own build-up, so a customer query can
be answered from the screen rather than by rebuilding the arithmetic:

| Component | INR / MT | Weight kg/m | INR / m | Length m | INR / nos |
| --- | --- | --- | --- | --- | --- |
| Base price · `28.58--2` · Q1 FY27 | 74,900 | 1.311 | 98.161 | 0.475 | 46.63 |
| Fin cut | 250 | 1.311 | 0.328 | 0.475 | 0.16 |
| **Total** | | | | | **46.78** |

The tonne rate, the per-metre rate and the per-piece price are shown side by side on
every line, so each conversion is visible rather than implied.

**A long length is priced at one metre.** Its per-piece column would otherwise be the
price of a 6 m tube, which is not what a long length is sold as, so the length used in
the build-up is 1 and the INR/nos column reproduces the INR/m figure exactly. Verified
end to end: a 6 m `17.3-0-1.6-ERW 1-PE` line prices at 49.4343 INR/m and the build-up
shows length 1.0 and 49.4343 INR/nos.

### 5h.3 Reconciliation against the NMPL working

The NMPL reconciliation (`Price Calculation` sheet) is the reference implementation.
27 of the 33 SKUs common to it and the July schedule reproduce to the paisa. The six
that differ are all cases where that sheet was adjusted by hand, and the rule is kept:

| SKU | Difference | Cause |
| --- | --- | --- |
| `2363145` | 64.29 vs 321.41 | 5 m tube: the view quotes INR/m, the sheet quoted INR per 5 m piece |
| `1938127`, `1940538` | sheet higher | a fin-cut ladder charged on a `PE` line the schedule does not flag |
| `1940437`, `2353927` | view higher | fin cut charged per the schedule's `FC`, which the sheet waived; the sheet also carried a fixed 0.14 angle cut instead of rate x kg/m |
| `2396464` | view higher by 4.30 | annealing charged, which the sheet omitted although both `Bucketting` and the description mark the material `AN` |

State these rather than tune the rule to match: the sheet's adjustments are
commercial decisions per SKU, not a formula.

### 5h.4 What cannot be priced

Two reasons, both reported in the view rather than dropped:

- **No governed bucket** in `Schedule July` — the line reaches no size at all.
- **Size not in the contract price sheet** — the bucket is governed but the contract
  has no row for it. On the 28 July set this is 31 buckets, including `19.05--1`,
  `21.4--1.6`, `25.4--1.4` and `50-30-2.5`.

Together they are 116.488 MT of the 3,053.522 MT TSL schedule.

Prices in different units share one table, so **no quarter column is ever subtotalled**;
only schedule tonnage carries a sum.

## 5i. Code repository and price change requests

A price agreed on a SKU has to be raised in SAP against every combination that has
actually been invoiced, and those combinations are not one per SKU:

- one customer buys the same SKU under **several material codes** — 23 customer/SKU
  pairs on the July window, e.g. Elkayem's `22.23-0-1.2-ERW 1-PE-1.162` billed under
  both `1940363` and `3781676`;
- the same code ships from **several plants** — `2409618` to Balaji from both 0789
  and 8406;
- **bill-to and ship-to differ**, so a change raised on the sold-to party alone
  misses the delivery address it is invoiced against.

The repository is therefore built at **bill-to x ship-to x plant x material code**,
from `SHIP TO PARTY C`/`SHIPTO PARTY DISC`, `CUSTOMER  CD`/`CUSTOMER  NAME`,
`DESP P LANT` and `MATERAIL NUMBER`, scoped to customers whose OEM resolves to TVS
plus the three Megh Steel conversion codes.

**Read a longer sales window when one is supplied.** The daily dump is the current
month only, so a code last billed in April would be missing from the request. Drop a
`sales_history.xlsx` in the input directory in the sales dump's own format and the
repository reads it instead; the rest of the dashboard continues to use the daily
dump, because its sales figures are month-to-date by definition. The window actually
used is reported with the table.

Read the material code with an explicit string dtype here as everywhere else
(section 2, finding 1) — a repository of codes whose last digit has been dropped is
worse than none.

### 5i.1 PCR copy format

`Raise PCR` emits one line per combination at the quarter selected on the tab:

```text
PRICE CHANGE REQUEST	as of <as-of>	<quarter>
BILL TO CODE	BILL TO NAME	SHIP TO CODE	SHIP TO NAME	PLANT	MATERIAL CODE
	DESCRIPTION	SKU	LENGTH MM	<quarter> PRICE	UNIT	BASIS
```

Prices are calculated per scheduled SKU and the repository is keyed by material code,
so the two meet on the code. A code that has been billed but never scheduled carries
no contract price: emit the line anyway with an empty price and the basis
`not scheduled, no contract price`, rather than dropping it. On the July window 271 of
445 combinations carry a price and the other 174 go out flagged — a silently short
request would be worse than a visibly incomplete one.

### 4.4c-1 Presenting the reconciliation

The result is four columns on the stock analysis tab, not one sentence:

| Column | Content |
|---|---|
| `SAP vs RFD (4731)` | verdict — `Match`, `Short in RFD`, `Not in RFD`, `RFD holds more` |
| `RFD matches` | tonnage RFD backs |
| `RFD does not match` | tonnage it does not — the write-off |
| `What the difference is` | the sentence, with both weights and the piece count |

**The two tonnages add back to the row's own Stock MT**, so both columns total. The
reconciliation is per material and a stock row is per material *and holder*, so a
material's matched and unmatched tonnage is allocated across its rows in proportion to
what each holds. Repeating the material total on every row would double it in the
subtotal the moment one code is held for two customers.

**Scope the columns to plant 4731.** The same material code is stocked at other plants,
and keying on the material alone hands an 0789 row 4731's verdict and scales its tonnage
by 4731's SAP total — which is what happened on the first attempt, putting 146.135 MT
into columns that should hold 83.297. On the 31 July build: 70 rows, 31.803 MT matched
and 51.492 MT not, against 83.297 MT of SAP cut length at 4731.

Only a real shortfall is coloured as a failure. `RFD holds more` is amber: it is worth
seeing, but there is no SAP tonnage behind it to write off, which is also why the excess
is stated in words rather than shown as a negative.

## 5j. Column filters

Every table header carries an Excel-style filter alongside click-to-sort: a searchable
list of the distinct values in that column with multi-select, plus select-all, clear
and remove-filter.

Three properties matter and are worth preserving:

- **They compose.** The values a header offers are drawn from the rows the *other*
  headers still allow, so narrowing one column narrows the choices in the next.
- **They sit on top of each panel's own filters**, not in place of them. Because those
  panels rebuild their `tbody` on every render, the selections live in one state
  object keyed by table and column index and are re-applied after each render rather
  than stored on the rows.
- **Hidden rows leave the figures.** Subtotals sum only visible rows and the copy
  buttons emit only visible rows, so what is copied is what is on screen.

Searching inside the filter list narrows what can be ticked without silently dropping
the values scrolled out of view: a value hidden by the search keeps whatever state it
already had.

Two things make a long list usable, and both were broken until a column with a sentence
per material made it obvious:

- **The list needs `min-height: 0`.** It is a flex item, and a flex item defaults to
  `min-height: auto`, so it refuses to shrink below its content: the list grew past the
  popup instead of scrolling, and produced no scrollbar to drag.
- **A scroll inside the popup must not close it.** The close-on-scroll listener runs in
  the capture phase and therefore sees the list's own scroll events. Without a guard the
  list closed itself the instant it was dragged — indistinguishable, to the reader, from
  a list that refuses to scroll.

The popup is also clamped on both edges rather than only the right, and drops above its
header when there is no room below, so the last column's popup cannot hang off screen.

## 5k. Sign-in gate

The page opens on a sign-in card and keeps `main` hidden until it is passed. Two
users, `apoorv` and `mes`, are checked against SHA-256 digests of
`username:salt:password`, salted per user so a shared password does not produce a
shared digest and neither digest is a plain dictionary lookup. The session lives in
`sessionStorage`, so a reload keeps it and closing the tab ends it.

`data.json` is fetched only after the gate is passed, so a browser parked on the
sign-in screen holds none of the data.

**It is a gate, not a control.** Everything needed to bypass it — the digests, the
salt, the fetch URL — is in the page, because the page is static. Anyone who knows
the URL can request `data.json` directly. State this plainly rather than let the card
imply a protection that is not there; if the data has to be private, it needs a host
that authenticates the request before serving the file.

One implementation note worth keeping: `#signIn` is an ID selector, so the shared
`.hidden` class could not switch it off — `display: grid` won on specificity and the
invisible overlay went on swallowing clicks. It carries its own `#signIn.hidden` rule
for that reason.

## 5l. Admin tab access

`apoorv` is the admin account: it sees every tab plus an Admin tab carrying a matrix of
account against tab. Accounts and grants both live in one published file,
`access.json`, so creating a user never touches the page:

```json
{ "admin": "apoorv",
  "salt": "…",
  "accounts": { "apoorv": "<sha256 of username:salt:password>", "mes": "…" },
  "tabs":  [ { "view": "meghView", "label": "Megh Steel sales" }, … ],
  "visible": { "mes": ["customerView", "meghView", … ] } }
```

`mes` is granted every tab except `pricingView`: SKU pricing carries contract rates, so
it stays with the admin account.

`scripts/manage_users.py` owns that file's accounts and grants: it computes the digest,
orders a grant the way the tabs are ordered, and refuses an unknown tab, a duplicate
username or removing the admin. The page keeps only a fallback admin digest, for the
case where `access.json` is missing — better that the admin can sign in and see what is
wrong than that everyone is locked out by one absent file.

`access.json` is fetched before sign-in, because a password cannot be checked without
it and the file holds no business data. `data.json` still waits until the gate is
passed.

Three states, and the difference matters:

| Account entry | Sees |
| --- | --- |
| absent from `visible` | every tab — a new account is not locked out of work by default |
| a list | only that list |
| an empty list | nothing, with a message saying so rather than a blank page |

**A refresh refreshes the tab list and never the grants.** A newly built tab has to
become grantable, so the `tabs` array is rewritten each run; the `visible` map is read
back and preserved, because a daily run silently resetting who sees what would be the
worst kind of regression — invisible until someone complains.

**The admin's edits cannot reach the server.** The page is static, so a toggle writes
to `localStorage` and takes effect on that browser at once; it reaches anyone else only
when `access.json` is published. The panel states this and offers the file to copy.
Pretending otherwise would be worse than the limitation.

Preview hides the Admin tab along with everything else the previewed account lacks, so
what the admin sees is what that account sees. The way out therefore cannot live in the
tab row — it sits in the header, which preview never touches.

As with sign-in, this hides tabs and does not withhold data: `data.json` carries every
tab's figures whatever the grant says.

## 5m. Order book

The order book is the sales-planning consolidation of what is committed and not yet
delivered. It arrives as one workbook with one sheet per despatching origin, and the
three sheets do **not** report the same thing:

| Sheet | Origin | Open quantity column | What that column means | Order age from | Header row |
|---|---|---|---|---|---:|
| `jsr` | Jamshedpur — sales and STRs | `Bal to Desp` | balance still to despatch | `AGE` | 1 |
| `hk_so` | Hosur and Khopoli sales to Megh Steel and TVSM | `BAL FOR PROD/ROLL(MT)` | balance still to produce | `Ageing Days` | 2 |
| `hk_str` | Hosur and Khopoli STRs to the stock yards | `Actual BTP (MT)` | actual booked to production | as-of date less `STR Date` | 1 |

Each sheet is read on its own column. They describe successive stages of the same
commitment, so substituting one for another — or adding them as if they measured the
same thing — compares unlike quantities. All three are in MT.

### 5m.0 The remarks column: what is not live demand

Each sheet carries a remarks column — `Remarks` on `jsr` and `hk_so`, `REMARKS` on
`hk_str` — holding either `c` or nothing. A line marked `c` is not live demand. It is
excluded from both trackers' pools and from every rate and total computed on the book.

On the 31 July file the mark carries **59% of the book**:

| Sheet | In the sheet | Marked `c` | Live |
|---|---:|---:|---:|
| `jsr` | 3,098.044 | 515.260 (11) | 2,582.784 (65) |
| `hk_so` | 10,632.635 | 7,909.882 (890) | 2,722.753 (184) |
| `hk_str` | 1,826.161 | 770.078 (45) | 1,056.083 (53) |
| **Total** | **15,556.840 (1,248)** | **9,195.220 (946)** | **6,361.620 (302)** |

Both figures are published — `lines_in_sheet` and `order_mt_in_sheet` beside `lines` and
`order_mt`, per origin and in total. An order column that quietly more than halved would
be read as a collapse in demand rather than as a filter working.

The excluded lines are listed on the missing-mappings tab so the sheet accounts for
every line in the book, but labelled *Excluded on purpose* and sorted last: they need
nothing done to them, and they stay out of the unmapped counts. Filtering *Shown on*
hides them.

### 5m.0a Order age

How long a line has been open is stated three different ways, so it is read three
different ways and normalised to days:

- `jsr` names it `AGE`, `hk_so` names it `Ageing Days`. Both are already day counts.
- `hk_str` states **no age at all**, only `STR Date` — the date the STR was raised. Its
  age is the as-of date less that date. Reading the date cell as if it were a day count
  would report an eleven-year-old order, so the two cases are governed separately and a
  test asserts each sheet declares exactly one of the two.

Every line resolves to an age on the 30 July file. Oldest per origin: Jamshedpur 167
days, Hosur/Khopoli sales 393 days, Hosur/Khopoli transfers 224 days. The age shows on
every line of every order drill-down and on every row of the unmapped-order table, and
is never summed — it is a day count, like stock age and days overdue.

Two shape differences follow from the sheets rather than from choice:

- `hk_so` puts its header on the **second** row; read with `header=1`.
- `hk_str` carries **no material number** at all, only `Material Description`, so its
  code is recovered from the description per §5e.4 and its bucket resolved from
  whichever of the two lands first. The spec names the columns a code would arrive
  under, so adding the mapping to the sheet needs no code change; the recovery stays as
  the fallback for whatever the sheet still leaves blank. On the 30 July file 85 of its
  98 lines recover a single code, 13 are ambiguous, and 95 of 98 reach a bucket.

The planning sheets name a plant by its `PT-` code where every dump in this pipeline
uses the SAP number, so `PT-HOUS` → `789`, `PT-KHP` → `788` and `PT-JSR` → `56` before
anything is grouped. On the 30 July book that yields 789: 10,818.440 MT, 56: 3,098.044
MT and 788: 1,640.356 MT of 15,556.840 MT over 1,248 lines.

### 5m.1 Where the tonnage lands

The book is pooled twice, on the two keys the two views work in:

- **Long-length tracker** — pooled to the governed `Bucket` and shown as **Order
  logged**, opening the line items behind it plant by plant: plant, origin, type,
  order number, customer, material code, description, the basis the quantity is open
  on, the line's age in days, and the quantity. 112 buckets carry orders on the 30 July
  file.
- **Megh Steel tab** — the lines whose customer name contains `MEGH`, pooled to the
  VSM SKU key, shown as **Orders logged as per sales planning** *beside* the `vsm
  stock` plan's own figure, which is renamed **Orders logged as per OMS**. The two
  sources disagree on most SKUs; both are shown because which is right is exactly what
  the planner is checking. 69 SKUs carry planning orders, totalling 4,915.065 MT, of
  which 50 SKUs and 4,299.652 MT reach a row on the tab — the rest are reported per
  §5m.2.

The order column stays out of coverage days, the balance and the gap columns. An order
is committed demand, not stock; folding it into cover would overstate availability.

### 5m.2 Order lines missing from a view, and why every one is listed

A single pooled figure would read as the whole order book when 14% of it is not in
there. Every line absent from a view that should carry it is listed individually on the
missing-mappings tab — order number, plant, type, customer, material code, description,
the bucket and SKU it did or did not reach, the line's age and its tonnage — because
the fix is per line and a grouped count cannot be actioned. On the 30 July file that is
**119 lines and 2,194.555 MT** of 15,556.840 MT.

#### Absence from a view is not the same as an unmapped material

This is the distinction the table exists to make, and getting it wrong wasted a
reader's time once already. A Megh order on an unscheduled bucket shows on the Megh
Steel tab **with its full tonnage** and is absent only from the long-length tracker —
where nothing is wrong with the order at all, because that tracker's rows are the
buckets carrying a schedule. Listed on a tab headed *Missing mappings* without saying
so, the row reads as a mapping failure and sends someone to fix a mapping that is
already correct.

So every row names both sides:

- **Missing from** — `Long-length tracker`, `Megh Steel tab`, or both.
- **Shown on** — the view where the tonnage *is* visible, or `Nowhere`. The `Nowhere`
  rows are the real loss and lead the table; their cell is marked.
- **Cause** — the short label that names the fix.

| Missing from | Shown on | Lines | MT |
|---|---|---:|---:|
| Long-length tracker | Megh Steel tab | 35 | 780.474 |
| Long-length tracker | Nowhere | 51 | 600.668 |
| Long-length tracker **and** Megh Steel tab | Nowhere | 14 | 409.828 |
| Megh Steel tab | Long-length tracker | 19 | 403.585 |

Reading across: **1,010.496 MT is visible on no view**, 1,790.970 MT is absent from the
long-length tracker and 813.413 MT from the Megh tab. Causes and their fixes:

| Cause | Fix |
|---|---|
| `No governed bucket` | govern the size in `Bucketting`; the variant `(sheet carries no code)` marks a line whose description recovered no code either (§5e.4) |
| `Bucket not scheduled` | nothing — the tracker follows the schedule; the order is fine |
| `SKU not in plan` | add the SKU to `vsm stock` |
| `Length not governed` | govern the length, so a VSM SKU key can be derived |

Two further properties make the totals honest:

- **A line missing from both views carries both labels rather than appearing twice**, so
  the rows are unique and the tonnage total is the whole gap with nothing double
  counted.
- **A Megh line that yields no SKU key at all counts as missing from the Megh tab**, not
  only one whose SKU the plan omits. On the 30 July file every such line also sits on an
  unscheduled bucket, so the bucket test would have caught them anyway — that is
  coincidence, not cover, and relying on it would lose them on the first file where a
  scheduled bucket fails to govern a Megh length.

`Bucket not scheduled` is the cause that surprises: those orders *do* reach a governed
bucket, so the bucket-level resolution rate of 97.41% reports them as mapped, and they
still reach no long-length row.

## 5n. Past sales trend

What TSL has billed to the TVSM chain, month by month. Sources, all in the sales dump's
own 225-column layout and mapped by the **same function** — a trend that disagreed with
the month it overlaps would be worse than no trend:

| File | Sheet | Window | Lines |
|---|---|---|---:|
| `sales_q4.xlsx` | `Sheet1` | Jan–Mar 2026 | 7,932 |
| `sales_q1.xlsx` | `Sheet1` | Apr–Jun 2026 | 7,948 |
| `sales.xlsx` | — | current month | 4,941 |

**Read `Sheet1` only.** `sales_q1.xlsx` also carries `Sheet5` (14 rows) and `Sheet6`
(2 rows); every one of those rows is already in `Sheet1`, checked on billing document
and item, so reading them double counts. `Sheet2`, `Sheet3` and `Sheet4` are empty or
hold a few working columns.

### 5n.1 The two parties

Tracked separately and never merged:

- **TVSM ancillaries** — `OEM_key_1_rev codes` resolves the customer to `TVS`.
- **Megh Steel 943209** — matched on the customer code. The OEM key classifies 943209
  as `Direct`, so inferring it from the OEM key would lose it entirely.

On the 31 July build, Jan–Jul 2026: **17,095.719 MT total — 14,242.893 direct and
2,852.826 through Megh.** The consolidated total sits above the tables with the split
beside it, and each month's tonnage opens its own split.

30.521 MT reaches no governed bucket. It is in the totals and in the plant summary and
cannot appear in the bucket table, so it is named on the summary strip — otherwise the
bucket table's subtotal reads short by an unexplained amount.

### 5n.2 The three tables

1. **Bucket by month.** Months across the columns, read from the data so a new month
   needs no template change. Each cell opens the party split behind it.
2. **SKU trend by customer.** One ancillary — or Megh Steel — at a time, keyed on
   `CTL bucket`, because a length is a SKU to these customers. 26 customers, 566
   customer/SKU pairs on this build.
3. **Despatch plant summary.** Every plant by month, filterable on cut length against
   long length, on angle cut and on chamferring, in tonnes or pieces. Held at the grain
   the filters cut on — plant, month, length type, angle cut, chamferring — so the page
   totals it live.

Angle cut and chamferring are properties of the SKU **as scheduled**, and `Schedule
July` is the only sheet that states them. A historical line therefore inherits the flags
of its own material code, and a material never scheduled in July carries neither rather
than a guess. The tab says so, because the alternative is a filter that silently
under-reports older months.

### 5n.3 The two headline sales cards

One number cannot answer both questions, so there are two, and neither is a subtotal of
the other:

| Card | Definition | 31 July |
|---|---|---:|
| Sales to TVSM (TSL + Megh) | TSL direct to ancillaries **+** Megh onward to TVSM (`VSM Sales`, RM tracker) | 3,112.492 MT |
| TSL billed (TVSM + Megh) | TSL direct to ancillaries **+** TSL to Megh under 943209 | 3,344.836 MT |

They share the direct term (2,121.656 MT) and differ on the second: 990.836 MT of
Megh's onward sales against 1,223.180 MT that TSL billed Megh in the month. The first
answers what TVSM consumed, the second what TSL invoiced. Each card opens its two
components.

Card positions a view does not use are hidden. The views set different numbers of cards,
so a leftover position shows a figure from another context.

## 6. Sales summary classification

### 6.0 Conversion-agent routing

Megh Steels is a conversion agent. `OEM_key_1_rev codes` classifies every Megh code
as `Direct`, but each code's name carries the end OEM it converts for. Route each
code to that OEM and report no separate `Direct` group:

| Code | Customer | Routed OEM |
|---|---|---|
| 943209 | MEGH STEELS PRIVATE LIMITED - TVS A | `TVS` |
| 943210 | MEGH STEELS PRIVATE LIMITED - HMSIL | `HMSIL` |
| 943211 | MEGH STEELS PRIVATE LIMITED - RE | `RE` |

The Boiler material-group override still takes precedence over this routing. Routing
re-attributes volume only; the sales grand total is unchanged. It also makes the
sales-summary `TVS` row equal the "TVS total sales" card by construction.

Classify sales using `OEM_key_1_rev codes`, then apply this governed override:

```text
if MATERIAL GROUP ends in BOT, COR, or AHT:
    Sales Summary Group = Boiler
else:
    Sales Summary Group = mapped OEM
```

The material-group override takes precedence over the customer/OEM mapping. It must
not alter TVS, RE, HMSI/HMSIL, Direct, or other rows whose material group does not
end in `BOT`, `COR`, or `AHT`.

WIP ystockn is approved as shared LL stock and is included in total stock and coverage.

## 7. Data-quality gates

The dashboard refresh must fail or display a visible warning when:

1. active schedule row has no valid `Bucket` or `CTL Bucket`;
2. TVS sales bucket resolution falls below 98%;
3. TVS stock bucket resolution falls below 99%;
4. one product-equivalence key maps to multiple governed buckets;
5. sales total after transformation does not reconcile to the raw sales file;
6. stock total after transformation does not reconcile by plant and CTL/LL;
7. transfer movements are added to the transit snapshot;
8. 4731 plant-stock CTL is added on top of RFD CTL;
9. the same LL pool is summed across multiple customer rows;
10. formula or output contains `#REF!`, `#N/A`, `#VALUE!`, or division-by-zero errors.

Publish the dashboard's missing-mapping table using this governed scope:

1. **Material queue:** only sales rows with an unresolved governed bucket where
   the direct `OEM_key_1_rev codes` classification is `TVS`, plus unresolved
   material rows for customer code `943209` regardless of its OEM classification.
2. **Customer queue:** every distinct sales customer code/name absent from
   `OEM_key_1_rev codes`. Test the original OEM-key match before applying the
   `BOT`/`COR`/`AHT` Boiler override, so the override cannot hide an unmapped
   customer.
3. Do not display stock, WIP, RFD, or non-TVSM sales material exceptions in this
   dashboard tab. Continue measuring their mapping coverage in QC.

The exception table contains:

```text
source file
source row
customer
material number
material description
failed key
reason
quantity/MT affected
recommended mapping action
```

## 8. Recommended refresh sequence

1. Load the latest schedule and mapping tables.
2. Build and validate the governed material dimension.
3. Load sales and map by description/product equivalence.
4. Load stock and separate CTL, LL and transit.
5. Load VSM requirement/sales/stock.
6. Load WIP as an approved shared LL supply layer.
7. Calculate customer schedule facts.
8. Calculate CTL and LL pools.
9. Allocate stock once; never repeat allocated stock across customers.
10. Calculate TVSM coverage and risk.
11. Reconcile raw versus transformed totals.
12. Publish dashboard data plus exceptions and refresh metadata.

## 9. Items intentionally excluded from primary calculations

- `yf65.XLSX`: receivables only; can later support a credit-risk view.
- `transfer.XLSX`: movement history only; do not add to current transit. It does
  drive the transfers view and the STR cover figure (sections 5f and 5g).
- CTL from plants other than 0789: excluded; 4731 CTL comes from `rfd_4731`.
