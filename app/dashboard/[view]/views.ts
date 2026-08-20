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
   * reads the master" policy, which is what makes this readable at all.
   */
  master?: "bucketting" | "oem_key";
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
  unit === "mt" ? mt("total_mt", "Total MT") : nos("total_nos", "Total nos");

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
};

const asText = (v: string | ((row: Row) => string)) =>
  typeof v === "function" ? v : () => v;

/** A column with its derivation note, for the header's ⓘ. */
const ex = (column: Column, explain: string): Column => ({ ...column, explain });

const queue = (q: QueueSpec): TableSpec => ({
  key: q.key,
  section: q.section,
  title: q.title,
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
  txt("OEM", "OEM"),
  txt("customer_display", "Customer", true),
  txt("ctl_bucket", "SKU / CTL bucket", true),
  txt("Plant", "Plant"),
  cnt("schedule_qty", "Schedule Qty"),
  cnt("sales_qty", "Dispatch Qty"),
  cnt("balance_qty", "Balance Qty"),
  mt("schedule_mt", "Schedule MT"),
  mt("sales_mt", "Dispatch MT"),
  mt("balance_mt", "Balance MT"),
  drill(
    { field: "ctl_stock_pool_nos", label: "CTL stock NOS", kind: "nos" },
    "{ctl_stock_detail_key}",
    "{customer_display} · {ctl_bucket} · CTL stock",
  ),
  drill(
    pool("ll_stock_pool_mt", "LL stock MT"),
    "{ll_stock_detail_key}",
    "{customer_display} · {bucket} · LL stock",
  ),
  drill(
    { field: "history_avg_month_mt", label: "Avg month sales", kind: "mt" },
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
          txt("customer_display", "Customer", true),
          txt("OEM", "OEM"),
          cnt("schedule_lines", "Lines"),
          mt("schedule_mt", "Schedule MT"),
          cnt("schedule_qty", "Schedule NOS"),
          mt("sales_mt", "Dispatch MT"),
          cnt("sales_qty", "Dispatch NOS"),
          mt("balance_mt", "Balance MT"),
          cnt("balance_qty", "Balance NOS"),
          cnt("unresolved_sales_lines", "Unresolved sales lines"),
        ],
      },
      {
        key: "customer_lines",
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
          txt("sku", "SKU", true),
          txt("bucket", "Bucket", true),
          { field: "length_m", label: "Length m", kind: "rate" },
          txt("length_type", "Type"),
          bool("on_schedule", "On schedule"),
          ...monthColumns(ctx.months, ctx.unit),
          drill(
            unitTotal(ctx.unit),
            "{detail_key}",
            "{customer} · {sku} · sales month by month",
          ),
          ctx.unit === "mt" ? nos("total_nos", "Total nos") : mt("total_mt", "Total MT"),
          cntNoTotal("months_active", "Months"),
          ctx.unit === "mt"
            ? { field: "avg_active_month_mt", label: "Avg active month MT", kind: "mt" }
            : { field: "avg_active_month_nos", label: "Avg active month nos", kind: "nos" },
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
          list("materials", "Material codes"),
          txt("od", "OD"),
          txt("inner_d", "ID"),
          txt("thickness", "Thickness"),
          { field: "length_m", label: "Length m", kind: "rate" },
          txt("grade", "Grade"),
          txt("cut_type", "Cut type"),
          txt("bucket", "Bucket", true),
          txt("end_oem", "End OEM"),
          bool("bop", "BOP"),
          // Every figure on this tab is guarded by itself. The plan writes a key onto
          // each row whether or not the SKU has any of that thing, and the breakup for
          // a zero was never built — 64 of the 73 SKUs sold nothing this month. So a
          // zero here is a zero, not a button that opens an explanation of nothing.
          drill(
            mt("schedule_mt", "Schedule MT"),
            "MEGHSCHEDULE|{sku}",
            "{sku} · schedule",
            "schedule_mt",
          ),
          // Ground and in transit are the two halves of one pool. They were their own
          // columns and are now the breakup behind it: what is asked of this figure is
          // "how much is there", and the split is the follow-up question.
          drill(
            mt("total_stock_mt", "VSM stock MT"),
            "{stock_detail_key}",
            "{sku} · ground plus in transit",
            "total_stock_mt",
          ),
          drill(
            mt("orders_logged_mt", "Orders as per OMS MT"),
            "{orders_detail_key}",
            "{sku} · orders logged as per OMS",
            "orders_logged_mt",
          ),
          drill(
            mt("orders_planning_mt", "Orders as per sales planning MT"),
            "{orders_plan_detail_key}",
            "{sku} · orders logged as per sales planning, plant by plant",
          ),
          // Both halves of the split open the same breakup, which carries the three
          // quantity columns side by side; only the heading says which half was clicked.
          drill(
            mt("signoff_mt", "Signed off MT"),
            "{signoff_detail_key}",
            "{sku} · signed off",
            "signoff_mt",
          ),
          drill(
            mt("non_signoff_mt", "Not signed off MT"),
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
            mt("sales_mt", "Sales to Megh MT"),
            "{sales_detail_key}",
            "{sku} · sales to Megh, month by month",
            "sales_months",
          ),
          drill(
            mt("stock_at_length_mt", "TSL stock in VSM length MT"),
            "{at_length_detail_key}",
            "{sku} · long length at required size",
            "stock_at_length_mt",
          ),
          drill(
            mt("other_length_stock_mt", "TSL stock in non-VSM length MT"),
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
        section: "megh_bop_added",
        title: "Bought-out sizes added off plan",
        note:
          "A listed BOP size with no plan row within 50 mm becomes its own line. The band "
          + "was 200 mm and pulled a 6.0 m size onto a 5.8 m row; a gap that size is a "
          + "separate line item.",
        columns: [
          txt("sku", "SKU", true),
          txt("stated_size", "Stated size"),
          cnt("nos", "Nos"),
          txt("plant", "Plant"),
          txt("reason", "Reason", true),
        ],
      },
      {
        key: "megh_length_bucketing",
        section: "megh_length_bucketing",
        title: "Megh length bucketing",
        note:
          "The plan's own length-specific mapping, built because Bucketting does not carry "
          + "every code the plan names. Codes missing from Bucketting is a live queue.",
        columns: [
          txt("vsm_key", "Plan key", true),
          txt("bucket", "Bucket", true),
          { field: "length_m", label: "Length m", kind: "rate" },
          txt("grade", "Grade"),
          txt("cut_type", "Cut type"),
          txt("end_oem", "End OEM"),
          bool("megh_only", "Megh only"),
          bool("tracked_on_megh_tab", "On Megh tab"),
          txt("material_codes", "Material codes", true),
          txt("plants", "Plants"),
          cnt("codes_total", "Codes"),
          cnt("codes_in_bucketting", "In Bucketting"),
          txt("codes_missing_from_bucketting", "Codes not in Bucketting", true),
          mt("schedule_mt", "Schedule MT"),
          mt("stock_mt", "Stock MT"),
          txt("plan_note", "Plan note", true),
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
        section: "ll_tracker",
        title: "Coverage by bucket",
        note:
          "Last month's billing sits beside this month's sales. It is TSL's own billing "
          + "and does not carry Megh's dispatch onward to TVSM, so it is not meant to tie "
          + "to Total sales beside it.",
        columns: [
          ex(txt("bucket", "Bucket", true),
            "The governed bucket, from Bucketting: OD-ID-thickness-grade-endcondition. "
            + "One row per long-length bucket any TVS-scope customer schedules."),
          ex(sev(txt("risk", "Risk"), { words: RISK_WORDS }),
            "The pipeline's verdict on Cover days: below 15 is Critical, below 30 Low, "
            + "below 45 Watch, 45 and past it Adequate; a bucket with no schedule reads "
            + "No demand. Every coloured figure on this row takes its ink from this "
            + "word, so the numbers and the verdict can never disagree."),
          drill(
            ex(mt("total_schedule_mt", "Schedule MT"),
              "This month's schedule for the bucket, summed over the TVS-scope customers "
              + "scheduling it — TSL's own schedule sheet plus the TVSM tracker's "
              + "requirement. The breakup behind the figure names each contributor."),
            "LLSCHEDULE|{bucket}",
            "{bucket} · total schedule breakup",
          ),
          drill(
            ex(mt("total_sales_mt", "Sales MT"),
              "Dispatched against that schedule this month: TSL billing plus the TVSM "
              + "tracker's own sales figure. The breakup names both."),
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
              "One pool: plant stock at long length, plus WIP, plus material in transit, "
              + "plus the TVSM tracker's own stock — the breakup names all four sources. "
              + "Stock resolves to the bucket through Bucketting; unresolved WIP is "
              + "excluded and reported on Missing mappings instead."),
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
              "Open order lines on this bucket from the order-book sheets, summed. The "
              + "breakup lists them plant by plant."),
            "{order_detail_key}",
            "{bucket} · orders logged, plant by plant",
          ),
          drill(
            ex(mt("signoff_mt", "Signed MT"),
              "Tonnage signed off against this bucket on the per-plant sign-off sheets. "
              + "The breakup lists the lines."),
            "{signoff_detail_key}",
            "{bucket} · signed off",
            "signoff_mt",
          ),
          drill(
            ex(mt("last_month_sales_mt", "Last month MT"),
              "TSL's own billing for this bucket last month, off the sales ledger. It "
              + "does not carry Megh's onward dispatch, so it is not meant to tie to "
              + "Total sales. The breakup shows the months."),
            "{history_detail_key}",
            "{bucket} · billed month by month",
          ),
        ],
      },
      {
        key: "orders_summary",
        scalar: ["orders", "summary"],
        title: "Order book by origin",
        note:
          "Lines marked c in a sheet's remarks column are not live demand and pool into no "
          + "tracker; they are counted here as excluded so a smaller order column reads as "
          + "the filter working, not as demand collapsing.",
        columns: [
          txt("origin", "Origin"),
          txt("sheet", "Sheet"),
          txt("basis", "Basis", true),
          cnt("lines", "Live lines"),
          mt("order_mt", "Order MT"),
          cnt("lines_in_sheet", "Lines in sheet"),
          cnt("excluded_lines", "Excluded lines"),
          mt("excluded_mt", "Excluded MT"),
          txt("age_basis", "Age basis"),
          days("oldest_order_days", "Oldest days"),
        ],
      },
      {
        key: "orders",
        section: "orders",
        title: "Order book",
        note:
          "Every order line the sales-planning book carries, including the excluded ones, "
          + "flagged rather than dropped. The total below covers both, so read it against "
          + "the live figure on the summary above.",
        columns: [
          txt("origin", "Origin"),
          txt("sheet", "Sheet"),
          txt("kind", "Kind"),
          txt("plant", "Plant"),
          txt("order_no", "Order no"),
          txt("customer", "Customer", true),
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("bucket", "Bucket", true),
          { field: "length_m", label: "Length m", kind: "rate" },
          txt("basis", "Basis", true),
          txt("remark", "Remark"),
          bool("excluded", "Excluded"),
          days("age_days", "Age days"),
          mt("order_mt", "Order MT"),
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
      + "Under them are the three masters themselves, each editable in the same way — that "
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
        section: "missing_mappings",
        title: "Materials, customers and scheduled sizes",
        note:
          "Sizes a customer schedules that no bucket governs appear here in the form the "
          + "customer sent them. A row reading lookup error is a bug, not a gap.",
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
        extras: [txt("mapping_type", "Type"), txt("customer_code", "Customer code")],
        assign: { scope: "bucket", label: "Assign bucket" },
      }),
      queue({
        key: "megh_unmapped",
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
        extras: [txt("length_type", "Length"), cnt("batches", "Batches")],
        assign: { scope: "bucket", label: "Assign bucket" },
      }),
      queue({
        key: "wip_unmapped",
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
        extras: [txt("code_bucket", "Code bucket", true), cnt("batches", "Batches")],
        assign: { scope: "bucket", label: "Assign bucket" },
      }),
      queue({
        key: "rfd_unmapped",
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
          txt("matched_materials", "Matched materials", true),
          { field: "length_m", label: "Length m", kind: "rate" },
          nos("stock_nos", "Stock nos"),
        ],
        assign: { scope: "ctl_bucket", label: "Assign CTL bucket" },
      }),
      queue({
        key: "orders_unmapped",
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
          txt("shown_on", "Still shown on", true),
          txt("kind", "Kind"),
          txt("order_no", "Order no"),
          txt("bucket", "Bucket", true),
          txt("sku", "SKU", true),
          days("age_days", "Age days"),
        ],
        assign: { scope: "bucket", label: "Assign bucket" },
      }),
      queue({
        key: "signoff_unmapped",
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
          txt("bucket", "Bucket", true),
          txt("sku", "SKU", true),
          mt("signed_mt", "Signed MT"),
          mt("unsigned_mt", "Not signed MT"),
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
        title: "Master · Bucketting: material code to governed bucket",
        note:
          "What Bucketting governs by hand. The pipeline resolves far more codes than this "
          + "by matching physical attributes against these rows, so a code absent here is "
          + "not necessarily unmapped — it is unmapped *directly*, and the bucket it "
          + "resolves to is only as right as the row it was learned from.",
        master: "bucketting" as const,
        unmapped: ["bucket", "__assign_bucket"],
        columns: [
          ex(txt("material_code", "Material code"),
            "The Bucketting sheet's own Material Codes column, read live from the "
            + "accumulated master — not from the build, so a row added this morning is "
            + "already here."),
          ex(txt("bucket", "Governed bucket", true),
            "The bucket this sheet states for the code, shaped OD-ID-thickness-grade-"
            + "endcondition. This is the statement the whole dashboard is governed by: "
            + "TVSM ancillaries sales, stock, WIP and the schedule all classify through "
            + "it, and the pipeline also learns from these rows to resolve codes with "
            + "identical physical attributes that the sheet does not name."),
          ex(txt("ctl_bucket", "CTL bucket", true),
            "The sheet's CTL Bucket column: the bucket with the cut length appended. "
            + "Read only by the RFD 4731 reconciliation, which resolves through this "
            + "column and never through the governed bucket."),
          ex(txt("ll_or_ctl", "LL or CTL"),
            "As the sheet states it: whether the code is a long-length or a cut-to-"
            + "length material."),
          assignIn("bucket", "Reassign bucket", "material_code", "buckets"),
        ],
      },
      {
        key: "oem_key",
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
            "The OEM key's own Customer column, read live from the accumulated master. "
            + "Sales rows join to it by customer *name*, normalised on both sides — "
            + "trimmed, uppercased — never by customer code."),
          ex(txt("oem", "OEM"),
            "The OEM this customer's sales are classified under. This single mapping "
            + "feeds the sales frame, the schedule, stock, receivables, the code "
            + "repository and the trend — and the LL tracker's TVS scope is every "
            + "customer this column says TVS for. One exception overrides it: a material "
            + "group ending BOT, COR or AHT is classified Boiler regardless."),
          ex(txt("cam", "CAM"),
            "As the sheet states it. Not read by any calculation; carried for reference."),
          // Writable since 19 August, and not before: the box exists because
          // `refresh_dashboard.py` now applies an `oem` assignment over `oem_map` where
          // that map is built. It was drawn once without that and withdrawn the same
          // night — a cell that saves, reads back and moves nothing is worse than no cell.
          assignIn("oem", "Reassign OEM", "customer", "oems"),
        ],
      },
      {
        key: "length_key",
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
            "The plan's own length key column, taken as written — the pipeline derives "
            + "one from the plan's key and Length only for a row that states none. A "
            + "Megh- prefix marks a size supplied onward to RE or HMSIL rather than to "
            + "TVSM."),
          ex(txt("bucket", "Governed bucket", true),
            "The plan's key column where the size is TVSM-bound; empty for a Megh- "
            + "prefixed size, which has no governed bucket by design. Where both this "
            + "plan and Bucketting name the same material code, the two must agree."),
          ex(txt("material_codes", "Material codes", true),
            "The codes the plan's plant columns (056, 0789, 0788) name for this SKU. "
            + "This list *is* the mapping: a Megh purchase or stock line lands on this "
            + "SKU only if its code is here or you assign it on this tab. Nothing is "
            + "inferred."),
          ex(txt("plants", "Plants"),
            "Which of the plan's plant columns named a code for this SKU."),
          ex(txt("end_oem", "Ends at"),
            "Where the size finally goes. TVSM for a plain key; for a Megh- size, the "
            + "OEM whose conversion-agent code (943210 HMSIL, 943211 RE) actually bought "
            + "it — or both names where no code has bought it yet."),
          ex(txt("cut_type", "Cut type"),
            "The plan's FC/NFC column where it states one — FC is fin cut — and the "
            + "bucket's end condition only where it does not."),
          assignIn("megh_sku", "Reassign plan SKU", "vsm_key", "megh_skus"),
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
        section: "sales_summary",
        title: "By OEM",
        note:
          "Customers is a count of distinct parties within the group and is not totalled — "
          + "one customer can appear under two groups when its material group routes a line "
          + "to Boiler.",
        columns: [
          txt("OEM", "OEM"),
          drill(mt("sales_mt", "Sales MT"), "{detail_key}", "{OEM} · sales by customer"),
          nos("sales_nos", "Sales nos"),
          { field: "sales_m", label: "Sales m", kind: "mt", total: true },
          cntNoTotal("customers", "Customers"),
          cnt("transactions", "Transactions"),
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
        section: "trend_buckets",
        title: "Bucket by month",
        note:
          "Months are read from the build, so a new month needs no template change. Tonnage "
          + "reaching no governed bucket is on the strip above and cannot appear here, which "
          + "is why this table's total reads short of the consolidated figure.",
        columns: [
          txt("bucket", "Bucket", true),
          ...monthColumns(ctx.months, ctx.unit, (m) => ({
            key: `TRENDBUCKET|{bucket}|${m}`,
            title: `{bucket} · ${monthLabel(m)} · split by party`,
          })),
          unitTotal(ctx.unit),
          ctx.unit === "mt" ? mt("direct_mt", "Direct MT") : nos("direct_nos", "Direct nos"),
          ctx.unit === "mt" ? mt("megh_mt", "Megh MT") : nos("megh_nos", "Megh nos"),
        ],
      },
      {
        key: "trend_customer_skus",
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
          txt("customer_group", "Customer", true),
          txt("customer", "SAP name", true),
          txt("sku", "SKU", true),
          txt("bucket", "Bucket", true),
          txt("length_type", "Length"),
          { field: "length_m", label: "Length m", kind: "rate" },
          txt("segment", "Segment"),
          txt("material_codes", "Material codes", true),
          ...monthColumns(ctx.months, ctx.unit),
          cntNoTotal("months_active", "Months"),
          ctx.unit === "mt"
            ? { field: "avg_active_month_mt", label: "Avg month MT", kind: "mt" }
            : { field: "avg_active_month_nos", label: "Avg month nos", kind: "nos" },
        ],
        averageOver: {
          monthsField: "months_active",
          avgField: ctx.unit === "mt" ? "avg_active_month_mt" : "avg_active_month_nos",
          totalField: ctx.unit === "mt" ? "total_mt" : "total_nos",
        },
      },
      {
        key: "trend_customer_sku_history",
        section: "trend_customer_sku_history",
        title: "SKU history — average month",
        note:
          "Closes on an average month, not a window total: the tonnage divided by the months "
          + "that actually moved. A SKU selling in three months of eight is a three-month "
          + "average, and the totals row is taken over the months the visible rows sold in.",
        columns: [
          txt("customer", "Customer", true),
          txt("sku", "SKU", true),
          txt("bucket", "Bucket", true),
          txt("length_type", "Length"),
          txt("material_codes", "Material codes", true),
          ...monthColumns(ctx.months, ctx.unit),
          drill(
            unitTotal(ctx.unit),
            "{detail_key}",
            "{customer} · {sku} · sales month by month",
          ),
          cntNoTotal("months_active", "Months"),
          ctx.unit === "mt"
            ? { field: "avg_active_month_mt", label: "Avg active month MT", kind: "mt" }
            : { field: "avg_active_month_nos", label: "Avg active month nos", kind: "nos" },
        ],
        averageOver: {
          monthsField: "months_active",
          avgField: ctx.unit === "mt" ? "avg_active_month_mt" : "avg_active_month_nos",
          totalField: ctx.unit === "mt" ? "total_mt" : "total_nos",
        },
      },
      {
        key: "trend_plants",
        section: "trend_plants",
        title: "Despatch plant summary",
        note:
          "Held at the grain the filters cut on — plant, month, length type, angle cut and "
          + "chamferring — rather than pivoted, so the figures stay addable. Angle cut and "
          + "chamferring are properties of the SKU as scheduled, so a material never "
          + "scheduled this month carries neither rather than a guess.",
        columns: [
          txt("plant", "Plant"),
          txt("month", "Month"),
          txt("length_type", "Length"),
          bool("angle_cut", "Angle cut"),
          bool("chamfer", "Chamfer"),
          ctx.unit === "mt" ? mt("sales_mt", "Sales MT") : nos("sales_nos", "Sales nos"),
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
        section: "sku_pricing",
        title: "Priced SKUs",
        note:
          "Priced off the contract Key — dimension1-dimension2-thickness — with ERW 2 taking "
          + "the -HST variant wherever the size has one. Each quarter shows the price in the "
          + "SKU's own unit; the per-metre figure and the contract's base per tonne are in "
          + "the build-up the price opens, rather than repeated as two more columns.",
        pickFields: { customer: "customer" },
        columns: [
          txt("customer", "Customer", true),
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("bucket", "Bucket", true),
          txt("ctl_bucket", "CTL bucket", true),
          txt("kind", "Kind"),
          txt("contract_type", "Contract type"),
          txt("matched_via", "Matched via"),
          txt("unit", "Unit"),
          { field: "length_mm", label: "Length mm", kind: "rate" },
          { field: "kg_per_m", label: "kg/m", kind: "rate" },
          // Editable: the schedule's flags are right most of the time and wrong some of
          // it, and every SKU where this view disagrees with the customer's own
          // reconciliation is an operation question. Adding one adds its rung to the
          // build-up and moves the price beside it, here and at the next refresh.
          { ...list("operations", "Operations"), edit: { kind: "operations" } },
          mt("schedule_mt", "Schedule MT"),
          nos("schedule_qty", "Schedule qty"),
          // The price build-up is per quarter, so the key is read out of the row's own
          // map of them rather than off a single field: a SKU repriced in Q4 has a
          // different working behind each column. Three columns per quarter: what the
          // contract prices it at, what the customer's PO says, and the gap.
          ...ctx.quarters.flatMap((q): Column[] => [
            {
              ...drill(
                rate(q, `${q} price`),
                `{detail_keys.${q}}`,
                `{bucket} · ${q} · price build-up`,
              ),
              priceQuarter: q,
            },
            {
              ...rate(`${q} customer price`, `${q} PO price`),
              edit: { kind: "po_price", quarter: q },
            },
            rate(`${q} diff`, `${q} diff`),
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
        section: "sku_pricing_unpriced",
        title: "What cannot be priced",
        note:
          "Two reasons, both reported rather than dropped: the line reaches no governed "
          + "bucket at all, or the bucket is governed and the contract has no row for it.",
        pickFields: { customer: "customer" },
        columns: [
          txt("customer", "Customer", true),
          txt("bucket", "Bucket", true),
          txt("reason", "Reason", true),
          mt("schedule_mt", "Schedule MT"),
          cnt("lines", "Lines"),
        ],
      },
      {
        key: "code_repository",
        section: "code_repository",
        title: "Code repository",
        note:
          "Built at bill-to x ship-to x plant x material code, because a price change raised "
          + "on the sold-to party alone misses the delivery address it is invoiced against, "
          + "and one customer buys the same SKU under several codes.",
        columns: [
          txt("bill_to_code", "Bill-to code"),
          txt("bill_to_name", "Bill-to", true),
          txt("ship_to_code", "Ship-to code"),
          txt("ship_to_name", "Ship-to", true),
          txt("plant", "Plant"),
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("bucket", "Bucket", true),
          txt("ctl_bucket", "CTL bucket", true),
          { field: "length_mm", label: "Length mm", kind: "rate" },
          txt("oem", "OEM"),
          cnt("invoices", "Invoices"),
          nos("qty_nos", "Qty nos"),
          mt("qty_mt", "Qty MT"),
          txt("first_billed", "First billed"),
          txt("last_billed", "Last billed"),
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
        section: "stock_analysis_ctl",
        title: "Cut length",
        note:
          "Plant 4731 rows carry the RFD reconciliation: what the RFD extract accounts for "
          + "and what it does not, with the verdict behind it.",
        columns: [
          txt("plant", "Plant"),
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("holder", "Held for", true),
          sev(days("oldest_age_days", "Oldest days"), AGEING),
          drill(
            mt("stock_mt", "Stock MT"),
            "{detail_key}",
            "Cut length · {material_code} · plant {plant}",
          ),
          // A lot with nothing aged has the key but no aged lines behind it, so the
          // guard is on the tonnage rather than on the key.
          drill(
            sev(mt("high_age_mt", "High age MT"), AGED_TONNAGE),
            "{high_age_detail_key}",
            "High age · {material_code} · plant {plant}",
            "high_age_mt",
          ),
          nos("stock_nos", "Stock nos"),
          cnt("batches", "Batches"),
          txt("rfd_status", "RFD status"),
          txt("rfd_verdict", "RFD verdict", true),
          mt("rfd_matched_mt", "RFD matched MT"),
          mt("rfd_unmatched_mt", "RFD unmatched MT"),
          txt("rfd_explanation", "RFD explanation", true),
        ],
      },
      {
        key: "stock_analysis_ll",
        section: "stock_analysis_ll",
        title: "Long length",
        columns: [
          txt("plant", "Plant"),
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("holder", "Held for", true),
          sev(days("oldest_age_days", "Oldest days"), AGEING),
          drill(
            mt("stock_mt", "Stock MT"),
            "{detail_key}",
            "Long length · {material_code} · plant {plant}",
          ),
          drill(
            sev(mt("high_age_mt", "High age MT"), AGED_TONNAGE),
            "{high_age_detail_key}",
            "High age · {material_code} · plant {plant}",
            "high_age_mt",
          ),
          nos("stock_nos", "Stock nos"),
          cnt("batches", "Batches"),
        ],
      },
      {
        key: "stock_source_coverage",
        section: "stock_source_coverage",
        title: "Bucket mapping coverage by source",
        note:
          "How much of each inventory source reaches a governed bucket. The unmapped "
          + "percentage is a rate per source and carries no total.",
        columns: [
          txt("source", "Source"),
          txt("file", "File"),
          cnt("rows", "Rows"),
          cnt("unmapped_rows", "Unmapped rows"),
          mt("total_mt", "Total MT"),
          mt("mapped_mt", "Mapped MT"),
          drill(
            mt("unmapped_mt", "Unmapped MT"),
            "{detail_key}",
            "{source} · stock that reaches no governed bucket",
          ),
          pct("unmapped_pct", "Unmapped %"),
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
          list("customers", "Customers"),
          list("cut_lengths", "Cut lengths mm"),
          ex(mt("schedule_mt", "Schedule MT"),
            "The plan customers' schedule on this bucket this month."),
          ex(mt("sales_mt", "Sales MT"), "Dispatched against it so far this month."),
          ex(mt("balance_mt", "Balance MT"), "Schedule less sales, floored at zero."),
          ex({ field: "daily_mt", label: "Daily MT", kind: "mt", total: true },
            "The run rate: schedule ÷ days in the month. The requirement is built from "
            + "this."),
          ex(mt("requirement_mt", "Requirement MT"),
            "Daily MT × the target cover in days — what 8406 should be holding."),
          ex(mt("owned_8406_mt", "Owned at 8406 MT"), "Stock standing at 8406, on the ground."),
          ex(mt("in_transit_mt", "In transit MT"),
            "Transfer lines despatched to 8406 with no goods receipt yet, from "
            + "transfer.xlsx — an empty GR DATE is the in-transit flag."),
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
              "Long-length stock of this bucket standing at the source plants, before "
              + "allocation. The breakup lists it plant by plant."),
            "{source_detail_key}",
            "{bucket} · stock at the source plants",
          ),
          list("source_plants", "Source plants"),
        ],
        copies: [{ kind: "str" }],
      },
      {
        key: "str_lines",
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
          txt("bucket", "Bucket", true),
          txt("plant", "Plant"),
          txt("plant_label", "Source plant", true),
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("source", "Source"),
          bool("from_wip", "From WIP"),
          txt("remark", "Remark", true),
          mt("available_mt", "Available MT"),
          mt("qty_mt", "STR MT"),
        ],
      },
      {
        key: "unmapped_destination_stock",
        scalar: ["str_plan", "unmapped_destination_stock"],
        title: "Stock at 8406 reaching no plan bucket",
        columns: [
          txt("customer_name", "Held for", true),
          txt("customer_code", "Customer code"),
          mt("stock_mt", "Stock MT"),
        ],
      },
      {
        key: "wip_without_fg_code",
        scalar: ["str_plan", "wip_without_fg_code"],
        title: "Mother tube with no finished-goods code",
        note:
          "No TUB- equivalent exists in zmat for these descriptions, so no STR can be raised "
          + "on them however much WIP is standing.",
        columns: [
          txt("plant", "Plant"),
          txt("bucket", "Bucket", true),
          txt("description", "Description", true),
          mt("wip_mt", "WIP MT"),
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
        section: "transfers",
        title: "Despatched transfer lines",
        note:
          "Only rows whose invoice type is a transfer. An empty result after that filter "
          + "means the file is not a transfer extract — the daily mail has more than once "
          + "carried the sales dump under the transfer filename.",
        columns: [
          txt("source_plant_label", "From", true),
          txt("dest_plant_label", "To", true),
          txt("document", "Billing doc"),
          txt("sto_no", "STO no"),
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("bucket", "Bucket", true),
          txt("ctl_bucket", "CTL bucket", true),
          txt("length_type", "Length"),
          txt("billing_date", "Billed"),
          txt("grn_date", "GRN"),
          txt("status", "Status"),
          days("transit_days", "Transit days"),
          txt("mark_customer", "Marked for", true),
          drill(
            mt("qty_mt", "Qty MT"),
            "{detail_key}",
            "{source_plant_label} → {dest_plant_label} · {material_code}",
          ),
          nos("qty_nos", "Qty nos"),
          cnt("batches", "Batches"),
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
        section: "overdue_analysis",
        title: "By ancillary",
        note:
          "Amounts in INR. Oldest days is a per-row age and carries no total. The gross "
          + "debit and credit components of the net are recorded in the run's QC summary "
          + "rather than shown here, where they sat between the figure and its ageing.",
        columns: [
          txt("ancillary", "Ancillary", true),
          txt("customer_code", "Customer code"),
          // Banded by how old the money is, not by how much it is: a large receivable a
          // week past due is a call, and a small one two years past due is a write-off.
          drill(
            sev(inr("overdue_amount", "Overdue INR"), {
              from: "oldest_days",
              direction: "high",
              alert: OVERDUE_ALERT_DAYS,
              attention: 1,
            }),
            "{detail_key}",
            "Overdue · {ancillary}",
          ),
          cnt("documents", "Documents"),
          sev(days("oldest_days", "Oldest days"), {
            direction: "high",
            alert: OVERDUE_ALERT_DAYS,
            attention: 1,
          }),
          // Every rupee in this column is past 90 days by construction, so any non-zero
          // figure is the alert and the band needs no second boundary.
          sev(inr("over_90_days_amount", "Over 90 days INR"), {
            when: "over_90_days_amount",
            direction: "high",
            alert: 1,
          }),
          // An ancillary with no open credit note has the key and nothing behind it.
          drill(
            inr("offsets_amount", "Offsets INR"),
            "{offsets_detail_key}",
            "Open payments and credit notes · {ancillary}",
            "offsets_documents",
          ),
          cnt("offsets_documents", "Offset documents"),
        ],
      },
    ],
  },
};
