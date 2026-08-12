"use client";

/**
 * The copy formats that are not "the table as a grid".
 *
 * Each of these is written to be pasted somewhere specific by someone who is not looking
 * at this dashboard — a dispatch team's sheet, a customer's WhatsApp thread, an STR
 * raiser, a price-change request. The format is the deliverable, so each one is
 * specified in `SKILL.md` and reproduced here rather than invented: changing one changes
 * what lands in someone else's inbox.
 *
 * They all read the **visible** rows of the table they sit under, so the reader's own
 * column filters narrow what is copied. Each format then applies its own rule on top —
 * an open balance, a pool over 500 nos — because those rules are what make it that
 * document rather than a dump of the tab.
 */

export type CopyKind =
  | "clearance" | "dispatch" | "str" | "pcr" | "calculation" | "megh_calculation";

/** A copy button, as a view declares it. Serializable: it crosses the server boundary. */
export type CopySpec = { kind: CopyKind; arg?: string };

export type CopyContext = {
  asOf: string;
  scalars: Record<string, any>;
  /** Sections already fetched for this tab, for a format that spans two of them. */
  sections: Record<string, Record<string, unknown>[]>;
};

import { rateInSalesUnit } from "./pricing.ts";

type Row = Record<string, unknown>;
export type CopyResult = { text: string } | { error: string };

/* ---- Shared helpers ------------------------------------------------------- */

const n = (value: unknown): number => {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Grouped, like the page. Quantities keep their separators.
 *
 * `maximumFractionDigits` only, with no minimum — the same rounding the static page used,
 * so a 5.1 MT shortfall reads `5.1` and not `5.100`. These strings land in someone else's
 * document; they are not free to drift.
 */
const grouped = (value: number, dp: number) =>
  value.toLocaleString("en-IN", { maximumFractionDigits: dp });

/** Fixed decimals, no grouping — a cell that has to arrive as a number. */
const plain = (value: unknown, dp: number) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? ""
    : Number(value).toFixed(dp);

/**
 * A dimension, with no thousand separator and no trailing zeros: "1130 mm" is a length,
 * where "1,130 mm" reads as a quantity and invites a misread on a phone screen.
 */
const dimension = (value: unknown) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? ""
    : String(Number(Number(value).toFixed(2)));

/** The plant codes that are written with their leading zero. */
const displayPlant = (plant: unknown) => {
  const value = String(plant ?? "");
  return ["789", "788", "56"].includes(value) ? value.padStart(4, "0") : value;
};

/** `2026-08-07` -> `07.08.2026`, the form these documents are dated in. */
const asOfDots = (asOf: string) => {
  const [year, month, day] = String(asOf).split("-");
  return `${day}.${month}.${year}`;
};

const tsv = (lines: (string | number)[][]) =>
  lines.map((cells) => cells.join("\t")).join("\n");

/**
 * The one customer the visible rows are about.
 *
 * The dispatch plan and the clearance list are addressed to a customer, so they need one
 * chosen. Rather than a selector of their own that could disagree with the tab's, the
 * choice is the tab's: the rows they are handed have already been narrowed to it.
 * Anything else is refused rather than guessed — a clearance request sent to the wrong
 * customer quotes them someone else's stock.
 */
function soleCustomer(rows: Row[]): string | null {
  const names = new Set(rows.map((r) => String(r.customer_display ?? "")).filter(Boolean));
  return names.size === 1 ? [...names][0] : null;
}

const PICK_ONE =
  "Select a customer at the top of the tab first — this list is addressed to one.";

/**
 * Every line the customer has, not the lines left on screen.
 *
 * These two documents are the exception to "what is copied is what is left". They are
 * sent to someone: a dispatch plan that quietly omits a SKU because a search box was
 * still filled in, or because the customer's CRFH book is shown as its own table, is a
 * wrong document in the dispatch team's hands and nothing about it looks wrong. So the
 * customer is read off the rows and the lines are read off the section — which is what
 * the static page does, and keeps the two byte-identical.
 */
function everyLineFor(rows: Row[], ctx: CopyContext): { customer: string; lines: Row[] } | null {
  const customer = soleCustomer(rows);
  if (!customer) return null;
  const held = ctx.sections.customer_lines ?? [];
  const lines = held.filter((row) => String(row.customer_display ?? "") === customer);
  return { customer, lines: lines.length ? lines : rows };
}

/* ---- Clearance list ------------------------------------------------------- */

/** Below this there is nothing worth asking a customer to clear. */
const CLEARANCE_MIN_NOS = 500;

/** `19.05 x 12.5 x 3.25 x 1130 mm`, inner diameter only where the SKU has one. */
function skuLabel(row: Row): string {
  const parts = [dimension(row.od)];
  if (n(row.inner_d) > 0) parts.push(dimension(row.inner_d));
  parts.push(dimension(row.thickness));
  parts.push(dimension(row.ctl_length));
  return `${parts.filter(Boolean).join(" x ")} mm`;
}

/**
 * Written to be pasted straight into WhatsApp: no tabs, because a tab-separated grid
 * collapses into an unreadable run of text there, and short lines so nothing wraps on a
 * phone. WhatsApp renders `*bold*` and `_italic_`.
 */
function clearance(rows: Row[], ctx: CopyContext): CopyResult {
  const held = everyLineFor(rows, ctx);
  if (!held) return { error: PICK_ONE };
  const { customer } = held;

  // CTL stock is a shared pool keyed by CTL bucket, and one customer can carry the same
  // bucket on more than one row, so deduplicate before listing — otherwise the same
  // pieces are offered twice and the total double counts them.
  const seen = new Set<string>();
  const listed = held.lines
    .filter((r) => n(r.ctl_stock_pool_nos) > CLEARANCE_MIN_NOS)
    .filter((r) => {
      const key = String(r.ctl_bucket ?? "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => n(b.ctl_stock_pool_nos) - n(a.ctl_stock_pool_nos));

  const lines = [
    `*CLEARANCE REQUEST - ${customer.toUpperCase()}*`,
    `_Cut length stock as on ${asOfDots(ctx.asOf)}_`,
    "",
  ];

  if (listed.length === 0) {
    lines.push(
      `No cut-length SKU has more than ${grouped(CLEARANCE_MIN_NOS, 0)} nos in stock.`,
    );
    return { text: lines.join("\n") };
  }

  listed.forEach((r, i) => {
    // The schedule sheet writes a placeholder such as "NO MATERIAL CODE" where a code is
    // missing; quoting that back to the customer would be worse than silence.
    const key = String(r.material_key ?? "");
    const code = /^\d+$/.test(key) ? ` (${key})` : "";
    lines.push(
      `${i + 1}. ${skuLabel(r)}${code} - ${grouped(Math.round(n(r.ctl_stock_pool_nos)), 0)} nos`,
    );
  });

  const total = listed.reduce((sum, r) => sum + Math.round(n(r.ctl_stock_pool_nos)), 0);
  lines.push("");
  lines.push(`*${listed.length} SKU${listed.length === 1 ? "" : "s"}, ${grouped(total, 0)} nos*`);
  lines.push("Please confirm clearance for despatch.");
  return { text: lines.join("\n") };
}

/* ---- Dispatch plan -------------------------------------------------------- */

const DISPATCH_COLUMNS =
  ["PLANT", "ACTUAL OD", "OD", "ID", "THICKNESS", "CTL", "NOS", "MT", "SO"];

/**
 * One line per open SKU, in the shape the dispatch team receives it.
 *
 * The sales order rides on the row: the pipeline resolves it from the most recent earlier
 * invoice, most specific match first, and leaves it blank where the customer has never
 * bought the SKU. A blank SO is correct — a sales order is customer-specific, so quoting
 * another customer's order would be worse than quoting none.
 */
function dispatch(rows: Row[], ctx: CopyContext): CopyResult {
  const held = everyLineFor(rows, ctx);
  if (!held) return { error: PICK_ONE };
  const { customer } = held;

  const open = held.lines
    .filter((r) => n(r.balance_qty) > 0)
    .sort(
      (a, b) =>
        n(a.od) - n(b.od) || n(a.thickness) - n(b.thickness) || n(a.ctl_length) - n(b.ctl_length),
    );

  const lines: (string | number)[][] = [
    [`DATE : ${asOfDots(ctx.asOf)}`, customer.toUpperCase()],
    DISPATCH_COLUMNS,
  ];

  let total = 0;
  for (const r of open) {
    total += n(r.balance_mt);
    lines.push([
      r.dispatch_plant ? displayPlant(r.dispatch_plant) : "",
      plain(r.actual_od, 2),
      plain(r.od, 2),
      n(r.inner_d) ? plain(r.inner_d, 2) : "",
      plain(r.thickness, 2),
      r.ctl_length === null || r.ctl_length === undefined ? "" : Math.round(n(r.ctl_length)),
      Math.round(n(r.balance_qty)),
      plain(r.balance_mt, 2),
      String(r.so_number ?? ""),
    ]);
  }
  lines.push(["", "", "", "", "", "", "", total.toFixed(2), ""]);
  return { text: tsv(lines) };
}

/* ---- STR list ------------------------------------------------------------- */

/**
 * The transfer lines to raise, one per source material, with a shortfall stated as its
 * own line rather than left as a silently short plan.
 */
function strList(rows: Row[], ctx: CopyContext): CopyResult {
  const plan = ctx.scalars.str_plan ?? {};
  const destination = String(plan.destination_plant ?? "8406");
  const sources: string[] = Array.isArray(plan.source_plants) ? plan.source_plants : [];

  const lines: (string | number)[][] = [
    [
      "STOCK TRANSFER REQUEST",
      `as of ${ctx.asOf}`,
      `${plan.target_days ?? 15} days cover at ${destination}`,
    ],
    ["SOURCE PLANT", "DESTINATION PLANT", "FG MATERIAL CODE", "DESCRIPTION",
     "BUCKET", "QTY MT", "REMARK"],
  ];

  let total = 0;
  for (const r of rows.filter((r) => n(r.str_required_mt) > 0)) {
    const strLines = Array.isArray(r.str_lines) ? (r.str_lines as Row[]) : [];
    for (const l of strLines) {
      total += n(l.qty_mt);
      lines.push([
        String(l.plant ?? ""),
        destination,
        String(l.material_code ?? ""),
        String(l.description ?? ""),
        String(r.bucket ?? ""),
        n(l.qty_mt).toFixed(3),
        String(l.remark ?? ""),
      ]);
    }
    if (n(r.str_shortfall_mt) > 0) {
      lines.push([
        "", destination, "", "", String(r.bucket ?? ""), "",
        `Short by ${grouped(n(r.str_shortfall_mt), 3)} MT — no stock at ${sources.join("/")}`,
      ]);
    }
  }
  lines.push(["Total", "", "", "", "", total.toFixed(3), ""]);
  return { text: tsv(lines) };
}

/* ---- Price change request ------------------------------------------------- */

/**
 * A PCR is raised on the code, not on the schedule line, and one customer buys the same
 * SKU under several codes — so this walks the code repository, at bill-to x ship-to x
 * plant x material code, and carries the selected quarter's price across from the priced
 * SKU sharing its material code. A code the schedule never reached says so in the basis
 * column rather than arriving with an empty price and no reason.
 */
function pcr(rows: Row[], ctx: CopyContext, quarter?: string): CopyResult {
  const q = quarter ?? (ctx.scalars.sku_pricing?.quarters ?? []).slice(-1)[0];
  if (!q) return { error: "No priced quarter is published, so there is no price to quote." };

  const byCode = new Map<string, Row>();
  for (const r of ctx.sections.sku_pricing ?? []) {
    const code = String(r.material_code ?? "");
    if (code && !byCode.has(code)) byCode.set(code, r);
  }

  const lines: (string | number)[][] = [
    ["PRICE CHANGE REQUEST", `as of ${ctx.asOf}`, q],
    ["BILL TO CODE", "BILL TO NAME", "SHIP TO CODE", "SHIP TO NAME", "PLANT",
     "MATERIAL CODE", "DESCRIPTION", "SKU", "LENGTH MM", `${q} PRICE`, "UNIT", "BASIS"],
  ];

  for (const r of rows) {
    const match = byCode.get(String(r.material_code ?? ""));
    const price = match ? match[q] : null;
    const operations = Array.isArray(match?.operations) ? (match.operations as string[]) : [];
    lines.push([
      String(r.bill_to_code ?? ""),
      String(r.bill_to_name ?? ""),
      String(r.ship_to_code ?? ""),
      String(r.ship_to_name ?? ""),
      String(r.plant ?? ""),
      String(r.material_code ?? ""),
      String(r.description ?? ""),
      String(r.ctl_bucket ?? r.bucket ?? ""),
      r.length_mm === null || r.length_mm === undefined ? "" : n(r.length_mm).toFixed(0),
      price === null || price === undefined ? "" : n(price).toFixed(2),
      match ? String(match.unit ?? "") : "",
      match
        ? `${match.contract_key} + ${operations.join(", ") || "no value adds"}`
        : "not scheduled, no contract price",
    ]);
  }
  return { text: tsv(lines) };
}


/**
 * What a quarter's billing actually covers, as a line the document carries.
 *
 * Two of the archived sales extracts hold the southern plants only — no Jamshedpur and
 * no Khopoli — where the daily dump and July hold every plant. For Megh Steel alone that
 * is 125 of the 200 invoices in Q1 FY27. A claim built off a quarter like that is not
 * slightly short, it is missing a third of itself, and on the page it looks exactly like
 * a complete one. So every document says which plants it stands on.
 */
function coverageLine(ctx: CopyContext, quarter: string, scalar: string): (string | number)[] {
  const held = ctx.scalars[scalar]?.quarter_coverage?.[quarter];
  if (!held) return ["Plants covered", "not recorded for this quarter"];
  const missing = (held.missing_plants ?? []) as string[];
  const share = Number(held.missing_share ?? 0);
  return [
    "Plants covered",
    (held.plants ?? []).join(" "),
    missing.length
      ? `not in this extract: ${missing.join(" ")} — ${(share * 100).toFixed(1)}% of window tonnage`
      : "every plant the window has billed from",
  ];
}

/* ---- The quarterly CN/DN calculation --------------------------------------- */

/**
 * A quarter of billing for one customer, priced against the contract, in the shape the
 * price-difference reconciliation is built in.
 *
 * This is the working file that used to be typed up by hand as
 * `Price Working <Q> <customer>.xlsx` before the reco script could be run against it. It
 * pastes straight into that sheet.
 *
 * Three things about it are load-bearing:
 *
 *  - **The rows it prices from are the ones on screen**, which are the priced SKUs *as
 *    corrected*. An operation added a minute ago is in this document, and so is a PO price
 *    typed a minute ago, without waiting for a refresh.
 *  - **The PO rate is converted into the unit the line was billed in.** The contract
 *    quotes by the metre; SAP bills by the piece, the metre or the kilogram. Quoting a
 *    per-metre price against a kilogram quantity is how a claim comes out an order of
 *    magnitude wrong, so every line states the unit it was worked in.
 *  - **Rejection is left blank.** The dashboard cannot know what a customer rejected, and
 *    a zero would read as "none" rather than as "not filled in yet". Final qty therefore
 *    equals the billed qty until somebody types a rejection into the sheet.
 *
 * Megh Steel is not in it. It is billed per kilogram against a conversion rate and its
 * reconciliation does not follow the contract formula, so it gets its own document.
 */
const CALCULATION_COLUMNS = [
  "CUSTOMER", "CUSTOMER CODE", "BILLING DOCUMENT", "BILLING ITEM",
  "MATERIAL CODE", "MATERIAL DESCRIPTION", "SALES UNIT",
  "QTY IN NOS", "QTY IN M", "QTY IN KG",
  "BILLING RATE", "PO RATE", "DIFFERENCE OF PRICE",
  "REJECTION", "FINAL QTY", "CN/DN VALUE", "CN/DN", "BASIS",
];

function calculation(rows: Row[], ctx: CopyContext, quarter?: string): CopyResult {
  const q = quarter ?? (ctx.scalars.sku_pricing?.reco_quarters ?? []).slice(-1)[0];
  if (!q) {
    return { error: "This build holds no quarter of billing, so there is nothing to price." };
  }
  const lines = ctx.sections[`reco:${q}`] ?? [];
  if (!lines.length) {
    return {
      error:
        `No billing lines for this customer in ${q}. Either it bought nothing that `
        + "quarter, or the sales dump covering it has not been archived.",
    };
  }

  /**
   * The priced SKUs to quote against.
   *
   * The visible rows first, because those are the ones carrying corrections made since
   * the build — but every one of the customer's priced rows behind them, because this
   * document is sent to someone. A search box still filled in would otherwise drop a SKU
   * out of a CN/DN claim silently, and the line would go out reading "no priced SKU for
   * this code" as though the schedule had never carried it. Same rule the dispatch plan
   * and the clearance list follow, and for the same reason.
   */
  const customer = String(lines[0]?.customer ?? "");
  const behind = (ctx.sections.sku_pricing ?? [])
    .filter((r) => String(r.customer ?? "") === customer);
  const byCode = new Map<string, Row>();
  const byCtl = new Map<string, Row>();
  for (const r of [...rows, ...behind]) {
    const code = String(r.material_code ?? "");
    if (code && !byCode.has(code)) byCode.set(code, r);
    const ctl = String(r.ctl_bucket ?? "");
    if (ctl && !byCtl.has(ctl)) byCtl.set(ctl, r);
  }

  const out: (string | number)[][] = [
    ["PRICE DIFFERENCE WORKING", `as of ${ctx.asOf}`, q],
    coverageLine(ctx, q, "sku_pricing"),
    CALCULATION_COLUMNS,
  ];

  for (const line of lines) {
    const unit = String(line.sales_unit ?? "").trim().toUpperCase();
    const priced = byCode.get(String(line.material_code ?? ""))
      ?? byCtl.get(String(line.ctl_bucket ?? ""));

    // Whatever the line was billed in is what everything else on it is stated in.
    const billedQty = unit === "M" ? n(line.qty_m) : unit === "KG" ? n(line.qty_kg) : n(line.qty_nos);
    const billingRate = line.billing_rate === null || line.billing_rate === undefined
      ? null : n(line.billing_rate);

    let poRate: number | null = null;
    let basis = "no priced SKU for this code";
    if (priced) {
      const lengthM = n(priced.price_length_m) || null;
      const kgPerM = n(priced.kg_per_m) || null;
      const typed = priced[`${q} customer price`];
      const calculated = priced[`${q} per m`];
      if (typed !== null && typed !== undefined) {
        // A typed PO price is in the SKU's own unit, so it comes back to a per-metre
        // figure before being converted into the unit this line was billed in.
        const perM = String(priced.unit) === "INR/m" ? n(typed) : lengthM ? n(typed) / lengthM : null;
        poRate = perM === null ? null : rateInSalesUnit(perM, unit, lengthM, kgPerM);
        basis = `customer PO price ${q}`;
      } else if (calculated !== null && calculated !== undefined) {
        poRate = rateInSalesUnit(n(calculated), unit, lengthM, kgPerM);
        const operations = Array.isArray(priced.operations) ? (priced.operations as string[]) : [];
        basis = `${priced.contract_key} + ${operations.join(", ") || "no value adds"}`;
      } else {
        basis = `no ${q} contract price for this SKU`;
      }
      if (poRate === null && basis.startsWith("customer") === false) {
        basis = `${basis} — cannot be quoted in ${unit || "this unit"}`;
      }
    }

    const difference = poRate === null || billingRate === null ? null : poRate - billingRate;
    // Rejection is blank, so the final quantity is the billed one until it is filled in.
    const finalQty = billedQty;
    const value = difference === null ? null : difference * finalQty;

    out.push([
      String(line.customer ?? ""),
      String(line.customer_code ?? ""),
      String(line.invoice_no ?? ""),
      String(line.billing_item ?? ""),
      String(line.material_code ?? ""),
      String(line.description ?? ""),
      unit,
      plain(line.qty_nos, 0),
      plain(line.qty_m, 3),
      plain(line.qty_kg, 3),
      plain(billingRate, 4),
      plain(poRate, 4),
      plain(difference, 4),
      "",
      plain(finalQty, 3),
      plain(value, 2),
      value === null || Math.abs(value) < 0.005 ? "" : value < 0 ? "CN" : "DN",
      basis,
    ]);
  }
  return { text: tsv(out) };
}


/* ---- Megh Steel's own quarterly working ------------------------------------ */

const MEGH_COLUMNS = [
  "OEM", "CUSTOMER CODE", "BILLING DOCUMENT", "BILLING ITEM", "PLANT",
  "MATERIAL CODE", "MATERIAL DESCRIPTION", "GRADE", "CTL/LL", "SALES UNIT",
  "QTY IN NOS", "QTY IN M", "QTY IN KG",
  "CHARGED INR/KG", "CONTRACT KEY", "CONTRACT INR/MT", "CARRYING DAYS",
  "PROPOSED INR/KG", "DIFF INR/KG", "CN/DN VALUE", "CN/DN", "BASIS",
];

/**
 * Megh Steel's quarter, all four OEMs, in the shape their own workbook divides into
 * sheets — the OEM first, so it splits on a filter.
 *
 * **The claim columns are empty and that is the point.** Megh is a conversion agent, not
 * a customer buying a tube: what it should have been billed is what it can sell on at,
 * less what converting costs it, so the working solves for the ex-JSR rate at which its
 * landed cost equals its realisation. That arithmetic is reproduced exactly — all 2,304
 * TVS lines of both the owner's quarters — but it starts from Megh's own base-price
 * master, looked up by material number in a workbook this dashboard does not hold.
 *
 * Deriving the base from `contract.xlsx` instead gets 1,060 of 1,207 lines right and
 * overstates a Rs 1.76 crore quarter by Rs 5.05 lakh. So the lines, the quantities and
 * the price actually charged are all here, and the claim is left for the master to fill.
 * A claim that is right seven times in eight is not a claim.
 */
function meghCalculation(rows: Row[], ctx: CopyContext, quarter?: string): CopyResult {
  const q = quarter ?? (ctx.scalars.megh_reco?.quarters ?? []).slice(-1)[0];
  if (!q) return { error: "This build holds no quarter of Megh billing." };
  const lines = ctx.sections[`meghreco:${q}`] ?? [];
  if (!lines.length) {
    return { error: `No Megh Steel billing lines in ${q} on this build.` };
  }

  const out: (string | number)[][] = [
    ["MEGH STEEL PRICE DIFFERENCE WORKING", `as of ${ctx.asOf}`, q],
    coverageLine(ctx, q, "megh_reco"),
    ["Claim columns", String(ctx.scalars.megh_reco?.note ?? "")],
    MEGH_COLUMNS,
  ];
  for (const l of lines) {
    out.push([
      String(l.oem ?? ""),
      String(l.customer_code ?? ""),
      String(l.invoice_no ?? ""),
      String(l.billing_item ?? ""),
      displayPlant(l.plant),
      String(l.material_code ?? ""),
      String(l.description ?? ""),
      String(l.grade ?? ""),
      String(l.length_type ?? ""),
      String(l.sales_unit ?? ""),
      plain(l.qty_nos, 0),
      plain(l.qty_m, 3),
      plain(l.qty_kg, 3),
      plain(l.charged_rate_per_kg, 2),
      String(l.contract_key ?? ""),
      plain(l.contract_base_per_mt, 0),
      plain(l.carrying_days, 0),
      "", "", "", "",
      String(l.basis ?? ""),
    ]);
  }
  return { text: tsv(out) };
}

/* ---- The registry --------------------------------------------------------- */

export const COPY_FORMATS: Record<
  CopyKind,
  { label: (arg?: string) => string; build: (rows: Row[], ctx: CopyContext, arg?: string) => CopyResult }
> = {
  clearance: { label: () => "Copy clearance list", build: clearance },
  dispatch: { label: () => "Copy dispatch plan", build: dispatch },
  str: { label: () => "Copy STR list", build: strList },
  pcr: { label: (arg) => (arg ? `Raise PCR · ${arg}` : "Raise PCR"), build: pcr },
  calculation: {
    label: (arg) => (arg ? `Copy calculation · ${arg}` : "Copy calculation"),
    build: calculation,
  },
  megh_calculation: {
    label: (arg) => (arg ? `Copy Megh working · ${arg}` : "Copy Megh working"),
    build: meghCalculation,
  },
};
