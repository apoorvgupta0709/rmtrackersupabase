/**
 * The eleven tabs, declared.
 *
 * Each view names the sections it is built from and the columns worth putting on screen.
 * The sheets carry forty-odd fields apiece and only some of them are what anyone reads;
 * the rest are still in the row and still queryable. This decides what is shown, not
 * what exists.
 *
 * Two things are deliberately data rather than code:
 *
 *  - **Which section belongs to which tab is the database's business, not this file's.**
 *    `section_views` decides that, and the policies enforce it. A view listing a section
 *    it has no grant for renders an empty table, never someone else's tonnage.
 *  - **A column is totalled only when it says `total: true`.** Rates, coverage days,
 *    prices, percentages and shared stock pools carry no sum, and each one that does not
 *    says why below.
 */

import type { AssignScope, AverageOver, Column, SeveritySpec } from "./table";
import type { CopySpec } from "./copies";

export type Unit = "mt" | "nos";

export type TableSpec = {
  key: string;
  title: string;
  note?: string;
  /** Rows from `build_sections`. */
  section?: string;
  /**
   * Rows from a master table, read live rather than out of the build.
   *
   * Only the all-mappings tab uses this, and only because the question it asks is
   * different from every other tab's. Everywhere else the point of reading the build is
   * that a page is one consistent answer as of one refresh; here the point is the
   * opposite — what is governed *now*, including a decision recorded a minute ago that no
   * refresh has folded in yet. `dump_bucketing` and `dump_oem_key` each carry a "signed in
   * reads the master" policy, which is what makes this readable at all; the two fold
   * masters read `public.size_folds` the same way.
   */
  master?: "bucketting" | "oem_key" | "thickness_folds" | "od_folds";
  /**
   * Offer an add-a-row form above this table, for a master whose rows are created on the
   * tab rather than uploaded. Only the fold masters use it: every other master's rows
   * come from a workbook, but a fold rule is *born* here. `options` names the list of
   * governed values the form suggests, like `assign.options` does.
   */
  foldAdd?: { scope: "thickness_fold" | "od_fold"; options: string };
  /**
   * Where this table's rows come from and what key carried a quantity onto them —
   * appended to every header's ⓘ, after the column's own derivation note. Two answers
   * every reader is owed without opening the data contract: which uploaded file is
   * behind the figure, and which join would reproduce it in a workbook. Required on
   * every table; `tools/check_client_props.mjs` fails a table that omits it.
   */
  lineage: { source: string; key: string };
  /**
   * Which fields decide whether a row still needs an answer, for the "Only unanswered"
   * toggle. A row counts as answered when *any* of them carries something.
   *
   * Any, not all, and that is the whole of the rule: a bucketting row is answered if the
   * master already governs it **or** somebody has since assigned it, and either one means
   * it is not work. Requiring both would leave every governed row in the queue for ever.
   *
   * The fields are read as the column shows them, not as the row holds them, so `—` and
   * `unassigned` both count as empty without this list having to know what a null looks
   * like in each kind. That is also why an `__assign_*` field works here at all: the
   * decision is not on the row, only in the rendered cell.
   */
  unmapped?: string[];
  /** Rows that travel in a scalar beside the section rows: `[scalar key, field]`. */
  scalar?: [string, string];
  /**
   * Derive rows from the fetched ones — used where one section carries a nested list,
   * where a table takes only part of a section, and where a column has to be joined in
   * from another section. It runs on the server, after the pick filter, so it sees only
   * the rows the reader asked for.
   */
  flatten?: (rows: Row[], from: { sections: Record<string, Row[]>; pick?: string }) => Row[];
  /**
   * The field each of the view's selectors narrows this table on, by parameter name.
   *
   * A table naming a *required* selector shows nothing until a selection is made; a
   * table naming none is always shown, which is how the list you choose from stays on
   * screen. A selector declared `within` another is a narrower: leaving it unset means
   * every value inside the outer selection, not nothing yet.
   */
  pickFields?: Record<string, string>;
  /** Leave the table off the page entirely when it has no rows, rather than saying so. */
  hideWhenEmpty?: boolean;
  columns: Column[];
  averageOver?: AverageOver;
  /**
   * Bespoke copy buttons beside the generic one. A view names the format by kind; the
   * format itself lives in `copies.ts`, because a function cannot cross into the client.
   */
  copies?: CopySpec[];
};

export type Row = Record<string, unknown>;

export type Fact = { label: string; value: string };

export type Ctx = {
  months: string[];
  quarters: string[];
  unit: Unit;
  scalars: Record<string, any>;
  /** What the view's first selector is set to, so a table can say so in its own note. */
  pick?: string;
  /** Every selector's value by parameter name, for a tab with more than one. */
  picks?: Record<string, string>;
};

/**
 * A selector for the whole tab, held in the URL.
 *
 * The customer tracker asks a question about one customer — its lines, its CRFH book,
 * its history — and three tables each with a dropdown of their own is three controls
 * that can disagree. This is one control: it sets a search parameter, the server filters
 * every table that names a field, and the header filter on that column reads the same
 * value back.
 */
export type PickSpec = {
  /** The search parameter it lives in. */
  param: string;
  /** What to call it. */
  label: string;
  /** The section and field the options are drawn from. */
  from: { section: string; field: string };
  /** Shown in place of the tables until a choice is made. Unused on a narrower. */
  prompt?: string;
  /**
   * The parameter this one narrows inside, making it a second, finer selector.
   *
   * A customer's sales arrive under one SAP name per ship-to, so "which customer" and
   * "which of its plants" are two questions and the second only has answers once the
   * first is settled. A narrower's options are drawn from the rows the outer selection
   * left, and leaving it unset means all of them — unlike an outer selector, where
   * unset means the tables have not been asked a question yet.
   */
  within?: string;
};

export type ViewSpec = {
  label: string;
  note: string;
  /** Scalars this view needs, so the page fetches exactly those. */
  scalars: string[];
  /** Offer the tonnes/pieces switch. One control drives every table on the tab. */
  unitToggle?: boolean;
  picks?: PickSpec[];
  /**
   * Drill-down rows to fetch for the current selection and hand to the copy formats.
   *
   * A copy has to be built inside the click that asked for it — the clipboard is only
   * writable from a user gesture — so a format cannot go and fetch what it needs. The
   * quarterly CN/DN working is thousands of billing lines and lives in `detail_rows`
   * rather than in a section for exactly that reason, so the page fetches this reader's
   * keys up front. It runs on the server, where a function is fine, and returns nothing
   * at all until a customer is picked.
   */
  prefetchDetails?: (picks: Record<string, string>, s: Record<string, any>) =>
    { key: string; as: string }[];
  facts?: (s: Record<string, any>) => Fact[];
  tables: (ctx: Ctx) => TableSpec[];
};

/* ---- Column shorthands --------------------------------------------------- */

const txt = (field: string, label: string, wide = false): Column => ({ field, label, wide });
const mt = (field: string, label: string): Column => ({ field, label, kind: "mt", total: true });
/** Tonnage that must not be summed — a shared pool, or a figure repeated down the column. */
const pool = (field: string, label: string): Column => ({ field, label, kind: "mt" });
const nos = (field: string, label: string): Column => ({ field, label, kind: "nos", total: true });
const cnt = (field: string, label: string): Column => ({ field, label, kind: "int", total: true });
const cntNoTotal = (field: string, label: string): Column => ({ field, label, kind: "int" });
const inr = (field: string, label: string): Column => ({ field, label, kind: "inr", total: true });
const days = (field: string, label: string): Column => ({ field, label, kind: "days" });
const pct = (field: string, label: string): Column => ({ field, label, kind: "pct" });
const rate = (field: string, label: string): Column => ({ field, label, kind: "rate" });
// `money` used to live here, whole rupees with `total: true`, and its only caller was the
// pricing tab's base-per-tonne column — so the one tab whose note says no price column is
// ever subtotalled was subtotalling one. That column is gone, and so is the helper: a
// price is a `rate`, which carries no sum.
const bool = (field: string, label: string): Column => ({ field, label, kind: "bool" });
const list = (field: string, label: string): Column => ({ field, label, kind: "list", wide: true });

/**
 * A column whose figures open the lines behind them.
 *
 * `key` and `title` are templates resolved against the row — `{stock_detail_key}` where
 * the pipeline precomputed one, `LLSCHEDULE|{bucket}` where the key is composed from a
 * prefix and something the row already carries. **A placeholder that resolves to nothing
 * leaves the cell as plain text**, which is how most buckets carrying no open order come
 * to show a figure and not a dead button.
 *
 * `when` guards the few breakups that exist only where there is something to break up:
 * the key is on the row regardless, so the guard has to be on the figure beside it.
 */
const drill = (column: Column, key: string, title: string, when?: string): Column => ({
  ...column,
  detail: { key, title, ...(when ? { when } : {}) },
});

/**
 * A column whose figures are inked by the verdict they carry.
 *
 * Kept to the three things that mean act now — coverage, stock ageing, overdue — and
 * withheld from everything else on purpose. Thirty-five columns on this dashboard open a
 * breakup; inking all of them would spend colour saying "this one is clickable", which
 * the dotted rule under a drill-down already says for nothing. A colour here is a
 * verdict, so a reader scanning 447 rows of cut-length stock can find the aged lots
 * without reading a single figure.
 */
const sev = (column: Column, severity: SeveritySpec): Column => ({ ...column, severity });

/**
 * The build's own coverage verdict, mapped to a band.
 *
 * Both coverage tables are inked from this rather than from `coverage_days`, and that is
 * not a shortcut — it is the only correct reading. **The two tabs judge the same field
 * against different targets**: the long-length tracker against 45 days, the STR plan
 * against 15. A threshold on the number would therefore be right on one tab and wrong on
 * the other, whereas the pipeline has already applied the right target to each. It also
 * means the ink and the `Risk` word beside it can never drift apart.
 *
 * `Critical`/`Low`/`Watch`/`Adequate`/`No demand` come from the long-length tracker,
 * `Short`/`Watch`/`Covered` from the STR plan. A size with no demand is not covered and
 * not short — there is nothing to be short of — so it takes no ink at all.
 */
/**
 * The published verdict, as ink.
 *
 * `Watch` is green, not amber, at the owner's instruction: it is 30 to 45 days of cover on
 * the long-length tracker and 15 to 30 on the STR plan, and a month of stock is not a
 * warning. Note what that costs — the tracker's own target is still 45, so green here means
 * "a month or more", not "at target". Move `coverage_days`' bands in the pipeline if green
 * should mean the latter.
 */
const RISK_WORDS: Record<string, "alert" | "attention" | "ok" | null> = {
  Critical: "alert",
  Short: "alert",
  Low: "attention",
  Watch: "ok",
  Adequate: "ok",
  Covered: "ok",
  "No demand": null,
};

/**
 * Where a lot's ageing turns from attention to alert.
 *
 * **60 days is governed** — `stock_ageing.high_age_days` in `config/pipeline.json`, and
 * the boundary the `High age MT` column is itself computed at. **180 is not.** It is a
 * reading of the build: on the 17 August data 266 of 447 cut-length rows and 135 of 255
 * long-length rows sit past 60 days, so a flat red at the governed boundary would ink
 * the majority of both tables and stop meaning anything. At 180 it is 70 rows and 32.
 * Change this one constant if the owner wants the line drawn elsewhere; do not move the
 * 60, which belongs to the pipeline and not to this file.
 */
const AGE_ALERT_DAYS = 180;
const AGE_ATTENTION_DAYS = 60;

const AGEING: SeveritySpec = {
  direction: "high",
  alert: AGE_ALERT_DAYS,
  attention: AGE_ATTENTION_DAYS,
};

/**
 * The aged tonnage, banded by the age of the lot it sits in rather than by its own size —
 * so the figure and the `Oldest days` beside it always say the same thing, and a tonnage
 * never has to be judged against a threshold in MT that nothing governs.
 *
 * The `when` guard is the same one the drill-down on this column already carries, and for
 * the same reason: a lot whose oldest batch is 700 days old but which has nothing past
 * the boundary would otherwise print a red `0.000`.
 */
const AGED_TONNAGE: SeveritySpec = { ...AGEING, from: "oldest_age_days", when: "high_age_mt" };

/**
 * A receivable is overdue at 47 days (`receivables.due_days_from_invoice`), so every row
 * on that tab is already past due and the attention band starts at the first rupee. 90 is
 * the alert, and it is the boundary the build already publishes a column for.
 */
const OVERDUE_ALERT_DAYS = 90;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-01` -> `Jan 26`. */
export function monthLabel(month: string): string {
  const [year, mm] = month.split("-");
  const name = MONTH_NAMES[Number(mm) - 1];
  return name ? `${name} ${year.slice(2)}` : month;
}

/**
 * Months across the columns, read from the build so a new month needs no template change.
 *
 * `openAs` makes each month cell open its own breakup: the month is part of the key, so
 * the template is completed here rather than declared once for the whole column set.
 */
function monthColumns(
  months: string[],
  unit: Unit,
  openAs?: (month: string) => { key: string; title: string },
): Column[] {
  const holder = unit === "mt" ? "months" : "months_nos";
  return months.map((m) => {
    const column: Column = {
      field: `${holder}.${m}`,
      label: monthLabel(m),
      kind: unit === "mt" ? "mt" : "nos",
      total: true,
      month: true,
      explain:
        `${monthLabel(m)} off the sales ledger: every line billed in the month for this `
        + `row's key, ${unit === "mt" ? "Quantity summed ÷ 1,000 (kg → MT)" : "qty in no summed"}. `
        + "The ledger accumulates the daily sales.xlsx dumps and the quarterly extracts, "
        + "deduplicated on billing document + item, so a line uploaded twice counts once. "
        + "A dash is a month with no billing, told apart from a zero.",
    };
    // A month a bucket did not sell in has no split behind it — the pipeline writes a
    // breakup for the months that moved. The cell reads `—`, and guarding on its own
    // field is what keeps it from being a button that opens nothing.
    return openAs
      ? { ...column, detail: { ...openAs(m), when: `${holder}.${m}` } }
      : column;
  });
}

const unitTotal = (unit: Unit): Column =>
  ex(unit === "mt" ? mt("total_mt", "Total MT") : nos("total_nos", "Total nos"),
    "The month columns added across the row — the whole window, not a rate. For a "
    + "monthly figure read Avg month beside it, which divides by the months that "
    + "actually moved.");

/**
 * A column the owner decides rather than reads.
 *
 * It records against the row's material code, so the decision outlives the build it was
 * made on — which is the whole point: the queue is the same queue every morning until
 * somebody's answer is kept somewhere the next refresh reads.
 *
 * The three scopes are three different spaces, and the cell must not offer one where
 * another belongs: `bucket` is a governed bucket from `Bucketting`, `megh_sku` is a key on
 * the Megh plan, `ctl_bucket` is a bucket with a cut length appended. The build publishes
 * a list for the first two and none for the third, so an RFD cell suggests nothing — which
 * is honest, and is why the "not in the master yet" flag only appears where there is a
 * master to check against.
 */
/**
 * An assignable cell on a master table.
 *
 * `assignTo` above keys every decision on `material_code` and offers a list by scope,
 * which is right for the queues. A master's subject is not always a material: the OEM key
 * is keyed on the *customer*, the plan's length key on the SKU itself. So both the field
 * the decision is recorded against and the list it offers are stated rather than assumed.
 */
const assignIn = (
  scope: AssignScope,
  label: string,
  codeField: string,
  options: string,
): Column => ({
  field: `__assign_${scope}`,
  label,
  wide: true,
  assign: { scope, codeField, options },
});

const assignTo = (
  scope: AssignScope,
  label: string,
  codeField = "material_code",
): Column => ({
  // No field on the row holds this; the decision is looked up by the row's code. The name
  // still has to be unique among the columns, because it keys the header's filter.
  field: `__assign_${scope}`,
  label,
  wide: true,
  assign: {
    scope,
    codeField,
    options: scope === "bucket" ? "buckets" : scope === "megh_sku" ? "megh_skus" : "none",
  },
});

/**
 * A column worked out from the row rather than read off it.
 *
 * Used only by the mapping queues, and only for the three facts every queue owes the
 * reader — see `queue` below.
 */
const derived = (field: string, label: string, from: (row: Row) => string): Column => ({
  field,
  label,
  wide: true,
  derive: from,
});

/* ---- The mapping queues --------------------------------------------------- */

/**
 * The tabs a queue's tonnage should be showing on.
 *
 * Declared once and used both here and as each view's own `label`, so the name a queue
 * sends the reader to is by construction the name on the nav. Naming them by hand is how
 * `refresh_dashboard.py` came to write "Megh Steel tab" for a view labelled "Megh Steel
 * sales" — a small drift, and exactly the kind that sends somebody to a tab that is not
 * there.
 */
const TAB = {
  customer: "Customer tracker",
  megh: "Megh Steel sales",
  ll: "Long-length tracker",
  sales: "Sales summary",
  stock: "Stock analysis",
  str: "STR to 8406",
} as const;

/** The masters a mapping can be missing from, in the words the owner's files use. */
const MASTER = {
  bucketting: "Bucketting master",
  customers: "OEM_key_1_rev customer codes",
  meghPlan: "Megh plan SKU list",
  ctl: "CTL Bucket, in the material master",
  bucketAndPlan: "Bucketting master, and the Megh plan",
  schedule: "The customer schedule — bucket governed, nothing scheduled on it",
} as const;

/**
 * One mapping queue, in the shape every mapping queue shares.
 *
 * The seven tables grew one at a time and each said a different subset of the same three
 * things in different words: `missing_mappings` had `Source` and `Reason`,
 * `orders_unmapped` had `Origin`, `Cause`, `Missing from` and `Still shown on`,
 * `stock_unmapped` said none of it. So a reader could not tell from a row where it came
 * from, which master failed it, or which tab is short because of it — which is all three
 * of the facts that decide whether a row is worth answering.
 *
 * This states them in one order on all seven: **where it came from → what it is → what is
 * missing → what that breaks → how much → what you do about it.** Each queue's own extra
 * columns keep their place after the tonnage, so nothing is lost and nothing interrupts
 * the spine.
 *
 * The three derived columns are worked out here rather than published as pipeline fields
 * on purpose. Every fact they need is already on the rows, and the pipeline is mid-port to
 * TypeScript with each ported section held to the Python row for row — three new fields
 * would have to be written twice, identically, to keep that harness green, and would not
 * reach the screen until a refresh ran.
 */
type QueueSpec = {
  key: string;
  section: string;
  title: string;
  note?: string;
  /** Which dump or sheet the rows arrived on: a field on the row, or one fixed name. */
  source: string | ((row: Row) => string);
  /** Which master did not recognise the row. */
  missingIn: string | ((row: Row) => string);
  /** Which tabs are short because of it. */
  affects: string | ((row: Row) => string);
  /** The row's own key, description and party. Absent ones read `—` down the column. */
  code: string;
  description: string;
  customer?: string;
  plant?: string;
  /** The queue's existing explanation, where it has one worth keeping. */
  why?: string;
  /** The queue's own measure, whatever it is called on the row. */
  qty: string;
  /** What this queue has and the others do not. Kept, but after the spine. */
  extras?: Column[];
  /** What an answer here is in the space of, and the field it is recorded against. */
  assign?: { scope: AssignScope; label: string };
  /** Passed through to the table — see `lineage` on TableSpec. */
  lineage: { source: string; key: string };
};

const asText = (v: string | ((row: Row) => string)) =>
  typeof v === "function" ? v : () => v;

/** A column with its derivation note, for the header's ⓘ. */
const ex = (column: Column, explain: string): Column => ({ ...column, explain });

const queue = (q: QueueSpec): TableSpec => ({
  key: q.key,
  section: q.section,
  title: q.title,
  lineage: q.lineage,
  ...(q.note ? { note: q.note } : {}),
  columns: [
    ex(derived("__source", "Data source", asText(q.source)),
      typeof q.source === "string"
        ? `Fixed for this queue: every row here arrives on ${q.source}.`
        : "Read off the row, because this queue pools more than one source."),
    ex(txt(q.code, "Code"),
      "The material code as the dump wrote it, normalised the way every join in the "
      + "pipeline normalises a code: trimmed, Excel's trailing .0 removed, leading zeros "
      + "kept. This is the key your answer is recorded against."),
    ex(txt(q.description, "Description", true),
      "As written on the dump row. Where a code fails to join, the description is often "
      + "the second route the pipeline tried — so this is what to read when deciding "
      + "what the row actually is."),
    // A queue with no party or no plant still carries the column, so the seven tables line
    // up when read one after another.
    ex(txt(q.customer ?? "__no_customer", "Customer", true),
      "As written on the dump row. A dash means this queue's source carries no party."),
    ex(txt(q.plant ?? "__no_plant", "Plant"),
      "As written on the dump row. A dash means this queue's source carries no plant."),
    ex(derived("__missing_in", "Mapping missing in", asText(q.missingIn)),
      "Which master would have to carry this row's key for the row to resolve — worked "
      + "out from the row's type and cause when the page renders, so one word answers "
      + "what would otherwise take knowing the pipeline's join order."),
    ex(txt(q.why ?? "__no_why", "Why", true),
      "The pipeline's own reason for listing the row, published with it."),
    ex(derived("__affects", "Affects tabs", asText(q.affects)),
      "Which tabs are short because of this row — the tabs whose figures this tonnage "
      + "would land on if the mapping existed. Follows from which join failed."),
    ex(mt(q.qty, "Qty MT"),
      "The tonnage this gap is hiding: the affected dump rows' quantity summed and "
      + "divided by 1,000 (the dumps carry kilograms). This is what is missing from the "
      + "tabs named beside it."),
    ...(q.extras ?? []),
    ...(q.assign ? [assignTo(q.assign.scope, q.assign.label, q.code)] : []),
  ],
  // Every row on a queue is unmapped by construction — that is what put it there. So the
  // only thing "unanswered" can usefully mean here is *not answered by you yet*, which is
  // the assignment cell and nothing else. It is the difference between a queue that still
  // reads 300 rows after a morning's work and one that reads 280.
  ...(q.assign ? { unmapped: [`__assign_${q.assign.scope}`] } : {}),
});

/* ---- The customer tracker ------------------------------------------------ */

/** A CRFH line, told from the bucket the pipeline wrote. */
const isCrfh = (row: Row) => String(row.bucket ?? "").toUpperCase().includes("CRFH");

/**
 * The customer tracker's line columns, shared by the tube table and the CRFH book.
 *
 * These are the thirteen the static page carries, in its order. Two things about them
 * are deliberate and easy to get wrong: **a cut length is scheduled in pieces**, so the
 * quantity columns sit beside the tonnage rather than being dropped for it; and the last
 * three carry **no total** — two are stock pools shared between the customers drawing on
 * them, and the third is a per-SKU average month.
 */
const customerLineColumns = (): Column[] => [
  ex(txt("OEM", "OEM"),
    "rm_tracker_model.xlsx › Schedule July › OEM — the schedule's own grouping, not "
    + "the OEM key's. The sales beside it are classified through the OEM key "
    + "separately."),
  ex(txt("customer_display", "Customer", true),
    "rm_tracker_model.xlsx › Schedule July › Helper Customer. One display name can "
    + "stand for a set of SAP customer codes, and the dispatch column sums sales "
    + "across every code in the set."),
  ex(txt("ctl_bucket", "SKU / CTL bucket", true),
    "rm_tracker_model.xlsx › Schedule July › CTL Bucket — the governed bucket with "
    + "the finished length appended. Where the sheet leaves it blank but names a "
    + "MATERIAL NO, it is recovered through Bucketting; the sheet's own value always "
    + "wins."),
  ex(txt("Plant", "Plant"), "rm_tracker_model.xlsx › Schedule July › Plant, as written."),
  ex(cnt("schedule_qty", "Schedule Qty"),
    "rm_tracker_model.xlsx › Schedule July › SCHEDULE in nos, summed over the group. "
    + "Only rows with a schedule above zero are read."),
  ex(cnt("sales_qty", "Dispatch Qty"),
    "sales.xlsx › Sheet1 › qty in no where the schedule is in NOS, Domain for "
    + "z_qty_meter where it is in M — this month's lines for this customer's code set "
    + "and this CTL bucket. A sales line finds its bucket by description first, "
    + "material code second — the dump zeroes the last digit of every material "
    + "number, so codes alone cannot be trusted."),
  ex(cnt("balance_qty", "Balance Qty"), "Schedule Qty − Dispatch Qty."),
  ex(mt("schedule_mt", "Schedule MT"),
    "rm_tracker_model.xlsx › Schedule July › SCHEDULE IN MT where present; otherwise "
    + "computed from the geometry: π × (OD − thickness) × thickness × 7.85 / 1000 kg "
    + "per metre, × length × pieces."),
  ex(mt("sales_mt", "Dispatch MT"),
    "The same sales.xlsx › Sheet1 lines' Quantity summed ÷ 1,000 — the dump carries "
    + "kilograms."),
  ex(mt("balance_mt", "Balance MT"),
    "Schedule MT − Dispatch MT. Negative means over-dispatch; it is shown, not "
    + "zeroed."),
  drill(
    ex({ field: "ctl_stock_pool_nos", label: "CTL stock NOS", kind: "nos" },
      "Two sources and no others: stock.xlsx › PLANT STOCKS › NOS at plant 0789 "
      + "marked CTL, plus rfd_4731.xlsx › Sheet5 › RFD Qty. mapped to the CTL bucket "
      + "through the master's CTL Code. Plant-stock 4731 rows are deliberately not "
      + "added on top of RFD. A pool shared between customers drawing on it — do not "
      + "sum down the column. The breakup lists the lots."),
    "{ctl_stock_detail_key}",
    "{customer_display} · {ctl_bucket} · CTL stock",
  ),
  drill(
    ex(pool("ll_stock_pool_mt", "LL stock MT"),
      "Long-length cover for the row's bucket: stock.xlsx › PLANT STOCKS › MT on "
      + "rows marked LL for this pool's OEM, plus mapped WIP from wip.xlsx › Total "
      + "Stock, plus the PLANT STOCKS rows held as TRANSIT STOCK (shared at bucket "
      + "level). Megh's TVS-A code counts into the TVS pool. A shared pool — do not "
      + "sum down the column. The breakup names each source."),
    "{ll_stock_detail_key}",
    "{customer_display} · {bucket} · LL stock",
  ),
  drill(
    ex({ field: "history_avg_month_mt", label: "Avg month sales", kind: "mt" },
      "The sales ledger — sales.xlsx › Sheet1 and the archived extracts, "
      + "deduplicated on billing document + item: this customer's codes × this SKU, "
      + "Quantity summed per month ÷ 1,000, averaged over the months that actually "
      + "moved — a month with no sale does not drag the average down. The breakup "
      + "shows every month."),
    "{history_detail_key}",
    "{customer_display} · {ctl_bucket} · sales month by month",
  ),
];

/**
 * What the history table has to say before its rows mean anything.
 *
 * The window it covers, and — where it applies — that the history belongs to a customer
 * *code* shared with another name. Three codes are shared on this build, and a reader who
 * does not know that reads someone else's tonnage as this customer's.
 */
function historyNote(ctx: Ctx): string {
  const trend = ctx.scalars.sales_trend ?? {};
  const months: string[] = trend.months ?? [];
  const window =
    months.length
      ? `${monthLabel(months[0])} to ${monthLabel(months[months.length - 1])}`
      : "the history window";
  const meta = (trend.customer_history_notes ?? {})[ctx.pick ?? ""] ?? {};
  const shared: string[] = meta.shared_codes_with ?? [];
  return (
    `Every SKU bought over ${window}, joined on the customer's own SAP codes rather than `
    + "on its name. Filter On schedule to no for what it has quietly stopped ordering. "
    + "The table closes on an average month, over the months that moved."
    + (shared.length
      ? ` This customer shares a code with ${shared.join(", ")}, so the history is the `
        + "code's and not this name's alone."
      : "")
    + (meta.reason ? ` ${meta.reason}.` : "")
  );
}

/* ---- Fact-strip helpers -------------------------------------------------- */

const f3 = (v: unknown) =>
  typeof v === "number" ? v.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : "—";
const f0 = (v: unknown) =>
  typeof v === "number" ? v.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : "—";
const join = (v: unknown) => (Array.isArray(v) && v.length ? v.join(", ") : "—");

/* ---- The views ----------------------------------------------------------- */

export const VIEWS: Record<string, ViewSpec> = {
  customerView: {
    label: TAB.customer,
    note:
      "Pick a customer to see every SKU it has schedule or dispatch against, its CRFH "
      + "book where it keeps one, and everything it has bought over the trend window. The "
      + "stock pools are shared between the customers drawing on them, so they carry no "
      + "total: adding them down the column would count the same tube several times.",
    scalars: ["sales_trend"],
    picks: [
      {
        param: "customer",
        label: "Customer",
        from: { section: "customer_lines", field: "customer_display" },
        prompt:
          "Select a customer above to see its schedule lines, its CRFH book and its sales "
          + "history. The summary below lists every customer on this build.",
      },
    ],
    tables: (ctx) => [
      {
        key: "customer_summary",
        lineage: {
          source: "rm_tracker_model.xlsx › Schedule July: Helper Customer, OEM, SCHEDULE IN "
              + "MT, SCHEDULE in nos. sales.xlsx › Sheet1: Quantity, qty in no — one row "
              + "per customer.",
          key: "Schedule July › Helper Customer; sales join on the customer's SAP codes and "
              + "material code → Bucketting › Bucket (owner assignments overriding).",
        },
        section: "customer_summary",
        title: "By customer",
        note:
          "Schedule, dispatch and balance per customer, in both units. A cut length is "
          + "ordered in pieces and a long length by the metre, so the piece columns count "
          + "the cut-length lines only — the tonnage beside them covers both.",
        // The pieces are summed from the customer's own lines rather than read off the
        // summary, which carries tonnage alone. Same rows, so the two always agree.
        flatten: (rows, { sections }) => {
          const byCustomer = new Map<string, { schedule: number; sales: number; balance: number }>();
          for (const line of sections.customer_lines ?? []) {
            // Only the lines actually counted in pieces. Twenty of them are scheduled in
            // metres, and adding a metre to a piece gives a number that means nothing.
            if (line.uom !== "NOS") continue;
            const name = String(line.customer_display ?? "");
            const held = byCustomer.get(name) ?? { schedule: 0, sales: 0, balance: 0 };
            held.schedule += Number(line.schedule_qty) || 0;
            held.sales += Number(line.sales_qty) || 0;
            held.balance += Number(line.balance_qty) || 0;
            byCustomer.set(name, held);
          }
          return rows.map((row) => {
            const held = byCustomer.get(String(row.customer_display ?? ""));
            return {
              ...row,
              schedule_qty: held?.schedule ?? 0,
              sales_qty: held?.sales ?? 0,
              balance_qty: held?.balance ?? 0,
            };
          });
        },
        columns: [
          ex(txt("customer_display", "Customer", true),
            "rm_tracker_model.xlsx › Schedule July › Helper Customer — the tracker's "
            + "own grouping of SAP codes."),
          ex(txt("OEM", "OEM"),
            "rm_tracker_model.xlsx › Schedule July › OEM, off the customer's lines."),
          ex(cnt("schedule_lines", "Lines"),
            "How many Schedule July lines the customer has this month."),
          ex(mt("schedule_mt", "Schedule MT"),
            "rm_tracker_model.xlsx › Schedule July › SCHEDULE IN MT summed over the "
            + "customer's lines — the sheet's own figure, or geometry × pieces where "
            + "the sheet leaves it blank."),
          ex(cnt("schedule_qty", "Schedule pcs"),
            "rm_tracker_model.xlsx › Schedule July › SCHEDULE in nos, summed over the "
            + "customer's NOS-scheduled lines only — twenty lines are scheduled in "
            + "metres, and a metre added to a piece means nothing."),
          ex(mt("sales_mt", "Dispatch MT"),
            "sales.xlsx › Sheet1 › Quantity ÷ 1,000, this month's lines for the "
            + "customer's code set, summed over its lines."),
          ex(cnt("sales_qty", "Dispatch pcs"),
            "The same sales.xlsx lines' qty in no, NOS lines only."),
          ex(mt("balance_mt", "Balance MT"), "Schedule MT − Dispatch MT."),
          ex(cnt("balance_qty", "Balance pcs"), "Schedule pcs − Dispatch pcs."),
          ex(cnt("unresolved_sales_lines", "Unmapped sales lines"),
            "The customer's sales lines that reached no governed bucket and so count "
            + "in no SKU row — each is in the Missing mappings queue."),
        ],
      },
      {
        key: "customer_lines",
        lineage: {
          source: "rm_tracker_model.xlsx › Schedule July, one row per line. sales.xlsx › "
              + "Sheet1: Quantity, qty in no. stock.xlsx › PLANT STOCKS: MT, NOS. "
              + "wip.xlsx: Total Stock. rfd_4731.xlsx › Sheet5: RFD Qty.",
          key: "Schedule July › Helper Customer × CTL Bucket; sales join on the customer's "
              + "codes and material code → Bucketting › Bucket, the CTL pool on the "
              + "bucket with the cut length appended.",
        },
        section: "customer_lines",
        title: "Schedule lines",
        pickFields: { customer: "customer_display" },
        // The two customers below keep their CRFH range as its own book, so it is lifted
        // out of this table rather than mixed into the tube lines.
        flatten: (rows) => rows.filter((row) => !isCrfh(row)),
        note:
          "Every SKU this customer carries schedule or dispatch against. Pool columns must "
          + "not be summed across customers — stock is shared, so a total would count it "
          + "more than once. The history cell is an average month, not a window total.",
        columns: customerLineColumns(),
        // Both are addressed to one customer, and read it off the selector above through
        // the rows they are handed, rather than off a second control of their own.
        copies: [{ kind: "dispatch" }, { kind: "clearance" }],
      },
      {
        key: "customer_lines_crfh",
        lineage: {
          source: "the same schedule lines, narrowed to the CRFH book.",
          key: "matched on the governed bucket — no customer list is maintained; otherwise "
              + "exactly as the tube lines above.",
        },
        section: "customer_lines",
        title: "CRFH line items",
        pickFields: { customer: "customer_display" },
        flatten: (rows) => rows.filter(isCrfh),
        hideWhenEmpty: true,
        note:
          "Marathwada and Sri Balaji Gear buy a large CRFH range beside their tube SKUs "
          + "and read it as its own book, so it is held out of the table above.",
        columns: customerLineColumns(),
      },
      {
        key: "customer_sku_history",
        lineage: {
          source: "the sales ledger — sales.xlsx › Sheet1 plus the archived extracts "
              + "(sales_jul, sales_q4, sales_q1): Quantity, qty in no, BILLING DATE.",
          key: "the customer's own SAP codes (CUSTOMER CD — never the name), then material "
              + "code → Bucketting per SKU; months off BILLING DATE.",
        },
        section: "trend_customer_sku_history",
        title: "Sales history — every SKU this customer has bought",
        pickFields: { customer: "customer" },
        // On schedule is a join, not a field: the SKU is on this month's tracker if the
        // customer's own lines carry its CTL bucket. Filter that column to `no` for what
        // has quietly stopped being ordered, which is the question this table exists for.
        flatten: (rows, { sections, pick }) => {
          const scheduled = new Set(
            (sections.customer_lines ?? [])
              .filter((line) => line.customer_display === pick)
              .map((line) => line.ctl_bucket),
          );
          return rows.map((row) => ({ ...row, on_schedule: scheduled.has(row.sku) }));
        },
        note: historyNote(ctx),
        columns: [
          ex(txt("sku", "SKU", true),
            "The CTL bucket — governed bucket with finished length — over every SAP "
            + "code this customer has billed under, joined on the codes rather than "
            + "the name."),
          ex(txt("bucket", "Bucket", true), "The governed bucket, without the length."),
          ex({ field: "length_m", label: "Length m", kind: "rate" },
            "The governed length in metres."),
          ex(txt("length_type", "Type"),
            "LL where the governed length is 4 m or more, CTL below it."),
          ex(bool("on_schedule", "On schedule"),
            "A join, not a field: yes where this month's tracker carries the SKU on "
            + "the customer's own lines. Filter to no for what has quietly stopped "
            + "being ordered — the question this table exists for."),
          ...monthColumns(ctx.months, ctx.unit),
          drill(
            unitTotal(ctx.unit),
            "{detail_key}",
            "{customer} · {sku} · sales month by month",
          ),
          ex(ctx.unit === "mt" ? nos("total_nos", "Total nos") : mt("total_mt", "Total MT"),
            "The window's total in the other unit, so both readings are on the row "
            + "whichever the toggle shows."),
          ex(cntNoTotal("months_active", "Months"),
            "How many of the window's months actually billed — the divisor for the "
            + "average beside it."),
          ex(ctx.unit === "mt"
            ? { field: "avg_active_month_mt", label: "Avg active month MT", kind: "mt" }
            : { field: "avg_active_month_nos", label: "Avg active month nos", kind: "nos" },
            "The row's total ÷ its active months, so a SKU that pauses does not read "
            + "smaller than it sells. The totals row averages over the visible rows' "
            + "own active months."),
        ],
        averageOver: {
          monthsField: "months_active",
          avgField: ctx.unit === "mt" ? "avg_active_month_mt" : "avg_active_month_nos",
          totalField: ctx.unit === "mt" ? "total_mt" : "total_nos",
        },
      },
    ],
  },

  meghView: {
    label: TAB.megh,
    note:
      "The vendor service model: Tata Steel supplies Megh Steel, which supplies TVSM, "
      + "Royal Enfield, HMSIL and Rane. A key carrying the Megh- prefix is an RE or HMSIL "
      + "size and has no TVS bucket by design — it is not a mapping gap.",
    scalars: ["signoff", "orders", "megh_reco"],
    // Megh's quarterly price-difference working, one document per quarter with all four
    // OEMs in it. Fetched for the copy because the clipboard is not writable after an
    // await; nothing is read unless the tab is open.
    prefetchDetails: (_picks, s) =>
      ((s.megh_reco?.quarters as string[]) ?? []).map((q) => ({
        key: `MEGHRECO|${q}`,
        as: `meghreco:${q}`,
      })),
    facts: (s) => [
      { label: "Signed off", value: `${f3(s.signoff?.signed_mt)} MT` },
      { label: "Not signed off", value: `${f3(s.signoff?.non_signed_mt)} MT` },
      { label: "Sign-off reaching no bucket", value: `${f3(s.signoff?.unmapped_mt)} MT` },
      { label: "Sign-off sheets", value: join(s.signoff?.sheets) },
      { label: "Reco lines held", value: f0(s.megh_reco?.lines) },
      { label: "Reco OEMs", value: join(s.megh_reco?.oems) },
    ],
    tables: (ctx) => [
      {
        key: "megh_tracker",
        lineage: {
          source: "rm_tracker_tvsm.xlsx › vsm stock: Schedule, Stock, In Transit, the "
              + "per-plant … Order columns. sales.xlsx › Sheet1: Quantity, customer codes "
              + "943209/943210/943211. stock.xlsx › PLANT STOCKS: MT. wip.xlsx: Total Stock. "
              + "orders.xlsx › jsr, hk_so, hk_str. signoff.xlsx › jsr, hosur, khopoli.",
          key: "vsm stock › length key. A material code reaches a row only through "
              + "vsm stock › 056/0789/0788 or a megh_sku assignment, matched against "
              + "sales › MATERAIL NUMBER, stock › Material, wip › Material No, "
              + "orders › MATL_NO / Material Number, sign-off › MATL_NO / Material. "
              + "Bucketting is never used.",
        },
        section: "megh_tracker",
        title: "Megh SKU tracker",
        note:
          "Every size on the vsm stock plan, read across: what it is, then every quantity "
          + "it answers to. An empty bucket is an answer, not a gap — the size goes onward "
          + "to RE or HMSIL, which Bucketting does not govern, or it is a bought-out size "
          + "the plan has no line for and is listed in the table below. Sales to Megh "
          + "opens the months behind it; every other figure opens its own split.",
        columns: [
          // The size first, as the sheet states it, then the two keys that govern it.
          // The plan key itself is no longer a column — the dimensions are what is read —
          // but it is still on the row and still what every breakup below is keyed on.
          ex(list("materials", "Material codes"),
            "rm_tracker_tvsm.xlsx › vsm stock › 056, 0789 and 0788 — the codes the "
            + "plan names for this SKU. This list is the mapping: sales, stock and "
            + "orders land on this row only through a code here or a megh_sku "
            + "assignment on Missing mappings; Bucketting is never used."),
          ex(txt("od", "OD"), "rm_tracker_tvsm.xlsx › vsm stock › O D, as written."),
          ex(txt("inner_d", "ID"), "rm_tracker_tvsm.xlsx › vsm stock › ID, as written."),
          ex(txt("thickness", "Thickness"),
            "rm_tracker_tvsm.xlsx › vsm stock › Thk., as written."),
          ex({ field: "length_m", label: "Length m", kind: "rate" },
            "rm_tracker_tvsm.xlsx › vsm stock › Length, normalised to metres — the "
            + "plan writes some lengths in millimetres (572.5 beside 5.95), and "
            + "anything above the threshold is divided by 1,000."),
          ex(txt("grade", "Grade"), "rm_tracker_tvsm.xlsx › vsm stock › Grade, as written."),
          ex(txt("cut_type", "Cut type"),
            "rm_tracker_tvsm.xlsx › vsm stock › FC/NFC where it states one — FC is "
            + "fin cut — and the bucket's end condition only where it does not."),
          ex(txt("bucket", "Bucket", true),
            "rm_tracker_tvsm.xlsx › vsm stock › key, where the size is TVSM-bound. "
            + "Empty for a Megh- prefixed size — those go onward to RE or HMSIL and "
            + "have no governed bucket by design."),
          ex(txt("end_oem", "End OEM"),
            "TVSM for a plain key. For a Megh- size, the OEM whose conversion-agent "
            + "code (943210 HMSIL, 943211 RE) actually bought it from the sales ledger; "
            + "both names where no code has bought it yet."),
          ex(bool("bop", "BOP"),
            "Whether the SKU matched a line of the governed bought-out list "
            + "(MEGH_BOP_ITEMS): same first three bucket parts, then the nearest "
            + "length within 50 mm, each listed line and each SKU claimed once, "
            + "nearest gap first."),
          // Every figure on this tab is guarded by itself. The plan writes a key onto
          // each row whether or not the SKU has any of that thing, and the breakup for
          // a zero was never built — 64 of the 73 SKUs sold nothing this month. So a
          // zero here is a zero, not a button that opens an explanation of nothing.
          drill(
            ex(mt("schedule_mt", "Schedule MT"),
              "rm_tracker_tvsm.xlsx › vsm stock › Schedule, kg ÷ 1,000 — the sheet's "
              + "quantities are kilograms; its own Stock reconciling to NOS × Wt/Len "
              + "is the proof."),
            "MEGHSCHEDULE|{sku}",
            "{sku} · schedule",
            "schedule_mt",
          ),
          // Ground and in transit are the two halves of one pool. They were their own
          // columns and are now the breakup behind it: what is asked of this figure is
          // "how much is there", and the split is the follow-up question.
          drill(
            ex(mt("total_stock_mt", "VSM stock MT"),
              "rm_tracker_tvsm.xlsx › vsm stock › Stock plus In Transit, kg ÷ 1,000. "
              + "The breakup shows the two halves."),
            "{stock_detail_key}",
            "{sku} · ground plus in transit",
            "total_stock_mt",
          ),
          drill(
            ex(mt("orders_logged_mt", "Orders as per OMS MT"),
              "rm_tracker_tvsm.xlsx › vsm stock › the per-plant … Order columns "
              + "summed, kg ÷ 1,000. Deliberately not Order qty to be logged — that is "
              + "the residual still to be raised; the sheet's own Coverage post order "
              + "confirms it, equalling (Stock + plant orders) ÷ Schedule × 30."),
            "{orders_detail_key}",
            "{sku} · orders logged as per OMS",
            "orders_logged_mt",
          ),
          drill(
            ex(mt("orders_planning_mt", "Orders as per sales planning MT"),
              "orders.xlsx › jsr, hk_so and hk_str — open lines whose customer "
              + "contains MEGH, matched on orders › MATL_NO / Material Number against "
              + "this SKU's plan codes or a megh_sku assignment. Sits beside the OMS "
              + "figure rather than replacing it — the two sources disagree on most "
              + "SKUs, and which is right is what this tab is opened to establish."),
            "{orders_plan_detail_key}",
            "{sku} · orders logged as per sales planning, plant by plant",
          ),
          // Both halves of the split open the same breakup, which carries the three
          // quantity columns side by side; only the heading says which half was clicked.
          drill(
            ex(mt("signoff_mt", "Signed off MT"),
              "signoff.xlsx › jsr (MATL_NO, Bal to Desp where Sign Off is Y), hosur "
              + "(Material, SIGN OFF) and khopoli (Material, Sign Off) — the signed "
              + "half of the lines on this SKU's plan codes."),
            "{signoff_detail_key}",
            "{sku} · signed off",
            "signoff_mt",
          ),
          drill(
            ex(mt("non_signoff_mt", "Not signed off MT"),
              "The same signoff.xlsx sheets, the half not yet signed — jsr › Bal to "
              + "Desp where Sign Off is N, hosur › the rest of Order Qty in MT, "
              + "khopoli › Non Sign Off — on this SKU's plan codes. Both halves open "
              + "the same breakup; the heading says which was clicked."),
            "{signoff_detail_key}",
            "{sku} · not signed off",
            "non_signoff_mt",
          ),
          // Unlike every other figure here, this one opens a history rather than a
          // split: material codes down, months across, and the published month's own
          // column adding to the figure that was clicked.
          //
          // Guarded on the months behind it, not on `sales_mt` as the figures above it
          // are. Those open one month's split, so a zero has nothing behind it; this
          // opens a window, and a size that sold 40 MT in March and nothing this month is
          // exactly the row whose history is worth reading — 38 of the 48 rows with a
          // history read zero for the published month.
          drill(
            ex(mt("sales_mt", "Sales to Megh MT"),
              "sales.xlsx › Sheet1 › Quantity, kg ÷ 1,000 — this month's lines billed "
              + "to Megh's codes (943209 TVS-A, 943210 HMSIL, 943211 RE), matched on "
              + "sales › MATERAIL NUMBER against this SKU's plan codes. Nothing is "
              + "inferred: a purchase on a code the plan does not name goes to Missing "
              + "mappings instead. The breakup opens the ledger's months, and the "
              + "published month's column adds back to this figure."),
            "{sales_detail_key}",
            "{sku} · sales to Megh, month by month",
            "sales_months",
          ),
          drill(
            ex(mt("stock_at_length_mt", "TSL stock in VSM length MT"),
              "stock.xlsx › PLANT STOCKS › MT plus wip.xlsx › Total Stock, long "
              + "length only, matched on stock › Material and wip › Material No "
              + "against this SKU's plan codes. Long length only because a cut piece "
              + "cannot be re-cut to a Megh SKU."),
            "{at_length_detail_key}",
            "{sku} · long length at required size",
            "stock_at_length_mt",
          ),
          drill(
            ex(mt("other_length_stock_mt", "TSL stock in non-VSM length MT"),
              "The same stock.xlsx and wip.xlsx pool in this SKU's family — the key "
              + "without its length part — at other lengths. Cover that exists but "
              + "would need cutting to a different length."),
            "{other_length_detail_key}",
            "{sku} · long length, other sizes",
            "other_length_stock_mt",
          ),
        ],
        // One document per quarter, all four OEMs in it with the OEM first — the way
        // the owner's own workbook divides into sheets, and the way it splits again on a
        // filter. Separate from the ancillaries' working because it is separate
        // arithmetic, not the same one with other numbers in it.
        copies: ((ctx.scalars.megh_reco?.quarters as string[]) ?? []).map((q) => ({
          kind: "megh_calculation" as const,
          arg: q,
        })),
      },
      {
        key: "megh_bop_added",
        lineage: {
          source: "the owner's governed BOP list (MEGH_BOP_ITEMS), joined against "
              + "rm_tracker_tvsm.xlsx › vsm stock.",
          key: "bucket dimensions OD–ID–thickness, then nearest stated length within 50 mm, "
              + "each side claimed once; a listed size with no plan row becomes its own "
              + "off-plan row.",
        },
        section: "megh_bop_added",
        title: "Bought-out sizes added off plan",
        note:
          "A listed BOP size with no plan row within 50 mm becomes its own line. The band "
          + "was 200 mm and pulled a 6.0 m size onto a 5.8 m row; a gap that size is a "
          + "separate line item.",
        columns: [
          ex(txt("sku", "SKU", true),
            "The line the governed BOP list (MEGH_BOP_ITEMS) states, keyed the plan's "
            + "way so it sits beside the tracked rows."),
          ex(txt("stated_size", "Stated size"),
            "The size exactly as the BOP list writes it."),
          ex(cnt("nos", "Nos"), "The listed pieces."),
          ex(txt("plant", "Plant"), "The plant the BOP list names."),
          ex(txt("reason", "Reason", true),
            "Why no plan row took it: no row within the 50 mm length tolerance, or the "
            + "nearest row already claimed by a closer listed line."),
        ],
      },
      {
        key: "megh_length_bucketing",
        lineage: {
          source: "rm_tracker_tvsm.xlsx › vsm stock: key, length key, Length, Grade, FC/NFC, "
              + "the 056/0789/0788 code columns, Schedule, Stock.",
          key: "vsm stock › length key; the material codes are the plan's own 056/0789/0788 "
              + "columns — nothing is inferred, Bucketting is never used.",
        },
        section: "megh_length_bucketing",
        title: "Megh length bucketing",
        note:
          "The plan's own length-specific mapping, built because Bucketting does not carry "
          + "every code the plan names. Codes missing from Bucketting is a live queue.",
        columns: [
          ex(txt("vsm_key", "Plan key", true),
            "rm_tracker_tvsm.xlsx › vsm stock › length key, taken as written — "
            + "derived from key + Length only for a row stating none."),
          ex(txt("bucket", "Bucket", true),
            "rm_tracker_tvsm.xlsx › vsm stock › key where TVSM-bound; empty for a "
            + "Megh- size."),
          ex({ field: "length_m", label: "Length m", kind: "rate" },
            "rm_tracker_tvsm.xlsx › vsm stock › Length, normalised to metres."),
          ex(txt("grade", "Grade"), "rm_tracker_tvsm.xlsx › vsm stock › Grade."),
          ex(txt("cut_type", "Cut type"),
            "rm_tracker_tvsm.xlsx › vsm stock › FC/NFC where stated; the bucket's end "
            + "condition otherwise."),
          ex(txt("end_oem", "End OEM"),
            "TVSM for a plain key; for a Megh- size, the OEM whose code bought it."),
          ex(bool("megh_only", "Megh only"),
            "Whether the length key carries the Megh- prefix — an RE/HMSIL size with "
            + "no TVS bucket by design."),
          ex(bool("tracked_on_megh_tab", "On Megh tab"),
            "Whether the plan row has Schedule or Stock above zero — only those rows "
            + "make the tracker."),
          ex(txt("material_codes", "Material codes", true),
            "rm_tracker_tvsm.xlsx › vsm stock › 056/0789/0788 — the codes the plan "
            + "names for this SKU; the mapping itself."),
          ex(txt("plants", "Plants"), "Which of the 056/0789/0788 columns named a code."),
          ex(cnt("codes_total", "Codes"), "How many codes the plan names for the SKU."),
          ex(cnt("codes_in_bucketting", "In Bucketting"),
            "How many of those codes Bucketting also governs — reporting only; "
            + "Bucketting maps nothing on this tab."),
          ex(txt("codes_missing_from_bucketting", "Codes not in Bucketting", true),
            "The plan's codes Bucketting does not carry — the live queue this table "
            + "exists to show."),
          ex(mt("schedule_mt", "Schedule MT"),
            "rm_tracker_tvsm.xlsx › vsm stock › Schedule, kg ÷ 1,000."),
          ex(mt("stock_mt", "Stock MT"),
            "rm_tracker_tvsm.xlsx › vsm stock › Stock, kg ÷ 1,000."),
          ex(txt("plan_note", "Plan note", true),
            "rm_tracker_tvsm.xlsx › vsm stock › Remark."),
        ],
      },
    ],
  },

  llView: {
    label: TAB.ll,
    note:
      "Bucket-level coverage for long length, with the order book behind it. Coverage days "
      + "and the gap columns are computed upstream against the month's schedule.",
    scalars: ["orders", "signoff"],
    facts: (s) => [
      { label: "Signed off", value: `${f3(s.signoff?.signed_mt)} MT` },
      { label: "Not signed off", value: `${f3(s.signoff?.non_signed_mt)} MT` },
    ],
    tables: () => [
      {
        key: "ll_tracker",
        lineage: {
          source: "rm_tracker_model.xlsx › Schedule July: SCHEDULE IN MT. "
              + "rm_tracker_tvsm.xlsx › TVSM: VSM Requirement, VSM Sales, VSM Stock. "
              + "sales.xlsx › Sheet1: Quantity. stock.xlsx › PLANT STOCKS: MT. wip.xlsx: "
              + "Total Stock. orders.xlsx › jsr, hk_so, hk_str. signoff.xlsx › jsr, "
              + "hosur, khopoli.",
          key: "one row per governed long-length bucket (Bucketting › Bucket); quantities "
              + "join on material code → Bucketting (owner assignments overriding); the "
              + "TVSM sheet joins on its own key column.",
        },
        section: "ll_tracker",
        title: "Coverage by bucket",
        note:
          "Last month's billing sits beside this month's sales. It is TSL's own billing "
          + "and does not carry Megh's dispatch onward to TVSM, so it is not meant to tie "
          + "to Total sales beside it.",
        columns: [
          ex(txt("bucket", "Bucket", true),
            "rm_tracker_model.xlsx › Bucketting › Bucket: OD-ID-thickness-grade-"
            + "endcondition. One row per long-length bucket any TVS-scope customer "
            + "schedules."),
          ex(sev(txt("risk", "Risk"), { words: RISK_WORDS }),
            "The pipeline's verdict on Cover days: below 15 is Critical, below 30 Low, "
            + "below 45 Watch, 45 and past it Adequate; a bucket with no schedule reads "
            + "No demand. Every coloured figure on this row takes its ink from this "
            + "word, so the numbers and the verdict can never disagree."),
          drill(
            ex(mt("total_schedule_mt", "Schedule MT"),
              "rm_tracker_model.xlsx › Schedule July › SCHEDULE IN MT summed over the "
              + "TVS-scope customers scheduling this bucket, plus rm_tracker_tvsm.xlsx "
              + "› TVSM › VSM Requirement ÷ 1,000. The breakup names each "
              + "contributor."),
            "LLSCHEDULE|{bucket}",
            "{bucket} · total schedule breakup",
          ),
          drill(
            ex(mt("total_sales_mt", "Sales MT"),
              "Dispatched against that schedule this month: sales.xlsx › Sheet1 › "
              + "Quantity ÷ 1,000 on the bucket, plus rm_tracker_tvsm.xlsx › TVSM › "
              + "VSM Sales ÷ 1,000. The breakup names both."),
            "LLSALES|{bucket}",
            "{bucket} · total sales breakup",
          ),
          // Remaining is the balance the LLGAP breakup shows its working for — schedule
          // less sales, per party. The two gap-to-cover columns beside it are a different
          // calculation and only the 45-day one has a breakup of its own.
          drill(
            ex(mt("remaining_schedule_mt", "Remaining MT"),
              "Schedule less sales, floored at zero per party — TVS gap plus VSM gap, "
              + "which the breakup shows term by term. What is still to dispatch this "
              + "month."),
            "LLGAP|{bucket}",
            "{bucket} · balance (schedule less sales)",
          ),
          // One pool, not three columns. WIP and in transit were shown beside it, but
          // they are already inside it — plant stock, WIP, transit and the TVSM tracker
          // add up to exactly this figure — so they were the same tonnage counted twice
          // on screen. The breakup names all four sources.
          // Inked off `risk` like the cover beside it, so the tonnage a reader clicks and
          // the verdict on the row can never say different things. Banding the number
          // itself would: 40 MT is comfortable against one bucket's demand and a month
          // short against another's.
          drill(
            ex(sev(mt("available_ll_stock_mt", "LL stock MT"), { from: "risk", words: RISK_WORDS }),
              "One pool: stock.xlsx › PLANT STOCKS › MT at long length, plus wip.xlsx "
              + "› Total Stock, plus material in transit, plus rm_tracker_tvsm.xlsx › "
              + "TVSM › VSM Stock ÷ 1,000 — the breakup names all four sources. A code "
              + "resolves to the bucket through Bucketting; unresolved WIP is excluded "
              + "and reported on Missing mappings instead."),
            "{stock_detail_key}",
            "{bucket} · consolidated LL stock",
          ),
          drill(
            ex(sev(days("coverage_days", "Cover days"), { from: "risk", words: RISK_WORDS }),
              "LL stock ÷ schedule × 30 — how many days the pool lasts at this month's "
              + "demand rate. Blank where the schedule is zero, because dividing by no "
              + "demand answers nothing. The breakup shows the two inputs and the "
              + "result."),
            "LLCOVERAGE|{bucket}",
            "{bucket} · coverage calculation",
          ),
          ex(mt("gap_to_30_days_mt", "Gap 30d MT"),
            "max(schedule − LL stock, 0): the tonnage short of a full month's cover. "
            + "Zero means the pool already covers 30 days."),
          drill(
            ex(mt("gap_to_45_days_mt", "Gap 45d MT"),
              "max(schedule × 1.5 − LL stock, 0): the tonnage short of the 45-day "
              + "target the tracker holds buckets to. The breakup shows the working."),
            "LLGAP45|{bucket}", "{bucket} · gap to 45 days"),
          drill(
            ex(mt("order_logged_mt", "Ordered MT"),
              "Open order lines on this bucket: orders.xlsx › jsr › Bal to Desp, "
              + "hk_so › BAL FOR PROD/ROLL(MT), hk_str › Actual BTP (MT) — live lines "
              + "only, summed. The breakup lists them plant by plant."),
            "{order_detail_key}",
            "{bucket} · orders logged, plant by plant",
          ),
          drill(
            ex(mt("signoff_mt", "Signed MT"),
              "signoff.xlsx › jsr (MATL_NO, Bal to Desp where Sign Off is Y), hosur "
              + "(Material, SIGN OFF) and khopoli (Material, Sign Off) — the signed "
              + "tonnage on this bucket's codes. The breakup lists the lines."),
            "{signoff_detail_key}",
            "{bucket} · signed off",
            "signoff_mt",
          ),
          drill(
            ex(mt("last_month_sales_mt", "Last month MT"),
              "TSL's own billing for this bucket last month — the sales ledger "
              + "(sales.xlsx › Sheet1 › Quantity ÷ 1,000, ancillaries plus Megh "
              + "943209). It does not carry Megh's onward dispatch, so it is not "
              + "meant to tie to Total sales. The breakup shows the months."),
            "{history_detail_key}",
            "{bucket} · billed month by month",
          ),
        ],
      },
      {
        key: "orders_summary",
        lineage: {
          source: "orders.xlsx (sheets jsr, hk_so and hk_str) — lines marked c in the remarks "
              + "are not live demand and pool nowhere.",
          key: "material code → governed bucket; the signed / not-signed split joins "
              + "signoff.xlsx on the same code.",
        },
        scalar: ["orders", "summary"],
        title: "Order book by origin",
        note:
          "Lines marked c in a sheet's remarks column are not live demand and pool into no "
          + "tracker; they are counted here as excluded so a smaller order column reads as "
          + "the filter working, not as demand collapsing.",
        columns: [
          ex(txt("origin", "Origin"), "The despatching origin the order book files the sheet under."),
          ex(txt("sheet", "Sheet"), "The orders.xlsx sheet the lines came from (jsr, hk_so, hk_str)."),
          ex(txt("basis", "Basis", true),
            "What the sheet's quantity column measures: jsr › Bal to Desp (balance to "
            + "despatch), hk_so › BAL FOR PROD/ROLL(MT) (balance for production), "
            + "hk_str › Actual BTP (MT) (booked to production). Three stages of the "
            + "same commitment — never added as one measure."),
          ex(cnt("lines", "Live lines"),
            "Order lines counted as live demand — the sheet's lines less the excluded "
            + "ones."),
          ex(mt("order_mt", "Order MT"),
            "The live lines' tonnage — the sheet's own quantity column, already in MT."),
          ex(cnt("lines_in_sheet", "Lines in sheet"), "Everything the sheet carries, before exclusion."),
          ex(cnt("excluded_lines", "Excluded lines"),
            "Lines marked c in the sheet's remarks column — not live demand, listed so "
            + "a smaller order column reads as the filter working."),
          ex(mt("excluded_mt", "Excluded MT"), "The excluded lines' tonnage."),
          ex(txt("age_basis", "Age basis"), "Which date column the sheet ages its orders by."),
          ex(days("oldest_order_days", "Oldest days"),
            "As-of date − the oldest live line's date, on that basis."),
        ],
      },
      {
        key: "orders",
        lineage: {
          source: "orders.xlsx (sheets jsr, hk_so and hk_str), line by line.",
          key: "material code → governed bucket; sign-off joined from signoff.xlsx on the "
              + "material code.",
        },
        section: "orders",
        title: "Order book",
        note:
          "Every order line the sales-planning book carries, including the excluded ones, "
          + "flagged rather than dropped. The total below covers both, so read it against "
          + "the live figure on the summary above.",
        columns: [
          ex(txt("origin", "Origin"), "The despatching origin the book files the sheet under."),
          ex(txt("sheet", "Sheet"), "The orders.xlsx sheet (jsr, hk_so, hk_str)."),
          ex(txt("kind", "Kind"), "SO or STR, as the sheet's layout says."),
          ex(txt("plant", "Plant"), "As the sheet writes it."),
          ex(txt("order_no", "Order no"), "The sheet's order number, kept as text so zero-padding survives."),
          ex(txt("customer", "Customer", true), "As the sheet writes it."),
          ex(txt("material_code", "Material code"), "As the sheet writes it."),
          ex(txt("description", "Description", true), "As the sheet writes it."),
          ex(txt("bucket", "Bucket", true),
            "Resolved through rm_tracker_model.xlsx › Bucketting — code first, "
            + "description second; hk_str carries no code, so its bucket comes from "
            + "the description alone."),
          ex({ field: "length_m", label: "Length m", kind: "rate" }, "The governed length in metres."),
          ex(txt("basis", "Basis", true),
            "What the sheet's quantity column measures: jsr › Bal to Desp, hk_so › "
            + "BAL FOR PROD/ROLL(MT), hk_str › Actual BTP (MT)."),
          ex(txt("remark", "Remark"), "The sheet's own remarks column, as written."),
          ex(bool("excluded", "Excluded"),
            "Yes where the remark is c — not live demand, flagged rather than dropped "
            + "so the sheet still reconciles."),
          ex(days("age_days", "Age days"),
            "jsr › AGE and hk_so › Ageing Days as stated; hk_str states only STR "
            + "Date, so its age is the as-of date less that date."),
          ex(mt("order_mt", "Order MT"),
            "The line's quantity — the sheet's own column, already in MT."),
        ],
      },
    ],
  },

  mappingView: {
    label: "Missing mappings",
    note:
      "The queue and the masters, on one tab, because they are one job. The queues come "
      + "first: every row in them is tonnage the pipeline could not govern, so it is "
      + "tonnage missing from a tracker somewhere. Every queue reads the same way — where "
      + "the row came from, what it is, which master did not recognise it, which tabs are "
      + "short because of it, how much, and the box you answer in. Type the key it belongs "
      + "to; the list drops down as you type but you are not held to it, because the usual "
      + "reason a row is here is that the master has never carried the key it needs. "
      + "Under them are the masters themselves, each editable in the same way — that "
      + "is where a mapping that is *wrong* rather than absent gets corrected, which no "
      + "queue can show you. Every box on this tab writes to the database as you leave it. "
      + "The decision is kept against the code, not against this build — the next refresh "
      + "reads it and the tonnage lands where it should. Until that refresh runs the "
      + "figures on the other tabs are unchanged, and the cell says so rather than "
      + "implying otherwise. Use **Only unanswered** to hide what you have already done.",
    scalars: ["governed_buckets"],
    tables: () => [
      queue({
        key: "missing_mappings",
        lineage: {
          source: "four pools — material codes off the sales, stock and schedule reads, "
              + "customers off the OEM key read, scheduled sizes off the Schedule sheet, "
              + "order sign-off lines off signoff.xlsx; each row names its own source.",
          key: "whichever key failed to resolve — a material code no master governs, a "
              + "customer the OEM key does not name, a written size no fold reaches.",
        },
        section: "missing_mappings",
        title: "Materials, customers and scheduled sizes",
        note:
          "Sizes a customer schedules that no bucket governs appear here in the form the "
          + "customer sent them. A row reading lookup error is a bug, not a gap. A "
          + "Schedule row whose size is merely *near* a governed one — a 1.22 wall where "
          + "Bucketting governs 1.2 — is answered on the size-fold masters at the bottom "
          + "of this tab, not by assigning a bucket to one code.",
        // The one queue that pools four sources, so all three derived columns turn on the
        // sub-type rather than on the table.
        source: (row) => String(row.source ?? ""),
        missingIn: (row) =>
          row.mapping_type === "Customer" ? MASTER.customers
            : row.mapping_type === "Order sign-off" ? MASTER.bucketAndPlan
              : MASTER.bucketting,
        affects: (row) =>
          row.mapping_type === "Customer" ? [TAB.sales, TAB.customer].join(", ")
            : row.mapping_type === "Schedule" ? [TAB.customer, TAB.ll, TAB.str].join(", ")
              : row.mapping_type === "Order sign-off" ? [TAB.ll, TAB.megh].join(", ")
                : [TAB.customer, TAB.ll, TAB.sales].join(", "),
        code: "material_code",
        description: "description",
        customer: "customer",
        why: "reason",
        qty: "affected_mt",
        extras: [
          ex(txt("mapping_type", "Type"),
            "Which of the four sources pooled into this queue the row came from — "
            + "Material, Customer, Schedule or Order sign-off."),
          ex(txt("customer_code", "Customer code"), "As the source sheet writes it."),
        ],
        assign: { scope: "bucket", label: "Assign bucket" },
      }),
      queue({
        key: "megh_unmapped",
        lineage: {
          source: "Megh purchase lines in the sales ledger that reached no plan SKU.",
          key: "material code, which no plan plant column or megh_sku assignment claims.",
        },
        section: "megh_unmapped",
        title: "Megh purchases reaching no plan SKU",
        note:
          "Tonnage Megh Steel has already bought against a code neither the plan's own "
          + "plant columns nor an assignment here ties to a SKU. Those two statements are "
          + "the whole of the mapping — nothing is inferred, so a row leaves this queue "
          + "only when you answer it or the plan gains the code. The derived key is a "
          + "suggestion built from the governed bucket and the length: right often "
          + "enough to be worth showing, wrong in exactly the ways that kept it from "
          + "being the join, so check it before you type it.",
        source: "sales.xlsx",
        // A Megh-only size having no governed TVS bucket is the expected state, not the
        // gap: what is missing is a line on the plan.
        missingIn: MASTER.meghPlan,
        affects: TAB.megh,
        code: "material_code",
        description: "description",
        customer: "customer",
        qty: "sales_mt",
        extras: [ex(txt("derived_key", "Derived key", true),
          "A suggestion, not a mapping: the row's governed bucket with its length in "
          + "metres appended — the shape every plan SKU has. It is built for you to check "
          + "against the plan and type if right; the pipeline itself never maps by it, "
          + "because the two masters spell PE/FC and lengths differently often enough "
          + "that trusting it misfiled 155 MT.")],
        // Keyed on the plan's own SKU, not on a governed bucket.
        assign: { scope: "megh_sku", label: "Assign plan SKU" },
      }),
      queue({
        key: "stock_unmapped",
        lineage: {
          source: "stock.xlsx (PLANT STOCKS) rows whose code reached no governed bucket.",
          key: "material code → Bucketting / zmat, both of which resolved nothing.",
        },
        section: "stock_unmapped",
        title: "Stock reaching no governed bucket",
        source: "stock.xlsx",
        missingIn: MASTER.bucketting,
        affects: [TAB.stock, TAB.ll, TAB.customer].join(", "),
        code: "material_code",
        description: "description",
        customer: "holder",
        plant: "plant",
        qty: "stock_mt",
        extras: [
          ex(txt("length_type", "Length"),
            "stock.xlsx › PLANT STOCKS › CTL/LL, as the sheet marks the row."),
          ex(cnt("batches", "Batches"), "How many batches the unmapped tonnage stands in."),
        ],
        assign: { scope: "bucket", label: "Assign bucket" },
      }),
      queue({
        key: "wip_unmapped",
        lineage: {
          source: "wip.xlsx rows whose code reached no governed bucket.",
          key: "material code.",
        },
        section: "wip_unmapped",
        title: "WIP reaching no governed bucket",
        note: "Unresolved WIP is excluded from long-length stock, so this is cover the tracker cannot see.",
        source: "wip.xlsx",
        missingIn: MASTER.bucketting,
        affects: [TAB.stock, TAB.ll].join(", "),
        code: "material_code",
        description: "description",
        plant: "plant",
        why: "reason",
        qty: "wip_mt",
        extras: [
          ex(txt("code_bucket", "Code bucket", true),
            "What the row's material code resolves to on its own. WIP zeroes the last "
            + "digit of every material number, so the description is what has to "
            + "resolve — a code bucket here with an unmapped row means the two "
            + "disagree."),
          ex(cnt("batches", "Batches"), "How many WIP batches the tonnage stands in."),
        ],
        assign: { scope: "bucket", label: "Assign bucket" },
      }),
      queue({
        key: "rfd_unmapped",
        lineage: {
          source: "rfd_4731.xlsx lines carrying weight and reaching no CTL mapping.",
          key: "material code → the CTL Bucket column of Bucketting (ctl_bucket assignments "
              + "override).",
        },
        section: "rfd_unmapped",
        title: "RFD 4731 lines reaching no CTL mapping",
        note:
          "A row whose code cell reads `—` carries no CTL Code, so there is nothing to "
          + "record a decision against and the box says so. Those are fixed by giving the "
          + "line a code in rfd_4731.xlsx, not from here.",
        source: "rfd_4731.xlsx",
        // RFD resolves through the material master's own CTL Bucket column and never
        // through `material_bucket`, so a bucket assigned on another queue cannot reach
        // it — which is why this queue assigns in its own space.
        missingIn: MASTER.ctl,
        affects: [TAB.stock, TAB.str].join(", "),
        code: "listed_code",
        description: "size",
        why: "reason",
        qty: "stock_mt",
        extras: [
          ex(txt("matched_materials", "Matched materials", true),
            "The plant-stock materials the RFD line's CTL Code matched — the codes "
            + "whose stock this line is meant to account for."),
          ex({ field: "length_m", label: "Length m", kind: "rate" },
            "The cut length off the RFD line's size."),
          ex(nos("stock_nos", "Stock nos"), "The line's RFD Qty. — pieces, not weight."),
        ],
        assign: { scope: "ctl_bucket", label: "Assign CTL bucket" },
      }),
      queue({
        key: "orders_unmapped",
        lineage: {
          source: "orders.xlsx lines that reached no view.",
          key: "material code → governed bucket.",
        },
        section: "orders_unmapped",
        title: "Order lines missing from a view",
        note:
          "Lines excluded on purpose are listed too, so the ones showing nowhere are the "
          + "number worth chasing — read `Affects tabs` against `Still shown on`.",
        source: (row) => String(row.origin ?? ""),
        // Unlike every other queue, a line can be here for a reason that is not a missing
        // mapping at all: a governed bucket that simply carries no schedule. Saying
        // "Bucketting master" for those would send somebody to add a code that is already
        // in it.
        missingIn: (row) => {
          const cause = String(row.cause ?? "");
          // 946 of the 984 lines on the 14 August build are marked `c` in the sheet's
          // remarks column: not live demand, listed only so the lines showing nowhere can
          // be told from the lines withheld on purpose. No master is short because of one,
          // and leaving the cell blank would read as "nobody knows" rather than "nothing".
          if (cause.includes("Remark c")) return "Nothing — excluded on purpose";
          const parts = [
            cause.includes("No governed bucket") ? MASTER.bucketting : "",
            cause.includes("Bucket not scheduled") ? MASTER.schedule : "",
            cause.includes("Length not governed") || cause.includes("SKU not in plan")
              ? MASTER.meghPlan : "",
          ].filter(Boolean);
          // A cause this does not recognise shows itself rather than nothing, so a new one
          // added upstream reads as unclassified instead of reading as no problem.
          return parts.join("; ") || cause;
        },
        // Already computed per line by the pipeline, which names the Megh view by an older
        // label than the nav carries.
        affects: (row) =>
          String(row.missing_from ?? "").replaceAll("Megh Steel tab", TAB.megh),
        code: "material_code",
        description: "description",
        customer: "customer",
        plant: "plant",
        why: "cause",
        qty: "order_mt",
        extras: [
          ex(txt("shown_on", "Still shown on", true),
            "Which views still carry the line despite the gap — read against Affects "
            + "tabs: a line showing nowhere is the one worth chasing."),
          ex(txt("kind", "Kind"), "SO or STR, as the order sheet's layout says."),
          ex(txt("order_no", "Order no"), "As the sheet writes it, kept as text."),
          ex(txt("bucket", "Bucket", true), "What the line resolves to, where it resolves at all."),
          ex(txt("sku", "SKU", true), "The plan SKU it reaches, where it reaches one."),
          ex(days("age_days", "Age days"), "As-of date − the line's date, on the sheet's age basis."),
        ],
        assign: { scope: "bucket", label: "Assign bucket" },
      }),
      queue({
        key: "signoff_unmapped",
        lineage: {
          source: "signoff.xlsx lines reaching no governed bucket or plan SKU.",
          key: "material code, against Bucketting and the Megh plan both.",
        },
        section: "signoff_unmapped",
        title: "Order sign-off reaching no bucket or SKU",
        source: "signoff.xlsx",
        missingIn: MASTER.bucketAndPlan,
        affects: [TAB.ll, TAB.megh].join(", "),
        code: "material_code",
        description: "__no_description",
        // The sign-off sheets are one per plant, and the sheet name is the plant.
        plant: "plant",
        qty: "qty_mt",
        extras: [
          ex(txt("bucket", "Bucket", true),
            "What the code resolves to in Bucketting, where it resolves at all."),
          ex(txt("sku", "SKU", true),
            "The plan SKU it reaches through the plan's code list, where it reaches "
            + "one. A row is here because at least one of the two is missing."),
          ex(mt("signed_mt", "Signed MT"), "The sheet's signed-off quantity, kg ÷ 1,000."),
          ex(mt("unsigned_mt", "Not signed MT"), "The sheet's not-yet-signed quantity, kg ÷ 1,000."),
        ],
        assign: { scope: "bucket", label: "Assign bucket" },
      }),

      /* ---- and the masters themselves ------------------------------------- */

      // Below the queues rather than above them, because the queues are the work and
      // these are the reference. They are here at all because a queue can only show what
      // reached *no* mapping — a code mapped to the wrong bucket is invisible to every
      // table above this line, and this is the only place it can be found and corrected.
      //
      // Bucketting and the OEM key are read live rather than out of the build, so a
      // decision recorded a minute ago is already on screen; the plan's length key comes
      // from the build, because that is where the plan is published.
      {
        key: "bucketting",
        lineage: {
          source: "the accumulated Bucketting master (every code ever mastered), read live — "
              + "not from the build.",
          key: "material code.",
        },
        title: "Master · Bucketting: material code to governed bucket",
        note:
          "What Bucketting governs by hand. A code resolves only off a row here or an "
          + "owner assignment — the attribute inference that used to fill the gaps is "
          + "gone, so a code absent from both is unmapped and queued, never guessed.",
        master: "bucketting" as const,
        unmapped: ["bucket", "__assign_bucket"],
        columns: [
          ex(txt("material_code", "Material code"),
            "rm_tracker_model.xlsx › Bucketting › Material Codes, read live from the "
            + "accumulated master — not from the build, so a row added this morning is "
            + "already here."),
          ex(txt("bucket", "Governed bucket", true),
            "rm_tracker_model.xlsx › Bucketting › Bucket, shaped OD-ID-thickness-"
            + "grade-endcondition. This is the statement the whole dashboard is "
            + "governed by: TVSM ancillaries sales, stock, WIP and the schedule all "
            + "classify through it."),
          ex(txt("ctl_bucket", "CTL bucket", true),
            "rm_tracker_model.xlsx › Bucketting › CTL Bucket: the bucket with the cut "
            + "length appended. Read only by the RFD 4731 reconciliation, which "
            + "resolves through this column and never through the governed bucket."),
          ex(txt("ll_or_ctl", "LL or CTL"),
            "As the Bucketting sheet states it: whether the code is a long-length or "
            + "a cut-to-length material."),
          assignIn("bucket", "Reassign bucket", "material_code", "buckets"),
        ],
      },
      {
        key: "oem_key",
        lineage: {
          source: "the accumulated OEM key master, read live.",
          key: "customer name, trimmed and uppercased on both sides — never the customer "
              + "code.",
        },
        title: "Master · OEM key: customer to OEM",
        note:
          "One row per customer the OEM key names. A customer absent from it reaches no OEM "
          + "at all, which is what the customer queue above reports. An answer here is "
          + "wider in reach than any other on this tab: the OEM map is read by the sales "
          + "frame, the schedule, stock, receivables, the code repository and the trend, so "
          + "one correction moves figures on six tabs at the next refresh.",
        master: "oem_key" as const,
        unmapped: ["oem", "__assign_oem"],
        columns: [
          ex(txt("customer", "Customer", true),
            "rm_tracker_model.xlsx › OEM_key_1_rev codes › Customer, read live from "
            + "the accumulated master. Sales rows join to it by customer *name*, "
            + "normalised on both sides — trimmed, uppercased — never by customer "
            + "code."),
          ex(txt("oem", "OEM"),
            "rm_tracker_model.xlsx › OEM_key_1_rev codes › OEM — what this customer's "
            + "sales are classified under. This single mapping feeds the sales frame, "
            + "the schedule, stock, receivables, the code repository and the trend — "
            + "and the LL tracker's TVS scope is every customer this column says TVS "
            + "for. One exception overrides it: a sales line whose MATERIAL GROUP ends "
            + "BOT, COR or AHT is classified Boiler regardless."),
          ex(txt("cam", "CAM"),
            "As the OEM key sheet states it. Not read by any calculation; carried for "
            + "reference."),
          // Writable since 19 August, and not before: the box exists because
          // `refresh_dashboard.py` now applies an `oem` assignment over `oem_map` where
          // that map is built. It was drawn once without that and withdrawn the same
          // night — a cell that saves, reads back and moves nothing is worse than no cell.
          assignIn("oem", "Reassign OEM", "customer", "oems"),
        ],
      },
      {
        key: "length_key",
        lineage: {
          source: "rm_tracker_tvsm.xlsx › vsm stock: length key, key, the 056/0789/0788 "
              + "code columns — from the published build.",
          key: "vsm stock › length key; the codes listed are the mapping itself.",
        },
        title: "Master · vsm stock: material code to plan SKU",
        note:
          "The plan's own length key, one row per SKU with the codes each plant extends for "
          + "it. A code here is how a sale or a stock line reaches the Megh tab without a "
          + "governed bucket to join on, which is the only route a size bound for RE or "
          + "HMSIL has.",
        section: "megh_length_bucketing",
        // A SKU on the plan that no plant extends a code for is the gap this master has:
        // the line exists and nothing can ever join to it.
        unmapped: ["material_codes", "__assign_megh_sku"],
        columns: [
          ex(txt("vsm_key", "Plan SKU (length key)", true),
            "rm_tracker_tvsm.xlsx › vsm stock › length key, taken as written — the "
            + "pipeline derives one from the plan's key and Length only for a row "
            + "that states none. A Megh- prefix marks a size supplied onward to RE or "
            + "HMSIL rather than to TVSM."),
          ex(txt("bucket", "Governed bucket", true),
            "rm_tracker_tvsm.xlsx › vsm stock › key where the size is TVSM-bound; "
            + "empty for a Megh- prefixed size, which has no governed bucket by "
            + "design. Where both this plan and Bucketting name the same material "
            + "code, the two must agree."),
          ex(txt("material_codes", "Material codes", true),
            "rm_tracker_tvsm.xlsx › vsm stock › 056, 0789 and 0788 — the codes the "
            + "plan names for this SKU. This list *is* the mapping: a Megh purchase "
            + "or stock line lands on this SKU only if its code is here or you assign "
            + "it on this tab. Nothing is inferred."),
          ex(txt("plants", "Plants"),
            "Which of the 056/0789/0788 columns named a code for this SKU."),
          ex(txt("end_oem", "Ends at"),
            "Where the size finally goes. TVSM for a plain key; for a Megh- size, the "
            + "OEM whose conversion-agent code (943210 HMSIL, 943211 RE) actually bought "
            + "it — or both names where no code has bought it yet."),
          ex(txt("cut_type", "Cut type"),
            "rm_tracker_tvsm.xlsx › vsm stock › FC/NFC where it states one — FC is "
            + "fin cut — and the bucket's end condition only where it does not."),
          assignIn("megh_sku", "Reassign plan SKU", "vsm_key", "megh_skus"),
        ],
      },
      // The fold masters. These rows are rules, not data: what a customer *writes* on the
      // left, what Bucketting *governs* on the right, applied by norm_thickness/norm_od
      // before any join. They used to be code constants — 1.22 missing from the table
      // cost 85,500 pieces of August schedule a bucket, and adding it took a code change.
      {
        key: "thickness_folds",
        lineage: {
          source: "public.size_folds, read live — the owner's rules, born on this tab rather "
              + "than uploaded.",
          key: "the written thickness, rounded to two decimals — the exact key "
              + "norm_thickness looks up before any join.",
        },
        title: "Master · Size folds: written wall thickness to the governed gauge",
        note:
          "A customer writes what their drawing says; Bucketting holds one number and "
          + "nothing near it. Each row folds a written thickness onto the governed one "
          + "before any join, everywhere a wall is read. Add a pair only when a scheduled "
          + "size reaches no bucket AND Bucketting clearly governs it under a neighbouring "
          + "number — folding recovers a size, it must never swallow a real gauge. "
          + "Applied at the next refresh, like every mapping on this tab.",
        master: "thickness_folds" as const,
        foldAdd: { scope: "thickness_fold", options: "governed_thicknesses" },
        columns: [
          ex(txt("written", "Written thickness"),
            "The wall as a customer writes it, read at two decimals — the key "
            + "norm_thickness looks up after rounding what the sheet holds."),
          ex(assignIn("thickness_fold", "Governed thickness", "written", "governed_thicknesses"),
            "The gauge Bucketting actually governs. The suggestions are the thicknesses "
            + "of the governed buckets in the current build. Clearing the box retires "
            + "the fold."),
          ex(txt("note", "Note", true),
            "Why the pair exists — which customer writes it, and what proved the fold. "
            + "Recorded when the rule is added; judgement deserves a reason."),
        ],
      },
      {
        key: "od_folds",
        lineage: {
          source: "public.size_folds, read live — the owner's rules, born on this tab rather "
              + "than uploaded.",
          key: "the written outside diameter, rounded to two decimals — the exact key "
              + "norm_od looks up before any join.",
        },
        title: "Master · Size folds: written outside diameter to the governed one",
        note:
          "The same rule for diameters: 22.23 never 22.2, 41.28 never 41.3. Each row "
          + "folds a written OD onto the one Bucketting governs, before any join. Add a "
          + "pair only when a size reaches no bucket AND Bucketting clearly governs it "
          + "under a neighbouring number. Applied at the next refresh.",
        master: "od_folds" as const,
        foldAdd: { scope: "od_fold", options: "governed_ods" },
        columns: [
          ex(txt("written", "Written OD"),
            "The outside diameter as a customer writes it, read at two decimals — the "
            + "key norm_od looks up after rounding what the sheet holds."),
          ex(assignIn("od_fold", "Governed OD", "written", "governed_ods"),
            "The diameter Bucketting actually governs. The suggestions are the ODs of "
            + "the governed buckets in the current build. Clearing the box retires the "
            + "fold."),
          ex(txt("note", "Note", true),
            "Why the pair exists — which customer writes it, and what proved the fold."),
        ],
      },
    ],
  },

  salesView: {
    label: TAB.sales,
    note:
      "What TSL billed this month, classified by OEM. Megh Steel is a conversion agent, so "
      + "each of its codes is routed to the OEM it converts for and there is no separate "
      + "Direct group; the Boiler material-group override still takes precedence.",
    scalars: ["summary"],
    facts: (s) => [
      { label: "Sales to TVSM (TSL + Megh)", value: `${f3(s.summary?.tvsm_received_sales_mt)} MT` },
      { label: "TSL billed (TVSM + Megh)", value: `${f3(s.summary?.tsl_billed_sales_mt)} MT` },
      { label: "Direct to ancillaries", value: `${f3(s.summary?.direct_ancillary_sales_mt)} MT` },
      { label: "Megh onward to TVSM", value: `${f3(s.summary?.megh_to_tvsm_sales_mt)} MT` },
      { label: "TSL billed Megh (943209)", value: `${f3(s.summary?.cust_943209_sales_mt)} MT` },
    ],
    tables: () => [
      {
        key: "sales_summary",
        lineage: {
          source: "sales.xlsx › Sheet1: Quantity, qty in no, Domain for z_qty_meter, "
              + "MATERIAL GROUP; rm_tracker_tvsm.xlsx › TVSM: VSM Sales — the sheet's own "
              + "grand-total row dropped at the read.",
          key: "sales › CUSTOMER NAME → rm_tracker_model.xlsx › OEM_key_1_rev codes › OEM; "
              + "one row per OEM.",
        },
        section: "sales_summary",
        title: "By OEM",
        note:
          "Customers is a count of distinct parties within the group and is not totalled — "
          + "one customer can appear under two groups when its material group routes a line "
          + "to Boiler.",
        columns: [
          ex(txt("OEM", "OEM"),
            "The group a line lands in, decided in order: sales.xlsx › MATERIAL GROUP "
            + "ending BOT, COR or AHT is Boiler regardless of customer; a Megh code "
            + "routes to the OEM it converts for (943209 TVS, 943210 HMSIL, 943211 "
            + "RE, 943213 Rane); otherwise sales › CUSTOMER NAME looked up in "
            + "rm_tracker_model.xlsx › OEM_key_1_rev codes."),
          drill(
            ex(mt("sales_mt", "Sales MT"),
              "sales.xlsx › Sheet1 › Quantity summed ÷ 1,000, this month's lines in "
              + "the group. The breakup splits it customer by customer."),
            "{detail_key}", "{OEM} · sales by customer"),
          ex(nos("sales_nos", "Sales nos"),
            "The same sales.xlsx lines' qty in no, summed."),
          ex({ field: "sales_m", label: "Sales m", kind: "mt", total: true },
            "The same sales.xlsx lines' Domain for z_qty_meter (metres), summed."),
          ex(cntNoTotal("customers", "Customers"),
            "Distinct customer names within the group. Not totalled: one customer can "
            + "appear under two groups when its material group routes a line to "
            + "Boiler."),
          ex(cnt("transactions", "Transactions"), "The number of sales.xlsx lines in the group."),
        ],
      },
    ],
  },

  trendView: {
    label: "Past sales trend",
    note:
      "What TSL has billed to the TVSM chain, month by month. Two parties, never merged: "
      + "TVSM ancillaries by OEM key, and Megh Steel 943209 matched on the customer code "
      + "because the OEM key calls it Direct.",
    scalars: ["sales_trend"],
    unitToggle: true,
    picks: [
      {
        param: "customer",
        label: "Customer",
        from: { section: "trend_customer_skus", field: "customer_group" },
        prompt:
          "Select a customer above to see its SKUs month by month. The bucket, history and "
          + "plant tables below cover every customer and stay as they are.",
      },
      {
        param: "shipto",
        label: "SAP name",
        within: "customer",
        from: { section: "trend_customer_skus", field: "customer" },
      },
    ],
    facts: (s) => {
      const t = s.sales_trend ?? {};
      return [
        { label: "TVSM ancillaries", value: `${f3(t.segment_totals?.["TVSM ancillaries"])} MT` },
        { label: "Megh Steel 943209", value: `${f3(t.segment_totals?.["Megh Steel 943209"])} MT` },
        { label: "Reaching no bucket", value: `${f3(t.unbucketed_mt)} MT` },
        { label: "Last complete month", value: String(t.last_full_month ?? "—") },
        { label: "Value-add flags from", value: String(t.value_add_source ?? "—") },
        { label: "Sources", value: (t.sources ?? []).map((x: any) => x.file).join(", ") || "—" },
      ];
    },
    tables: (ctx) => [
      {
        key: "trend_buckets",
        lineage: {
          source: "the sales ledger — sales.xlsx › Sheet1 plus the archived extracts "
              + "(sales_jul, sales_q4, sales_q1), deduplicated on Billing Document Number "
              + "+ Billing Item: Quantity, qty in no, BILLING DATE.",
          key: "material code → Bucketting › Bucket (description through zmat.xlsx "
              + "first); months off BILLING DATE.",
        },
        section: "trend_buckets",
        title: "Bucket by month",
        note:
          "Months are read from the build, so a new month needs no template change. Tonnage "
          + "reaching no governed bucket is on the strip above and cannot appear here, which "
          + "is why this table's total reads short of the consolidated figure.",
        columns: [
          ex(txt("bucket", "Bucket", true),
            "The governed bucket each ledger line resolved to — description through "
            + "zmat.xlsx › MATERIAL DESCRIPTION first, material code second, both "
            + "against rm_tracker_model.xlsx › Bucketting. Lines resolving to none "
            + "pool into the figure on the strip above and cannot appear here."),
          ...monthColumns(ctx.months, ctx.unit, (m) => ({
            key: `TRENDBUCKET|{bucket}|${m}`,
            title: `{bucket} · ${monthLabel(m)} · split by party`,
          })),
          unitTotal(ctx.unit),
          ex(ctx.unit === "mt" ? mt("direct_mt", "Direct MT") : nos("direct_nos", "Direct nos"),
            "The window's lines whose OEM key says TVS, excluding Megh — TVSM "
            + "ancillaries billed direct."),
          ex(ctx.unit === "mt" ? mt("megh_mt", "Megh MT") : nos("megh_nos", "Megh nos"),
            "The window's lines billed to customer code 943209 — Megh Steel's TVS-A "
            + "code, matched on the code because the OEM key files it as Direct."),
        ],
      },
      {
        key: "trend_customer_skus",
        lineage: {
          source: "the sales ledger — sales.xlsx › Sheet1 plus the archived extracts: "
              + "Quantity, qty in no, CUSTOMER CD, CUSTOMER NAME — the same window as "
              + "the buckets beside it.",
          key: "customer group (the SAP ship-to spellings grouped) → the customer's codes "
              + "(CUSTOMER CD), then material code → Bucketting per SKU.",
        },
        section: "trend_customer_skus",
        title: "SKU trend by customer",
        note:
          "Keyed on CTL bucket, because a length is a SKU to these customers. A cut length "
          + "is planned in pieces, so switch the unit above to read it the way it is ordered. "
          + "Closes on an average month — the tonnage over the months that actually moved — "
          + "because a window total beside seven month columns reads as a monthly rate. "
          + "The SAP name is the ship-to's own spelling; where two customers share a SAP "
          + "code it is also the group, since guessing which of them bought is worse than "
          + "listing it under the name the sales file used.",
        pickFields: { customer: "customer_group", shipto: "customer" },
        columns: [
          ex(txt("customer_group", "Customer", true),
            "The display name a set of SAP customer codes is grouped under — the same "
            + "grouping the customer tracker uses."),
          ex(txt("customer", "SAP name", true),
            "The ship-to's own spelling off the ledger line. Two customers sharing a "
            + "SAP code both list the code's history, each under the name the sales "
            + "file used."),
          ex(txt("sku", "SKU", true),
            "The CTL bucket — governed bucket with finished length — because a length "
            + "is a SKU to these customers."),
          ex(txt("bucket", "Bucket", true), "The governed bucket, without the length."),
          ex(txt("length_type", "Length"),
            "LL where the governed length is 4 m or more, CTL below it."),
          ex({ field: "length_m", label: "Length m", kind: "rate" },
            "The governed length: rm_tracker_model.xlsx › Bucketting's where it "
            + "states one, zmat.xlsx's length attribute otherwise."),
          ex(txt("segment", "Segment"),
            "TVSM ancillaries where the OEM key says TVS; Megh Steel 943209 where the "
            + "line is billed to that code. Never merged."),
          ex(txt("material_codes", "Material codes", true),
            "Every SAP code the ledger billed this customer for this SKU over the "
            + "window."),
          ...monthColumns(ctx.months, ctx.unit),
          ex(cntNoTotal("months_active", "Months"),
            "How many of the window's months actually billed — the divisor for the "
            + "average beside it."),
          ex(ctx.unit === "mt"
            ? { field: "avg_active_month_mt", label: "Avg month MT", kind: "mt" }
            : { field: "avg_active_month_nos", label: "Avg month nos", kind: "nos" },
            "The row's total ÷ its active months. A SKU selling in three months of "
            + "eight is a three-month average — a quiet month does not drag it down."),
        ],
        averageOver: {
          monthsField: "months_active",
          avgField: ctx.unit === "mt" ? "avg_active_month_mt" : "avg_active_month_nos",
          totalField: ctx.unit === "mt" ? "total_mt" : "total_nos",
        },
      },
      {
        key: "trend_customer_sku_history",
        lineage: {
          source: "the sales ledger — sales.xlsx › Sheet1 plus the archived extracts "
              + "(sales_jul, sales_q4, sales_q1): Quantity, qty in no, BILLING DATE.",
          key: "the customer's own SAP codes (CUSTOMER CD), then bucket per SKU; the "
              + "totals row closes on an average month, never a window total.",
        },
        section: "trend_customer_sku_history",
        title: "SKU history — average month",
        note:
          "Closes on an average month, not a window total: the tonnage divided by the months "
          + "that actually moved. A SKU selling in three months of eight is a three-month "
          + "average, and the totals row is taken over the months the visible rows sold in.",
        columns: [
          ex(txt("customer", "Customer", true),
            "The display name a set of SAP customer codes is grouped under."),
          ex(txt("sku", "SKU", true),
            "The CTL bucket — governed bucket with finished length appended."),
          ex(txt("bucket", "Bucket", true), "The governed bucket, without the length."),
          ex(txt("length_type", "Length"),
            "LL where the governed length is 4 m or more, CTL below it."),
          ex(txt("material_codes", "Material codes", true),
            "Every SAP code the ledger billed this customer for this SKU over the "
            + "window."),
          ...monthColumns(ctx.months, ctx.unit),
          drill(
            unitTotal(ctx.unit),
            "{detail_key}",
            "{customer} · {sku} · sales month by month",
          ),
          ex(cntNoTotal("months_active", "Months"),
            "How many of the window's months actually billed — the divisor for the "
            + "average beside it."),
          ex(ctx.unit === "mt"
            ? { field: "avg_active_month_mt", label: "Avg active month MT", kind: "mt" }
            : { field: "avg_active_month_nos", label: "Avg active month nos", kind: "nos" },
            "The row's total ÷ its active months, so a SKU that pauses does not read "
            + "smaller than it sells. The totals row averages over the visible rows' "
            + "own active months."),
        ],
        averageOver: {
          monthsField: "months_active",
          avgField: ctx.unit === "mt" ? "avg_active_month_mt" : "avg_active_month_nos",
          totalField: ctx.unit === "mt" ? "total_mt" : "total_nos",
        },
      },
      {
        key: "trend_plants",
        lineage: {
          source: "the sales ledger — sales.xlsx › Sheet1 plus the archived extracts: "
              + "Quantity, qty in no, DESP PLANT, BILLING DATE.",
          key: "the invoice line's own DESP PLANT; the unit toggle picks tonnes or "
              + "pieces.",
        },
        section: "trend_plants",
        title: "Despatch plant summary",
        note:
          "Held at the grain the filters cut on — plant, month, length type, angle cut and "
          + "chamferring — rather than pivoted, so the figures stay addable. Angle cut and "
          + "chamferring are properties of the SKU as scheduled, so a material never "
          + "scheduled this month carries neither rather than a guess.",
        columns: [
          ex(txt("plant", "Plant"), "sales.xlsx › Sheet1 › DESP PLANT, as billed."),
          ex(txt("month", "Month"), "The billing month, off sales.xlsx › BILLING DATE."),
          ex(txt("length_type", "Length"),
            "LL where the line's governed length is 4 m or more, CTL below it."),
          ex(bool("angle_cut", "Angle cut"),
            "rm_tracker_model.xlsx › Schedule July › Angle Cut, matched on the "
            + "material code. A property of the SKU as scheduled — a material never "
            + "scheduled this month carries no flag rather than a guess."),
          ex(bool("chamfer", "Chamfer"),
            "rm_tracker_model.xlsx › Schedule July › Chamferring, on the same "
            + "as-scheduled basis."),
          ex(ctx.unit === "mt" ? mt("sales_mt", "Sales MT") : nos("sales_nos", "Sales nos"),
            "The ledger lines at this grain summed — sales.xlsx › Quantity ÷ 1,000 in "
            + "MT, qty in no in pieces. Held at the grain the filters cut on rather "
            + "than pivoted, so the figures stay addable."),
        ],
      },
    ],
  },

  pricingView: {
    label: "SKU pricing",
    note:
      "Every scheduled SKU priced off the customer contract. Prices in different units share "
      + "one table, so no quarter column is ever subtotalled; only schedule tonnage carries "
      + "a sum.",
    scalars: ["sku_pricing", "code_repository"],
    picks: [
      {
        param: "customer",
        label: "Customer",
        from: { section: "sku_pricing", field: "customer" },
        prompt:
          "Select a customer above to see the SKUs priced for it. The code repository "
          + "below covers every customer, because a price change request is raised on the "
          + "code and one code can be billed to several of them.",
      },
    ],
    prefetchDetails: (picks, s) =>
      picks.customer
        ? ((s.sku_pricing?.reco_quarters as string[]) ?? []).map((q) => ({
            key: `RECO|${picks.customer}|${q}`,
            as: `reco:${q}`,
          }))
        : [],
    facts: (s) => {
      const rates = s.sku_pricing?.operation_rates_inr_per_ton ?? {};
      const window = s.code_repository?.window ?? {};
      return [
        { label: "Quarters", value: join(s.sku_pricing?.quarters) },
        ...Object.entries(rates).map(([op, r]) => ({ label: op, value: `${f0(r)} INR/t` })),
        { label: "Repository window", value: `${window.from ?? "—"} to ${window.to ?? "—"}` },
        { label: "Repository source", value: String(window.source ?? "—") },
      ];
    },
    tables: (ctx) => [
      {
        key: "sku_pricing",
        lineage: {
          source: "rm_tracker_model.xlsx › Schedule July (the scheduled lines), priced "
              + "against contract.xlsx › the ERW and CEW sheets: base price per quarter, "
              + "operation rates, kg/m. PO prices and operation sets are the owner's "
              + "overrides, read live.",
          key: "the bucket's OD–ID–thickness → contract.xlsx › Key (dimension1-dimension2-"
              + "thickness), narrowed by route, STKM and HST — each stage falling back "
              + "rather than failing; the row states which route matched.",
        },
        section: "sku_pricing",
        title: "Priced SKUs",
        note:
          "Priced off the contract Key — dimension1-dimension2-thickness — with ERW 2 taking "
          + "the -HST variant wherever the size has one. Each quarter shows the price in the "
          + "SKU's own unit; the per-metre figure and the contract's base per tonne are in "
          + "the build-up the price opens, rather than repeated as two more columns.",
        pickFields: { customer: "customer" },
        columns: [
          ex(txt("customer", "Customer", true),
            "rm_tracker_model.xlsx › Schedule July › Helper Customer — every "
            + "scheduled SKU is priced for the customer scheduling it."),
          ex(txt("material_code", "Material code"),
            "rm_tracker_model.xlsx › Schedule July › MATERIAL NO, recovered through "
            + "Bucketting where the sheet leaves it blank."),
          ex(txt("description", "Description", true),
            "rm_tracker_model.xlsx › Schedule July › MATERIAL DES, as written."),
          ex(txt("bucket", "Bucket", true), "rm_tracker_model.xlsx › Bucketting › Bucket."),
          ex(txt("ctl_bucket", "CTL bucket", true),
            "The bucket with the scheduled finished length appended."),
          ex(txt("kind", "Kind"), "LL or CTL, off the governed length."),
          ex(txt("contract_type", "Contract type"),
            "Which contract.xlsx sheet priced it — ERW off the ERW quarter sheet, CEW "
            + "off the CEW one. An ERW 2 size takes the -HST contract variant "
            + "wherever the size has one."),
          ex(txt("matched_via", "Matched via"),
            "How the size found its contract.xlsx row. The match narrows in stages — "
            + "exact Key (dimension1-dimension2-thickness), then progressively looser "
            + "— and each stage only applies if it still leaves a candidate; this "
            + "names the stage that decided."),
          ex(txt("unit", "Unit"),
            "The unit the SKU is scheduled and priced in: per piece for a cut length, "
            + "per metre or per tonne otherwise."),
          ex({ field: "length_mm", label: "Length mm", kind: "rate" },
            "The scheduled finished length, in millimetres."),
          ex({ field: "kg_per_m", label: "kg/m", kind: "rate" },
            "π × (OD − thickness) × thickness × 7.85 ÷ 1,000 — steel-density weight "
            + "per metre from the size's own geometry. What converts a per-tonne "
            + "contract price into the SKU's unit."),
          // Editable: the schedule's flags are right most of the time and wrong some of
          // it, and every SKU where this view disagrees with the customer's own
          // reconciliation is an operation question. Adding one adds its rung to the
          // build-up and moves the price beside it, here and at the next refresh.
          ex({ ...list("operations", "Operations"), edit: { kind: "operations" } },
            "The value-adding operations priced on top of the base — rm_tracker_model"
            + ".xlsx › Schedule July › FC/NFC, Angle Cut and Chamferring, annealing "
            + "off Bucketting › Annealed — each at its governed INR/tonne rate (the "
            + "fact strip above lists the rates). Editable: adding one adds its rung "
            + "to the build-up and moves the price beside it now; the edit is saved "
            + "and the next rebuild carries it too."),
          ex(mt("schedule_mt", "Schedule MT"),
            "rm_tracker_model.xlsx › Schedule July › SCHEDULE IN MT for this SKU."),
          ex(nos("schedule_qty", "Schedule qty"),
            "rm_tracker_model.xlsx › Schedule July › SCHEDULE in nos."),
          // The price build-up is per quarter, so the key is read out of the row's own
          // map of them rather than off a single field: a SKU repriced in Q4 has a
          // different working behind each column. Three columns per quarter: what the
          // contract prices it at, what the customer's PO says, and the gap.
          ...ctx.quarters.flatMap((q): Column[] => [
            {
              ...ex(drill(
                rate(q, `${q} price`),
                `{detail_keys.${q}}`,
                `{bucket} · ${q} · price build-up`,
              ),
                `The contract price for ${q}, in the SKU's own unit: the matched `
                + "contract.xlsx row's base per tonne, converted through kg/m and the "
                + "length, plus each operation's INR/tonne rung. Click the figure for "
                + "the build-up line by line."),
              priceQuarter: q,
            },
            {
              ...ex(rate(`${q} customer price`, `${q} PO price`),
                "What the customer's own PO says, typed in from the panel — not "
                + "computed. Saved against the SKU and kept across rebuilds."),
              edit: { kind: "po_price", quarter: q },
            },
            ex(rate(`${q} diff`, `${q} diff`),
              "PO price − contract price, in the SKU's unit. Positive means the PO "
              + "pays above contract."),
          ]),
        ],
        // One button per quarter the build holds billing for, and the customer comes from
        // the selector above rather than from a control of its own — the rule the
        // clearance list and the dispatch plan already follow.
        copies: ((ctx.scalars.sku_pricing?.reco_quarters as string[]) ?? []).map((q) => ({
          kind: "calculation" as const,
          arg: q,
        })),
      },
      {
        key: "sku_pricing_unpriced",
        lineage: {
          source: "schedule lines the pricing could not reach.",
          key: "customer × bucket; the reason names what found nothing — no governed bucket, "
              + "or no contract row for the size.",
        },
        section: "sku_pricing_unpriced",
        title: "What cannot be priced",
        note:
          "Two reasons, both reported rather than dropped: the line reaches no governed "
          + "bucket at all, or the bucket is governed and the contract has no row for it.",
        pickFields: { customer: "customer" },
        columns: [
          ex(txt("customer", "Customer", true),
            "rm_tracker_model.xlsx › Schedule July › Helper Customer."),
          ex(txt("bucket", "Bucket", true),
            "The governed bucket, where the line has one at all."),
          ex(txt("reason", "Reason", true),
            "Which of the two gaps it is: the line reaches no governed bucket, or the "
            + "bucket is governed and the contract sheets have no row whose Key "
            + "matches it."),
          ex(mt("schedule_mt", "Schedule MT"),
            "The tonnage scheduled against the unpriceable lines — demand with no "
            + "contract price behind it."),
          ex(cnt("lines", "Lines"), "How many schedule lines share the reason."),
        ],
      },
      {
        key: "code_repository",
        lineage: {
          source: "sales.xlsx › Sheet1 (plus sales_history.xlsx where supplied): CUSTOMER "
              + "CD, SHIP TO PARTY C, DESP PLANT, MATERAIL NUMBER, Quantity, qty in no; "
              + "descriptions through zmat.xlsx.",
          key: "material code; the customer reaches an OEM through OEM_key_1_rev codes "
              + "and the conversion-agent codes.",
        },
        section: "code_repository",
        title: "Code repository",
        note:
          "Built at bill-to x ship-to x plant x material code, because a price change raised "
          + "on the sold-to party alone misses the delivery address it is invoiced against, "
          + "and one customer buys the same SKU under several codes.",
        columns: [
          ex(txt("bill_to_code", "Bill-to code"),
            "sales.xlsx › Sheet1 › CUSTOMER CD — who is invoiced."),
          ex(txt("bill_to_name", "Bill-to", true),
            "sales.xlsx › CUSTOMER NAME, as the file spells it."),
          ex(txt("ship_to_code", "Ship-to code"),
            "sales.xlsx › SHIP TO PARTY C — where it is delivered, which a PCR "
            + "raised on the sold-to alone would miss."),
          ex(txt("ship_to_name", "Ship-to", true),
            "sales.xlsx › SHIPTO PARTY DISC, as the file spells it."),
          ex(txt("plant", "Plant"), "sales.xlsx › DESP PLANT — the despatching plant."),
          ex(txt("material_code", "Material code"),
            "As billed. Scope: the customer's OEM is TVS, or the code is a conversion "
            + "agent's (Megh, Rane) — the codes a price change request can be raised "
            + "on."),
          ex(txt("description", "Description", true), "As billed."),
          ex(txt("bucket", "Bucket", true),
            "The governed bucket the line resolved to, description first, code "
            + "second."),
          ex(txt("ctl_bucket", "CTL bucket", true),
            "The bucket with the billed length appended."),
          ex({ field: "length_mm", label: "Length mm", kind: "rate" },
            "The governed length in millimetres."),
          ex(txt("oem", "OEM"),
            "The customer's OEM off the key; a conversion agent's code shows the OEM "
            + "it converts for."),
          ex(cnt("invoices", "Invoices"),
            "Distinct Billing Document Numbers over the repository window (the fact "
            + "strip above states the window and its source file)."),
          ex(nos("qty_nos", "Qty nos"), "sales.xlsx › qty in no, summed over the window."),
          ex(mt("qty_mt", "Qty MT"), "sales.xlsx › Quantity summed ÷ 1,000 over the window."),
          ex(txt("first_billed", "First billed"), "The earliest BILLING DATE in the window."),
          ex(txt("last_billed", "Last billed"), "The latest BILLING DATE in the window."),
        ],
        // One button per quarter rather than a quarter dropdown: a PCR names the quarter
        // it is raised for, and a control that silently holds last quarter is a wrong
        // price in someone's inbox.
        copies: ctx.quarters.map((q) => ({ kind: "pcr" as const, arg: q })),
      },
    ],
  },

  stockView: {
    label: TAB.stock,
    note:
      "Physical plant stock as material line items, not plant totals, carrying the customer "
      + "the stock is held for — which is what makes an aged lot actionable: it names who it "
      + "can be liquidated to. High age is judged at month end, not at the as-of date.",
    scalars: [],
    tables: () => [
      {
        key: "stock_analysis_ctl",
        lineage: {
          source: "stock.xlsx › PLANT STOCKS: Plant, Material, CUSTOMER NAME, Ageing days, "
              + "MT, NOS — cut-to-length rows; rfd_4731.xlsx › Sheet5: WEIGHT, RFD Qty. "
              + "for the plant 4731 reconciliation.",
          key: "material code → the bucket with the cut length appended (Bucketting › CTL "
              + "Bucket); age bands off each row's Ageing days against the build's as-of.",
        },
        section: "stock_analysis_ctl",
        title: "Cut length",
        note:
          "Plant 4731 rows carry the RFD reconciliation: what the RFD extract accounts for "
          + "and what it does not, with the verdict behind it.",
        columns: [
          ex(txt("plant", "Plant"), "stock.xlsx › PLANT STOCKS › Plant."),
          ex(txt("material_code", "Material code"), "stock.xlsx › PLANT STOCKS › Material."),
          ex(txt("description", "Description", true),
            "stock.xlsx › PLANT STOCKS › Material Description."),
          ex(txt("holder", "Held for", true),
            "stock.xlsx › PLANT STOCKS › CUSTOMER NAME — who each lot can be "
            + "liquidated to, which is what makes an aged lot actionable. TRANSIT "
            + "STOCK marks pipeline material with no owner yet."),
          ex(sev(days("oldest_age_days", "Oldest days"), AGEING),
            "The oldest batch's age *at month end*: stock.xlsx › Ageing days + (month "
            + "end − as-of). How bad the worst batch is — the band columns beside "
            + "Stock MT say how much stands in each age range."),
          drill(
            ex(mt("stock_mt", "Stock MT"),
              "stock.xlsx › PLANT STOCKS › MT summed over the line's batches, "
              + "cut-length rows only. The breakup lists each batch with its ageing. "
              + "This view reads the whole sheet — every OEM, transit included — so "
              + "CTL plus LL reconciles to the sheet's positive rows."),
            "{detail_key}",
            "Cut length · {material_code} · plant {plant}",
          ),
          ex(mt("age_0_30_mt", "0–30 d MT"),
            "The line's tonnage in batches aged 30 days or less at month end. The four "
            + "band columns add up to Stock MT, so the split is the whole figure and "
            + "not a sample of it."),
          ex(mt("age_31_60_mt", "31–60 d MT"),
            "Tonnage aged 31 to 60 days at month end — the last band inside the "
            + "governed 60-day boundary."),
          ex(sev(mt("age_61_180_mt", "61–180 d MT"), { when: "age_61_180_mt", direction: "high", attention: 0 }),
            "Tonnage past the governed 60-day boundary but not yet six months old. "
            + "Amber whenever there is any."),
          ex(sev(mt("age_over_180_mt", "180+ d MT"), { when: "age_over_180_mt", direction: "high", alert: 0 }),
            "Tonnage past 180 days at month end. Red whenever there is any."),
          // A lot with nothing aged has the key but no aged lines behind it, so the
          // guard is on the tonnage rather than on the key.
          drill(
            ex(sev(mt("high_age_mt", "High age MT"), AGED_TONNAGE),
              "Tonnage in batches that will be past 60 days at month end: ageing days "
              + "+ (month end − as-of) > 60. Judged at month end and not at the as-of "
              + "date deliberately — a mid-month refresh would otherwise understate the "
              + "position the KPI is measured on."),
            "{high_age_detail_key}",
            "High age · {material_code} · plant {plant}",
            "high_age_mt",
          ),
          ex(nos("stock_nos", "Stock nos"),
            "stock.xlsx › PLANT STOCKS › NOS, summed over the line's batches."),
          ex(cnt("batches", "Batches"), "How many batches the line's stock stands in."),
          ex(txt("rfd_status", "RFD status"),
            "Plant 4731 only: whether rfd_4731.xlsx › Sheet5 accounts for this "
            + "material's tonnage. The reconciliation compares that sheet's WEIGHT "
            + "(MT) against plant stock, matching through its CTL Code."),
          ex(txt("rfd_verdict", "RFD verdict", true),
            "The reconciliation's conclusion for the material — covered, partly "
            + "covered, or absent from the RFD extract."),
          ex(mt("rfd_matched_mt", "RFD matched MT"),
            "The tonnage the RFD extract accounts for."),
          ex(mt("rfd_unmatched_mt", "RFD unmatched MT"),
            "Plant-stock tonnage the RFD extract does not carry — stock the write-off "
            + "process cannot see."),
          ex(txt("rfd_explanation", "RFD explanation", true),
            "The reconciliation's own note on why the two disagree, where they do."),
        ],
      },
      {
        key: "stock_analysis_ll",
        lineage: {
          source: "stock.xlsx › PLANT STOCKS: Plant, Material, CUSTOMER NAME, Ageing days, "
              + "MT, NOS — long-length rows.",
          key: "material code → Bucketting › Bucket; age bands off each row's Ageing days "
              + "against the build's as-of.",
        },
        section: "stock_analysis_ll",
        title: "Long length",
        columns: [
          ex(txt("plant", "Plant"), "stock.xlsx › PLANT STOCKS › Plant."),
          ex(txt("material_code", "Material code"), "stock.xlsx › PLANT STOCKS › Material."),
          ex(txt("description", "Description", true),
            "stock.xlsx › PLANT STOCKS › Material Description."),
          ex(txt("holder", "Held for", true),
            "stock.xlsx › PLANT STOCKS › CUSTOMER NAME — who each lot can be "
            + "liquidated to. TRANSIT STOCK marks pipeline material with no owner "
            + "yet."),
          ex(sev(days("oldest_age_days", "Oldest days"), AGEING),
            "The oldest batch's age *at month end*: stock.xlsx › Ageing days + (month "
            + "end − as-of). How bad the worst batch is — the band columns beside "
            + "Stock MT say how much stands in each age range."),
          drill(
            ex(mt("stock_mt", "Stock MT"),
              "stock.xlsx › PLANT STOCKS › MT summed over the line's batches, "
              + "long-length rows only. The breakup lists each batch with its "
              + "ageing."),
            "{detail_key}",
            "Long length · {material_code} · plant {plant}",
          ),
          ex(mt("age_0_30_mt", "0–30 d MT"),
            "The line's tonnage in batches aged 30 days or less at month end. The four "
            + "band columns add up to Stock MT, so the split is the whole figure and "
            + "not a sample of it."),
          ex(mt("age_31_60_mt", "31–60 d MT"),
            "Tonnage aged 31 to 60 days at month end — the last band inside the "
            + "governed 60-day boundary."),
          ex(sev(mt("age_61_180_mt", "61–180 d MT"), { when: "age_61_180_mt", direction: "high", attention: 0 }),
            "Tonnage past the governed 60-day boundary but not yet six months old. "
            + "Amber whenever there is any."),
          ex(sev(mt("age_over_180_mt", "180+ d MT"), { when: "age_over_180_mt", direction: "high", alert: 0 }),
            "Tonnage past 180 days at month end. Red whenever there is any."),
          drill(
            ex(sev(mt("high_age_mt", "High age MT"), AGED_TONNAGE),
              "Tonnage in batches that will be past 60 days at month end: ageing days "
              + "+ (month end − as-of) > 60. Judged at month end so a mid-month "
              + "refresh does not understate the position."),
            "{high_age_detail_key}",
            "High age · {material_code} · plant {plant}",
            "high_age_mt",
          ),
          ex(nos("stock_nos", "Stock nos"),
            "stock.xlsx › PLANT STOCKS › NOS, summed over the line's batches."),
          ex(cnt("batches", "Batches"), "How many batches the line's stock stands in."),
        ],
      },
      {
        key: "stock_source_coverage",
        lineage: {
          source: "every stock, WIP and RFD read of this build, tallied per source.",
          key: "per source file: the rows and tonnage whose material code resolved a bucket, "
              + "against those that did not.",
        },
        section: "stock_source_coverage",
        title: "Bucket mapping coverage by source",
        note:
          "How much of each inventory source reaches a governed bucket. The unmapped "
          + "percentage is a rate per source and carries no total.",
        columns: [
          ex(txt("source", "Source"), "The inventory source being measured."),
          ex(txt("file", "File"), "The dump file that source is read from."),
          ex(cnt("rows", "Rows"), "Rows read from the source."),
          ex(cnt("unmapped_rows", "Unmapped rows"),
            "Rows whose material resolves to no governed bucket — neither its "
            + "description nor its code reaches Bucketting."),
          ex(mt("total_mt", "Total MT"), "The source's whole tonnage."),
          ex(mt("mapped_mt", "Mapped MT"), "Tonnage that reached a governed bucket."),
          drill(
            ex(mt("unmapped_mt", "Unmapped MT"),
              "Tonnage that reached none — invisible to every tracker until somebody "
              + "maps it, which is what the Missing mappings tab is for. The breakup "
              + "lists the rows."),
            "{detail_key}",
            "{source} · stock that reaches no governed bucket",
          ),
          ex(pct("unmapped_pct", "Unmapped %"),
            "Unmapped MT ÷ total MT, per source. A rate — no total."),
        ],
      },
    ],
  },

  strView: {
    label: TAB.str,
    note:
      "Fifteen days of forward cover at plant 8406 for the Hosur ancillary cluster. The "
      + "grain is Bucket alone — not CTL bucket and not per customer: 8406 cuts to length on "
      + "site, and a single STR line serves whichever plan customer draws on it first.",
    scalars: ["str_plan"],
    facts: (s) => [
      { label: "Destination plant", value: String(s.str_plan?.destination_plant ?? "—") },
      { label: "Target cover", value: `${s.str_plan?.target_days ?? "—"} days` },
      { label: "Source plants", value: join(s.str_plan?.source_plants) },
      { label: "Plan customers", value: join(s.str_plan?.customers) },
    ],
    tables: () => [
      {
        key: "str_plan",
        lineage: {
          source: "rm_tracker_model.xlsx › Schedule July: SCHEDULE IN MT for the plan "
              + "customers. stock.xlsx › PLANT STOCKS: MT (at 8406 and at the source "
              + "plants). wip.xlsx: Total Stock. transfer.xlsx: Quantity, GR DATE for the "
              + "in-transit figure.",
          key: "one row per governed bucket (Bucketting › Bucket); the requirement is the "
              + "target days × the bucket's daily schedule rate, less what 8406 already "
              + "holds or has inbound.",
        },
        section: "str_plan",
        title: "Requirement and cover by bucket",
        note:
          "Daily MT is the run rate the requirement is built from; coverage days is a rate "
          + "per bucket and carries no total.",
        columns: [
          ex(txt("bucket", "Bucket", true),
            "The governed bucket, one row per bucket the plan's customers schedule at "
            + "8406."),
          ex(sev(txt("risk", "Risk"), { words: RISK_WORDS }),
            "The plan's verdict: Short where an STR remains unallocated after the "
            + "waterfall, Covered otherwise. The coloured figures on the row take their "
            + "ink from this word."),
          ex(list("customers", "Customers"),
            "The plan customers scheduling this bucket at 8406 this month."),
          ex(list("cut_lengths", "Cut lengths mm"),
            "The finished lengths those customers schedule — 8406 cuts to length on "
            + "site, which is why the plan's grain is the bucket alone."),
          ex(mt("schedule_mt", "Schedule MT"),
            "rm_tracker_model.xlsx › Schedule July › SCHEDULE IN MT — the plan "
            + "customers' schedule on this bucket this month."),
          ex(mt("sales_mt", "Sales MT"),
            "sales.xlsx › Sheet1 › Quantity ÷ 1,000 dispatched against it so far "
            + "this month."),
          ex(mt("balance_mt", "Balance MT"), "Schedule less sales, floored at zero."),
          ex({ field: "daily_mt", label: "Daily MT", kind: "mt", total: true },
            "The run rate: schedule ÷ days in the month. The requirement is built from "
            + "this."),
          ex(mt("requirement_mt", "Requirement MT"),
            "Daily MT × the target cover in days — what 8406 should be holding."),
          ex(mt("owned_8406_mt", "Owned at 8406 MT"),
            "stock.xlsx › PLANT STOCKS › MT at plant 8406 — standing on the ground."),
          ex(mt("in_transit_mt", "In transit MT"),
            "transfer.xlsx › Quantity ÷ 1,000 on lines despatched to 8406 with no "
            + "goods receipt yet — an empty GR DATE is the in-transit flag."),
          drill(
            ex(sev(mt("stock_8406_mt", "Stock at 8406 MT"), { from: "risk", words: RISK_WORDS }),
              "Owned plus in transit — what 8406 has or is about to have. The breakup "
              + "lists both."),
            "{stock_detail_key}",
            "{bucket} · stock at 8406 including in transit",
          ),
          // Banded off `risk`, not off the number: this plan's target is 15 days where
          // the long-length tracker's is 45, so a threshold on `coverage_days` would be
          // right on one tab and wrong on the other. A 20-day cover is Covered here.
          ex(sev(days("coverage_days", "Cover days"), { from: "risk", words: RISK_WORDS }),
            "Stock at 8406 ÷ daily MT — days of demand the plant is holding. Judged "
            + "against this plan's own target (see the facts above the tables), not the "
            + "LL tracker's 45."),
          ex(mt("str_required_mt", "STR required MT"),
            "max(requirement − stock at 8406, 0): what has to move to reach target "
            + "cover."),
          ex(mt("str_allocated_mt", "STR allocated MT"),
            "What the source plants can actually supply: the requirement drained across "
            + "their stock largest-first, each lot claimed once — the lines below show "
            + "the allocation."),
          // A shortfall above zero is exactly what `Short` means, so it reads the verdict
          // rather than restating the test.
          ex(sev(mt("str_shortfall_mt", "Shortfall MT"), { from: "risk", words: RISK_WORDS }),
            "Required less allocated: the tonnage no source plant can cover. Above zero "
            + "is exactly what Short means."),
          drill(
            ex(mt("source_stock_mt", "Source stock MT"),
              "Long-length stock of this bucket at the source plants before "
              + "allocation — stock.xlsx › PLANT STOCKS › MT plus wip.xlsx › Total "
              + "Stock. The breakup lists it plant by plant."),
            "{source_detail_key}",
            "{bucket} · stock at the source plants",
          ),
          ex(list("source_plants", "Source plants"),
            "The plants whose stock the allocation drew on for this bucket."),
        ],
        copies: [{ kind: "str" }],
      },
      {
        key: "str_lines",
        lineage: {
          source: "the source-plant stock lines the plan drew on — stock.xlsx, and WIP mother "
              + "tubes carrying an FG code from zmat.",
          key: "governed bucket; allocated long lengths first, finished goods before WIP, "
              + "largest holding first, until the requirement is met.",
        },
        section: "str_plan",
        title: "STR lines to raise",
        note: "The allocation behind the plan, one line per source material, in copy order.",
        flatten: (rows) =>
          rows.flatMap((row) => {
            const lines = Array.isArray(row.str_lines) ? row.str_lines : [];
            return (lines as Record<string, unknown>[]).map((line) => ({
              bucket: row.bucket,
              ...line,
            }));
          }),
        columns: [
          ex(txt("bucket", "Bucket", true), "The bucket the STR line supplies."),
          ex(txt("plant", "Plant"), "The source plant's code."),
          ex(txt("plant_label", "Source plant", true), "The source plant, named."),
          ex(txt("material_code", "Material code"),
            "The finished-goods code the STR is raised on. For WIP this is recovered "
            + "by swapping the mother tube's PTM- description to TUB- and finding "
            + "that code in zmat.xlsx (MATERIAL TYPE = FERT) — an STR cannot be "
            + "raised on a mother tube itself."),
          ex(txt("description", "Description", true), "As the source sheet writes it."),
          ex(txt("source", "Source"),
            "Which pool the line draws on: plant stock (stock.xlsx) or WIP "
            + "(wip.xlsx)."),
          ex(bool("from_wip", "From WIP"),
            "Yes where the line drains WIP rather than finished stock."),
          ex(txt("remark", "Remark", true), "The allocation's own note, where it has one."),
          ex(mt("available_mt", "Available MT"),
            "What the lot held before this plan drew on it."),
          ex(mt("qty_mt", "STR MT"),
            "What this line takes: the bucket's requirement drained across the source "
            + "lots largest-first, each lot claimed once, stopping when the "
            + "requirement is met. In copy order for raising the STRs."),
        ],
      },
      {
        key: "unmapped_destination_stock",
        lineage: {
          source: "stock.xlsx rows at 8406 whose code reached no governed bucket.",
          key: "material code.",
        },
        scalar: ["str_plan", "unmapped_destination_stock"],
        title: "Stock at 8406 reaching no plan bucket",
        columns: [
          ex(txt("customer_name", "Held for", true),
            "stock.xlsx › PLANT STOCKS › CUSTOMER NAME on the 8406 rows that resolve "
            + "to no bucket the plan tracks."),
          ex(txt("customer_code", "Customer code"), "As the stock.xlsx row writes it."),
          ex(mt("stock_mt", "Stock MT"),
            "Tonnage at 8406 the plan cannot see — held against no plan bucket, so "
            + "no coverage counts it."),
        ],
      },
      {
        key: "wip_without_fg_code",
        lineage: {
          source: "wip.xlsx rows whose mother tube names no finished-goods code.",
          key: "mother-tube code → zmat's FG code, which found nothing.",
        },
        scalar: ["str_plan", "wip_without_fg_code"],
        title: "Mother tube with no finished-goods code",
        note:
          "No TUB- equivalent exists in zmat for these descriptions, so no STR can be raised "
          + "on them however much WIP is standing.",
        columns: [
          ex(txt("plant", "Plant"), "Where the mother tube is standing, off wip.xlsx."),
          ex(txt("bucket", "Bucket", true), "The bucket its description resolves to."),
          ex(txt("description", "Description", true),
            "The mother tube's PTM- description. No TUB- equivalent exists in zmat, so "
            + "there is no finished-goods code to raise an STR on."),
          ex(mt("wip_mt", "WIP MT"),
            "The tonnage standing unraisable — cover the STR plan can see but cannot "
            + "move."),
        ],
      },
    ],
  },

  transferView: {
    label: "Transfers",
    note:
      "Inter-plant despatches. A line is in transit until the receiving plant posts a goods "
      + "receipt, so an empty GRN date is the in-transit flag and days in transit runs to the "
      + "as-of date while the line is open.",
    scalars: ["transfers"],
    facts: (s) => [
      { label: "Sending plants", value: (s.transfers?.plants?.source ?? []).map((p: any) => p.label).join("; ") || "—" },
      { label: "Receiving plants", value: (s.transfers?.plants?.destination ?? []).map((p: any) => p.label).join("; ") || "—" },
      ...(s.transfers?.note ? [{ label: "Note", value: String(s.transfers.note) }] : []),
    ],
    tables: () => [
      {
        key: "transfers",
        lineage: {
          source: "the accumulated transfers ledger — transfer.xlsx, every line since "
              + "8 July: DESP PLANT, CUSTOMER CD, MATERAIL NUMBER, Quantity, qty in no, "
              + "BILLING DATE, GR DATE.",
          key: "material code → Bucketting › Bucket; one row per movement, sending plant "
              + "→ receiving plant, merged on billing document + item so a later dump "
              + "fills in GR DATE.",
        },
        section: "transfers",
        title: "Despatched transfer lines",
        note:
          "Only rows whose invoice type is a transfer. An empty result after that filter "
          + "means the file is not a transfer extract — the daily mail has more than once "
          + "carried the sales dump under the transfer filename.",
        columns: [
          ex(txt("source_plant_label", "From", true),
            "transfer.xlsx › DESP PLANT — the sending plant, named from the file's "
            + "own PLANT DESC."),
          ex(txt("dest_plant_label", "To", true),
            "transfer.xlsx › CUSTOMER CD / CUSTOMER NAME — which on a transfer names "
            + "the receiving plant, not a customer."),
          ex(txt("document", "Billing doc"), "transfer.xlsx › the line's billing document number."),
          ex(txt("sto_no", "STO no"), "transfer.xlsx › DO/STO NO, as written."),
          ex(txt("material_code", "Material code"),
            "transfer.xlsx › MATERAIL NUMBER, as written."),
          ex(txt("description", "Description", true),
            "transfer.xlsx › Material Description, as written."),
          ex(txt("bucket", "Bucket", true),
            "Resolved through rm_tracker_model.xlsx › Bucketting — code first, "
            + "description second."),
          ex(txt("ctl_bucket", "CTL bucket", true),
            "The bucket with the governed length appended."),
          ex(txt("length_type", "Length"),
            "LL where the governed length is 4 m or more, CTL below it."),
          ex(txt("billing_date", "Billed"), "transfer.xlsx › BILLING DATE — when it left."),
          ex(txt("grn_date", "GRN"),
            "transfer.xlsx › GR DATE — when the receiving plant posted its goods "
            + "receipt. Empty is the in-transit flag: the line is still on the road."),
          ex(txt("status", "Status"),
            "In transit where GRN is empty, Received otherwise."),
          ex(days("transit_days", "Transit days"),
            "GRN date − billing date once received; as-of date − billing date while "
            + "still open, so an open line keeps aging."),
          ex(txt("mark_customer", "Marked for", true),
            "transfer.xlsx › MARK DESTINATION, or MARK CUSTOMER where destination is "
            + "blank — who the material is intended for on arrival."),
          drill(
            ex(mt("qty_mt", "Qty MT"),
              "transfer.xlsx › Quantity summed ÷ 1,000 over the grouped lines — the "
              + "file carries kilograms. The breakup lists the batches. Later dumps "
              + "fill in GR DATE on lines already held, which is why this table "
              + "merges rather than appends: appending once read 445 lines in transit "
              + "against a true 218."),
            "{detail_key}",
            "{source_plant_label} → {dest_plant_label} · {material_code}",
          ),
          ex(nos("qty_nos", "Qty nos"),
            "transfer.xlsx › qty in no, summed over the group."),
          ex(cnt("batches", "Batches"), "Distinct batches in the group."),
        ],
      },
    ],
  },

  overdueView: {
    label: "Ancillary overdue",
    note:
      "A receivable falls due 47 days after its invoice date — the governed term, which "
      + "replaces both the per-document net due date and the file's own due flag. Only "
      + "billing documents are counted; debit balances, credit notes and collections are "
      + "not invoices to chase.",
    scalars: [],
    tables: () => [
      {
        key: "overdue_analysis",
        lineage: {
          source: "yf65.xlsx › Sheet1: Customer Code, Customer Name, Doc Type, Nature, "
              + "Document Date, Open Amount, Billing Doc — narrowed to the TVS ancillary "
              + "customers.",
          key: "yf65 › Customer Name → OEM_key_1_rev codes; ageing off Document Date + 47 "
              + "days against the build's as-of; the remark column is written on this "
              + "tab, keyed on Billing Doc.",
        },
        section: "overdue_analysis",
        title: "By ancillary",
        note:
          "Amounts in INR. Oldest days is a per-row age and carries no total. The gross "
          + "debit and credit components of the net are recorded in the run's QC summary "
          + "rather than shown here, where they sat between the figure and its ageing.",
        columns: [
          ex(txt("ancillary", "Ancillary", true),
            "yf65.xlsx › Sheet1 › Customer Name, resolved to OEM TVS through "
            + "rm_tracker_model.xlsx › OEM_key_1_rev codes, after conversion-agent "
            + "routing."),
          ex(txt("customer_code", "Customer code"), "yf65.xlsx › Customer Code."),
          // Banded by how old the money is, not by how much it is: a large receivable a
          // week past due is a call, and a small one two years past due is a write-off.
          drill(
            ex(sev(inr("overdue_amount", "Overdue INR"), {
              from: "oldest_days",
              direction: "high",
              alert: OVERDUE_ALERT_DAYS,
              attention: 1,
            }),
              "yf65.xlsx › Open Amount summed over open billing documents (Doc Type "
              + "RV or RD — actual invoices, not credit notes or balances) past due. "
              + "Due date is Document Date + 47 days — the governed term, which "
              + "replaces the file's own due flag: its Net Due Date sits 0, 45 or 51 "
              + "days from the document date depending on the row. The colour follows "
              + "the oldest document's age, not the amount — a large receivable a "
              + "week late is a call, a small one two years late is a write-off. The "
              + "breakup lists the invoices, oldest first."),
            "{detail_key}",
            "Overdue · {ancillary}",
          ),
          ex(cnt("documents", "Documents"), "How many overdue invoices the figure adds."),
          ex(sev(days("oldest_days", "Oldest days"), {
            direction: "high",
            alert: OVERDUE_ALERT_DAYS,
            attention: 1,
          }),
            "As-of date − due date for the oldest open invoice. Every row on this tab "
            + "is already past due, so amber starts at day one; red at 90."),
          // Every rupee in this column is past 90 days by construction, so any non-zero
          // figure is the alert and the band needs no second boundary.
          ex(sev(inr("over_90_days_amount", "Over 90 days INR"), {
            when: "over_90_days_amount",
            direction: "high",
            alert: 1,
          }),
            "The overdue restricted to invoices more than 90 days past due. Every "
            + "rupee here is past 90 by construction, so any non-zero figure is red."),
          // An ancillary with no open credit note has the key and nothing behind it.
          drill(
            ex(inr("offsets_amount", "Offsets INR"),
              "yf65.xlsx › Open Amount on documents that *reduce* what is owed — "
              + "Nature is CREDIT NOTE, OTHER CREDIT BALANCE or COLLECTION. Told by "
              + "Nature, never by Doc Type, which cannot decide it (AB carries both "
              + "credit and debit balances). Debit balances are excluded: they add to "
              + "the exposure, and netting them in once made the figure a net of two "
              + "unrelated things. Shown beside the overdue, never subtracted from "
              + "it."),
            "{offsets_detail_key}",
            "Open payments and credit notes · {ancillary}",
            "offsets_documents",
          ),
          ex(cnt("offsets_documents", "Offset documents"),
            "How many open credit documents the offsets figure adds."),
        ],
      },
    ],
  },
};
