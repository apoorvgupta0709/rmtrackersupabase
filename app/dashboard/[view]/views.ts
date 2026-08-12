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

import type { AverageOver, Column } from "./table";
import type { CopySpec } from "./copies";

export type Unit = "mt" | "nos";

export type TableSpec = {
  key: string;
  title: string;
  note?: string;
  /** Rows from `build_sections`. */
  section?: string;
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
 */
const assignTo = (scope: "bucket" | "megh_sku", label: string): Column => ({
  // No field on the row holds this; the decision is looked up by material code. The name
  // still has to be unique among the columns, because it keys the header's filter.
  field: `__assign_${scope}`,
  label,
  wide: true,
  assign: {
    scope,
    codeField: "material_code",
    options: scope === "bucket" ? "buckets" : "megh_skus",
  },
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
    label: "Customer tracker",
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
    label: "Megh Steel sales",
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
          "Stock, schedule and cover per SKU on the vsm stock plan. Coverage days is a "
          + "rate per row and carries no total. A row badged off plan is a bought-out "
          + "size the plan has no line for — the plan is what is short, not the match.",
        columns: [
          txt("sku", "SKU", true),
          txt("family", "Family", true),
          txt("end_oem", "End OEM"),
          bool("in_plan", "On plan"),
          bool("bop", "BOP"),
          { field: "length_m", label: "Length m", kind: "rate" },
          txt("grade", "Grade"),
          txt("cut_type", "Cut type"),
          list("materials", "Material codes"),
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
          drill(
            mt("sales_mt", "Sales MT"),
            "{sales_detail_key}",
            "{sku} · sales to Megh",
            "sales_mt",
          ),
          // Ground and in transit are the two halves of one pool. They were their own
          // columns and are now the breakup behind it: what is asked of this figure is
          // "how much is there", and the split is the follow-up question.
          drill(
            mt("total_stock_mt", "Stock at VSM MT"),
            "{stock_detail_key}",
            "{sku} · ground plus in transit",
            "total_stock_mt",
          ),
          drill(
            mt("stock_at_length_mt", "At length MT"),
            "{at_length_detail_key}",
            "{sku} · long length at required size",
            "stock_at_length_mt",
          ),
          drill(
            mt("other_length_stock_mt", "Other length MT"),
            "{other_length_detail_key}",
            "{sku} · long length, other sizes",
            "other_length_stock_mt",
          ),
          drill(
            mt("orders_logged_mt", "Ordered MT"),
            "{orders_detail_key}",
            "{sku} · orders logged as per OMS",
            "orders_logged_mt",
          ),
          drill(
            mt("orders_planning_mt", "Sales-planning orders MT"),
            "{orders_plan_detail_key}",
            "{sku} · orders logged as per sales planning, plant by plant",
          ),
          // Both halves of the split open the same breakup, which carries the three
          // quantity columns side by side; only the heading says which half was clicked.
          drill(
            mt("signoff_mt", "Signed MT"),
            "{signoff_detail_key}",
            "{sku} · signed off",
            "signoff_mt",
          ),
          drill(
            mt("non_signoff_mt", "Not signed MT"),
            "{signoff_detail_key}",
            "{sku} · not signed off",
            "non_signoff_mt",
          ),
          days("coverage_days", "Cover days"),
          days("coverage_days_post_order", "Cover days post order"),
          cntNoTotal("bop_nos", "BOP nos"),
          txt("bop_stated_size", "BOP stated size"),
          txt("plan_note", "Plan note", true),
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
    label: "Long-length tracker",
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
          txt("bucket", "Bucket", true),
          txt("risk", "Risk"),
          drill(
            mt("total_schedule_mt", "Schedule MT"),
            "LLSCHEDULE|{bucket}",
            "{bucket} · total schedule breakup",
          ),
          drill(
            mt("total_sales_mt", "Sales MT"),
            "LLSALES|{bucket}",
            "{bucket} · total sales breakup",
          ),
          // Remaining is the balance the LLGAP breakup shows its working for — schedule
          // less sales, per party. The two gap-to-cover columns beside it are a different
          // calculation and only the 45-day one has a breakup of its own.
          drill(
            mt("remaining_schedule_mt", "Remaining MT"),
            "LLGAP|{bucket}",
            "{bucket} · balance (schedule less sales)",
          ),
          // One pool, not three columns. WIP and in transit were shown beside it, but
          // they are already inside it — plant stock, WIP, transit and the TVSM tracker
          // add up to exactly this figure — so they were the same tonnage counted twice
          // on screen. The breakup names all four sources.
          drill(
            mt("available_ll_stock_mt", "LL stock MT"),
            "{stock_detail_key}",
            "{bucket} · consolidated LL stock",
          ),
          drill(
            days("coverage_days", "Cover days"),
            "LLCOVERAGE|{bucket}",
            "{bucket} · coverage calculation",
          ),
          mt("gap_to_30_days_mt", "Gap 30d MT"),
          drill(mt("gap_to_45_days_mt", "Gap 45d MT"), "LLGAP45|{bucket}", "{bucket} · gap to 45 days"),
          drill(
            mt("order_logged_mt", "Ordered MT"),
            "{order_detail_key}",
            "{bucket} · orders logged, plant by plant",
          ),
          drill(
            mt("signoff_mt", "Signed MT"),
            "{signoff_detail_key}",
            "{bucket} · signed off",
            "signoff_mt",
          ),
          drill(
            mt("last_month_sales_mt", "Last month MT"),
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
      "The queue, and the one tab you write to. Every row here is tonnage the pipeline "
      + "could not govern, so it is tonnage missing from a tracker somewhere. Assign the "
      + "bucket a material code belongs to and the decision is kept against the code, not "
      + "against this build — the next refresh reads it and the tonnage lands where it "
      + "should. Until that refresh runs the figures on the other tabs are unchanged, and "
      + "the cell says so rather than implying otherwise.",
    scalars: ["governed_buckets"],
    tables: () => [
      {
        key: "missing_mappings",
        section: "missing_mappings",
        title: "Materials, customers and scheduled sizes",
        note:
          "Sizes a customer schedules that no bucket governs appear here in the form the "
          + "customer sent them. A row reading lookup error is a bug, not a gap.",
        columns: [
          txt("mapping_type", "Type"),
          txt("source", "Source", true),
          txt("customer_code", "Customer code"),
          txt("customer", "Customer", true),
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("reason", "Reason", true),
          mt("affected_mt", "Affected MT"),
          assignTo("bucket", "Assign bucket"),
        ],
      },
      {
        key: "megh_unmapped",
        section: "megh_unmapped",
        title: "Megh purchases reaching no plan SKU",
        columns: [
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("customer", "Customer", true),
          txt("derived_key", "Derived key", true),
          mt("sales_mt", "Sales MT"),
          // These are keyed on the plan's own SKU, not on a governed bucket: a Megh- size
          // has no TVS bucket by design.
          assignTo("megh_sku", "Assign plan SKU"),
        ],
      },
      {
        key: "stock_unmapped",
        section: "stock_unmapped",
        title: "Stock reaching no governed bucket",
        columns: [
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("plant", "Plant"),
          txt("holder", "Held for", true),
          txt("length_type", "Length"),
          mt("stock_mt", "Stock MT"),
          cnt("batches", "Batches"),
          assignTo("bucket", "Assign bucket"),
        ],
      },
      {
        key: "wip_unmapped",
        section: "wip_unmapped",
        title: "WIP reaching no governed bucket",
        note: "Unresolved WIP is excluded from long-length stock, so this is cover the tracker cannot see.",
        columns: [
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("plant", "Plant"),
          txt("code_bucket", "Code bucket", true),
          txt("reason", "Reason", true),
          mt("wip_mt", "WIP MT"),
          cnt("batches", "Batches"),
          assignTo("bucket", "Assign bucket"),
        ],
      },
      {
        key: "rfd_unmapped",
        section: "rfd_unmapped",
        title: "RFD 4731 lines reaching no CTL mapping",
        columns: [
          txt("size", "Size"),
          txt("listed_code", "Listed code"),
          txt("matched_materials", "Matched materials", true),
          { field: "length_m", label: "Length m", kind: "rate" },
          nos("stock_nos", "Stock nos"),
          mt("stock_mt", "Stock MT"),
          txt("reason", "Reason", true),
        ],
      },
      {
        key: "orders_unmapped",
        section: "orders_unmapped",
        title: "Order lines missing from a view",
        note:
          "Each line names which view it is missing from and which still shows it. Lines "
          + "excluded on purpose are listed too, so the ones showing nowhere are the "
          + "number worth chasing.",
        columns: [
          txt("missing_from", "Missing from"),
          txt("shown_on", "Still shown on"),
          txt("cause", "Cause", true),
          txt("origin", "Origin"),
          txt("plant", "Plant"),
          txt("kind", "Kind"),
          txt("order_no", "Order no"),
          txt("customer", "Customer", true),
          txt("material_code", "Material code"),
          txt("description", "Description", true),
          txt("bucket", "Bucket", true),
          txt("sku", "SKU", true),
          days("age_days", "Age days"),
          mt("order_mt", "Order MT"),
        ],
      },
      {
        key: "signoff_unmapped",
        section: "signoff_unmapped",
        title: "Order sign-off reaching no bucket or SKU",
        columns: [
          txt("plant", "Sheet"),
          txt("material_code", "Material code"),
          txt("bucket", "Bucket", true),
          txt("sku", "SKU", true),
          mt("signed_mt", "Signed MT"),
          mt("unsigned_mt", "Not signed MT"),
          mt("qty_mt", "Qty MT"),
        ],
      },
    ],
  },

  salesView: {
    label: "Sales summary",
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
    label: "Stock analysis",
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
          days("oldest_age_days", "Oldest days"),
          drill(
            mt("stock_mt", "Stock MT"),
            "{detail_key}",
            "Cut length · {material_code} · plant {plant}",
          ),
          // A lot with nothing aged has the key but no aged lines behind it, so the
          // guard is on the tonnage rather than on the key.
          drill(
            mt("high_age_mt", "High age MT"),
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
          days("oldest_age_days", "Oldest days"),
          drill(
            mt("stock_mt", "Stock MT"),
            "{detail_key}",
            "Long length · {material_code} · plant {plant}",
          ),
          drill(
            mt("high_age_mt", "High age MT"),
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
    label: "STR to 8406",
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
          txt("bucket", "Bucket", true),
          txt("risk", "Risk"),
          list("customers", "Customers"),
          list("cut_lengths", "Cut lengths mm"),
          mt("schedule_mt", "Schedule MT"),
          mt("sales_mt", "Sales MT"),
          mt("balance_mt", "Balance MT"),
          { field: "daily_mt", label: "Daily MT", kind: "mt", total: true },
          mt("requirement_mt", "Requirement MT"),
          mt("owned_8406_mt", "Owned at 8406 MT"),
          mt("in_transit_mt", "In transit MT"),
          drill(
            mt("stock_8406_mt", "Stock at 8406 MT"),
            "{stock_detail_key}",
            "{bucket} · stock at 8406 including in transit",
          ),
          days("coverage_days", "Cover days"),
          mt("str_required_mt", "STR required MT"),
          mt("str_allocated_mt", "STR allocated MT"),
          mt("str_shortfall_mt", "Shortfall MT"),
          drill(
            mt("source_stock_mt", "Source stock MT"),
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
          drill(inr("overdue_amount", "Overdue INR"), "{detail_key}", "Overdue · {ancillary}"),
          cnt("documents", "Documents"),
          days("oldest_days", "Oldest days"),
          inr("over_90_days_amount", "Over 90 days INR"),
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
