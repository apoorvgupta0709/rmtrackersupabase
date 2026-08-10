"use client";

/**
 * The four copy formats that are not "the table as a grid".
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

export type CopyKind = "clearance" | "dispatch" | "str" | "pcr";

/** A copy button, as a view declares it. Serializable: it crosses the server boundary. */
export type CopySpec = { kind: CopyKind; arg?: string };

export type CopyContext = {
  asOf: string;
  scalars: Record<string, any>;
  /** Sections already fetched for this tab, for a format that spans two of them. */
  sections: Record<string, Record<string, unknown>[]>;
};

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
 * chosen. Rather than a second selector that can disagree with the column filters, the
 * choice *is* the column filter: narrow Customer to one and the button knows who it is
 * writing to. Anything else is refused rather than guessed — a clearance request sent to
 * the wrong customer quotes them someone else's stock.
 */
function soleCustomer(rows: Row[]): string | null {
  const names = new Set(rows.map((r) => String(r.customer_display ?? "")).filter(Boolean));
  return names.size === 1 ? [...names][0] : null;
}

const PICK_ONE =
  "Filter the Customer column to a single customer first — this list is addressed to one.";

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
  const customer = soleCustomer(rows);
  if (!customer) return { error: PICK_ONE };

  // CTL stock is a shared pool keyed by CTL bucket, and one customer can carry the same
  // bucket on more than one row, so deduplicate before listing — otherwise the same
  // pieces are offered twice and the total double counts them.
  const seen = new Set<string>();
  const listed = rows
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
  const customer = soleCustomer(rows);
  if (!customer) return { error: PICK_ONE };

  const open = rows
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

/* ---- The registry --------------------------------------------------------- */

export const COPY_FORMATS: Record<
  CopyKind,
  { label: (arg?: string) => string; build: (rows: Row[], ctx: CopyContext, arg?: string) => CopyResult }
> = {
  clearance: { label: () => "Copy clearance list", build: clearance },
  dispatch: { label: () => "Copy dispatch plan", build: dispatch },
  str: { label: () => "Copy STR list", build: strList },
  pcr: { label: (arg) => (arg ? `Raise PCR · ${arg}` : "Raise PCR"), build: pcr },
};
