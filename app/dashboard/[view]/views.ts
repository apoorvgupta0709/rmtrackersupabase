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

export type Unit = "mt" | "nos";

export type TableSpec = {
  key: string;
  title: string;
  note?: string;
  /** Rows from `build_sections`. */
  section?: string;
  /** Rows that travel in a scalar beside the section rows: `[scalar key, field]`. */
  scalar?: [string, string];
  /** Derive rows from the fetched ones — used where one section carries a nested list. */
  flatten?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
  columns: Column[];
  averageOver?: AverageOver;
};

export type Fact = { label: string; value: string };

export type Ctx = {
  months: string[];
  quarters: string[];
  unit: Unit;
  scalars: Record<string, any>;
};

export type ViewSpec = {
  label: string;
  note: string;
  /** Scalars this view needs, so the page fetches exactly those. */
  scalars: string[];
  /** Offer the tonnes/pieces switch. One control drives every table on the tab. */
  unitToggle?: boolean;
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
const money = (field: string, label: string): Column => ({ field, label, kind: "money" });
const bool = (field: string, label: string): Column => ({ field, label, kind: "bool" });
const list = (field: string, label: string): Column => ({ field, label, kind: "list", wide: true });

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-01` -> `Jan 26`. */
export function monthLabel(month: string): string {
  const [year, mm] = month.split("-");
  const name = MONTH_NAMES[Number(mm) - 1];
  return name ? `${name} ${year.slice(2)}` : month;
}

/** Months across the columns, read from the build so a new month needs no template change. */
function monthColumns(months: string[], unit: Unit): Column[] {
  const holder = unit === "mt" ? "months" : "months_nos";
  return months.map((m) => ({
    field: `${holder}.${m}`,
    label: monthLabel(m),
    kind: unit === "mt" ? "mt" : "nos",
    total: true,
    month: true,
  }));
}

const unitTotal = (unit: Unit): Column =>
  unit === "mt" ? mt("total_mt", "Total MT") : nos("total_nos", "Total nos");

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
      "One row per scheduled size per customer, over a customer-level summary. The stock "
      + "pools are shared between the customers drawing on them, so they carry no total: "
      + "adding them down the column would count the same tube several times.",
    scalars: [],
    tables: () => [
      {
        key: "customer_summary",
        section: "customer_summary",
        title: "By customer",
        note:
          "Schedule, dispatch and balance per customer. The pool columns are the stock a "
          + "customer's sizes can draw on, not stock allocated to it.",
        columns: [
          txt("customer_display", "Customer", true),
          txt("OEM", "OEM"),
          cnt("schedule_lines", "Lines"),
          mt("schedule_mt", "Schedule MT"),
          mt("sales_mt", "Sales MT"),
          mt("balance_mt", "Balance MT"),
          mt("open_balance_mt", "Open bal MT"),
          mt("over_dispatch_mt", "Over disp MT"),
          pool("ctl_stock_pool_mt_do_not_sum", "CTL pool MT"),
          { field: "ctl_stock_pool_nos_do_not_sum", label: "CTL pool nos", kind: "nos" },
          pool("ll_stock_pool_mt_do_not_sum", "LL pool MT"),
          pool("shared_wip_mt_do_not_sum", "WIP pool MT"),
          pool("shared_transit_mt_do_not_sum", "Transit pool MT"),
          cnt("unresolved_sales_lines", "Unresolved sales lines"),
        ],
      },
      {
        key: "customer_lines",
        section: "customer_lines",
        title: "Schedule lines",
        note:
          "One row per scheduled size per customer. Pool columns must not be summed across "
          + "customers — stock is shared, so a total would count it more than once. The "
          + "history cell is an average month, not a window total.",
        columns: [
          txt("customer_display", "Customer", true),
          txt("OEM", "OEM"),
          txt("bucket", "Bucket", true),
          txt("ctl_bucket", "CTL bucket", true),
          txt("Plant", "Plant"),
          mt("schedule_mt", "Schedule MT"),
          mt("sales_mt", "Sales MT"),
          mt("balance_mt", "Balance MT"),
          mt("open_balance_mt", "Open bal MT"),
          mt("over_dispatch_mt", "Over disp MT"),
          pool("ctl_stock_pool_mt", "CTL stock MT"),
          pool("ll_stock_pool_mt", "LL stock MT"),
          pool("shared_wip_mt", "WIP MT"),
          { field: "history_avg_month_mt", label: "Avg month MT", kind: "mt" },
        ],
      },
    ],
  },

  meghView: {
    label: "Megh Steel sales",
    note:
      "The vendor service model: Tata Steel supplies Megh Steel, which supplies TVSM, "
      + "Royal Enfield and HMSIL. A key carrying the Megh- prefix is an RE or HMSIL size "
      + "and has no TVS bucket by design — it is not a mapping gap.",
    scalars: ["signoff", "orders"],
    facts: (s) => [
      { label: "Signed off", value: `${f3(s.signoff?.signed_mt)} MT` },
      { label: "Not signed off", value: `${f3(s.signoff?.non_signed_mt)} MT` },
      { label: "Sign-off reaching no bucket", value: `${f3(s.signoff?.unmapped_mt)} MT` },
      { label: "Sign-off sheets", value: join(s.signoff?.sheets) },
    ],
    tables: () => [
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
          mt("schedule_mt", "Schedule MT"),
          mt("sales_mt", "Sales MT"),
          mt("ground_stock_mt", "Ground stock MT"),
          mt("transit_stock_mt", "Transit MT"),
          mt("total_stock_mt", "Total stock MT"),
          mt("stock_at_length_mt", "At length MT"),
          mt("other_length_stock_mt", "Other length MT"),
          mt("orders_logged_mt", "Ordered MT"),
          mt("orders_planning_mt", "Sales-planning orders MT"),
          mt("signoff_mt", "Signed MT"),
          mt("non_signoff_mt", "Not signed MT"),
          days("coverage_days", "Cover days"),
          days("coverage_days_post_order", "Cover days post order"),
          cntNoTotal("bop_nos", "BOP nos"),
          txt("bop_stated_size", "BOP stated size"),
          txt("plan_note", "Plan note", true),
        ],
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
          mt("total_schedule_mt", "Schedule MT"),
          mt("total_sales_mt", "Sales MT"),
          mt("remaining_schedule_mt", "Remaining MT"),
          mt("available_ll_stock_mt", "LL stock MT"),
          mt("shared_wip_mt", "WIP MT"),
          mt("transit_mt", "Transit MT"),
          days("coverage_days", "Cover days"),
          mt("gap_to_30_days_mt", "Gap 30d MT"),
          mt("gap_to_45_days_mt", "Gap 45d MT"),
          mt("order_logged_mt", "Ordered MT"),
          mt("signoff_mt", "Signed MT"),
          mt("last_month_sales_mt", "Last month MT"),
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
      "The queue. Every row here is tonnage the pipeline could not govern, so it is "
      + "tonnage missing from a tracker somewhere. The empty cells are the work, and a "
      + "queue nobody can find is not a queue — each source gets its own table.",
    scalars: [],
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
          mt("sales_mt", "Sales MT"),
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
          ...monthColumns(ctx.months, ctx.unit),
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
          + "is planned in pieces, so switch the unit above to read it the way it is ordered.",
        columns: [
          txt("customer", "Customer", true),
          txt("sku", "SKU", true),
          txt("bucket", "Bucket", true),
          txt("length_type", "Length"),
          { field: "length_m", label: "Length m", kind: "rate" },
          txt("segment", "Segment"),
          txt("material_codes", "Material codes", true),
          ...monthColumns(ctx.months, ctx.unit),
          unitTotal(ctx.unit),
        ],
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
          unitTotal(ctx.unit),
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
          + "the -HST variant wherever the size has one. Per-m and base-per-ton are the audit "
          + "trail behind the unit price beside them.",
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
          list("operations", "Operations"),
          mt("schedule_mt", "Schedule MT"),
          nos("schedule_qty", "Schedule qty"),
          ...ctx.quarters.flatMap((q): Column[] => [
            rate(q, `${q} price`),
            rate(`${q} per m`, `${q} per m`),
            money(`${q} base per ton`, `${q} base/t`),
          ]),
        ],
      },
      {
        key: "sku_pricing_unpriced",
        section: "sku_pricing_unpriced",
        title: "What cannot be priced",
        note:
          "Two reasons, both reported rather than dropped: the line reaches no governed "
          + "bucket at all, or the bucket is governed and the contract has no row for it.",
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
          mt("stock_mt", "Stock MT"),
          mt("high_age_mt", "High age MT"),
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
          mt("stock_mt", "Stock MT"),
          mt("high_age_mt", "High age MT"),
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
          mt("unmapped_mt", "Unmapped MT"),
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
          mt("stock_8406_mt", "Stock at 8406 MT"),
          days("coverage_days", "Cover days"),
          mt("str_required_mt", "STR required MT"),
          mt("str_allocated_mt", "STR allocated MT"),
          mt("str_shortfall_mt", "Shortfall MT"),
          mt("source_stock_mt", "Source stock MT"),
          list("source_plants", "Source plants"),
        ],
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
          mt("qty_mt", "Qty MT"),
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
          "Amounts in INR. Oldest days is a per-row age and carries no total. Gross debits "
          + "and credits are kept beside the net so the netting stays auditable.",
        columns: [
          txt("ancillary", "Ancillary", true),
          txt("customer_code", "Customer code"),
          inr("overdue_amount", "Overdue INR"),
          cnt("documents", "Documents"),
          days("oldest_days", "Oldest days"),
          inr("over_90_days_amount", "Over 90 days INR"),
          inr("overdue_debits", "Debits INR"),
          inr("overdue_credits", "Credits INR"),
          inr("offsets_amount", "Offsets INR"),
          cnt("offsets_documents", "Offset documents"),
        ],
      },
    ],
  },
};
