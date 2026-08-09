# Building `schedule_supplement.xlsx`

Not every customer's schedule reaches the master workbook. In August 8 of 18 were typed
into its `Schedule July` sheet; the other 10 mailed their own, in ten different shapes.
These three scripts turn those mails into rows the pipeline can append.

Run in order, from a directory holding `aug/raw/` (the mail attachments) and
`aug/sched/schedules/` (the unpacked `.msg` files):

```bash
python3 parse_schedules.py    # each customer's layout -> one common frame
python3 match_schedules.py    # find each line's existing row in the schedule sheet
python3 build_supplement.py   # emit schedule_supplement.xlsx
```

**What each step is for.** `parse_schedules.py` holds a reader per customer, because no
two send the same layout — spreadsheets with the size in columns, a PDF, and two whose
table exists only in the mail body. `match_schedules.py` finds the row the schedule
sheet already has for that size, which is where the governed bucket, CTL bucket and
material code come from; nothing re-derives a mapping. `build_supplement.py` writes the
quantity into a copy of that row.

**The traps, all of which bit once.**

- Match on the sheet's `OD`/`ID`, never `ACTUAL OD` — that column holds the equivalent
  round diameter (41.28) for a rectangular section whose faces are 40 x 25.
- Normalise both sides through `norm_od`/`norm_thickness`. Customers write the actual
  wall (1.22, 1.63, 2.03) where the sheet holds the governed one (1.2, 1.6, 2.0).
- A customer that states no bore can match on OD, wall and length **only if one row
  results**. Two rows differing only by bore are two different tubes.
- Take a new size's bucket from `Bucketting` only when exactly one candidate exists.
  Otherwise leave it unmapped with a readable `MATERIAL DES` so it reaches the Missing
  mappings tab. A guessed bucket pools demand onto a size nobody ordered.
- Weigh a row by the customer's stated MT, then `Bucketting`'s kg/piece, and only then
  let the pipeline's formula apply — it is a round-tube formula and reads about 2.4%
  light on a rectangle.

`merge_into_master.py` writes the same rows back into a copy of the master workbook,
for the owner to open in Excel. It is not a pipeline input — the pipeline reads the
untouched master plus the supplement. Two things it must not do, both learned the hard
way: `SCHEDULE IN MT` is a formula over the dimensions and the quantity, so write only
the quantity and let Excel recalculate (writing values there replaced the workbook's own
arithmetic on some rows and not others, and read back as 0 MT for 8 customers); and two
August lines can land on one sheet row, because NMPL orders the same size from Plant I
and the Hub, so sum them rather than letting one overwrite the other — 9 rows this month.
Appended rows get the tonnage formula written with plain cell references, since they sit
below the sheet's Excel table and structured references would not resolve.

Carrying a customer forward reads `aug/carry_forward.csv`, snapshotted into
`dumps/schedule_carry_forward.csv`. Do not read last month's rows from the master: it is
replaced in place each month, so by the time this runs the previous month is gone from
it — that silently dropped Knitvel and `ara` once.

Reconcile every parser against the source's own stated total where it prints one; the
Narasipur PDF and both mail-body tables do, and that check caught a part code being read
as a quantity.
