"use client";

/**
 * One table on a tab, with the totals row the sheet would have, and the controls that
 * make a five-hundred-row sheet answerable: a search box, an Excel-style filter on every
 * column, and click-to-sort.
 *
 * Four rules are enforced here rather than left to each view to remember, because all
 * four have already been got wrong on this dashboard:
 *
 *  - **A column is totalled only when it says so.** Prices, coverage days, ages and
 *    percentages are rates, and a stock pool shared between customers is counted once
 *    however many rows show it. The old rule was "total every numeric column except a
 *    short list", which is the wrong way round: a new rate column shipped summed.
 *  - **A per-row average is averaged, never added.** A table that closes on an average
 *    month divides the tonnage by the months that actually moved, not by the row count
 *    and not by the window length.
 *  - **The totals row states what is on screen.** Filter the table and every figure under
 *    it re-adds over the rows that survived. A total that ignores the filter above it is
 *    worse than no total, because it reads as the answer to the question just asked.
 *  - **The row count says how much was hidden.** "412 of 3,006 rows" is a filter working;
 *    "412 rows" beside a filtered table is a table that looks like the whole truth.
 *
 * Filter state lives in this component, not on the rows: the server re-renders the whole
 * table on every navigation, so anything written onto a row is lost on the next paint.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import AssignCell from "./assign";
import { writeClipboard } from "./clipboard";
import { COPY_FORMATS, type CopyContext, type CopySpec } from "./copies";
import DetailPanel, { type Detail, type DetailLayouts } from "./detail";
import { OperationsCell, PoPriceCell } from "./edit";
import {
  basePerM, buildUp, operationsPerM, priceFor, publishedOperations, skuKey,
  type OperationRates,
} from "./pricing";

export type Kind =
  | "text" | "mt" | "nos" | "int" | "inr" | "days" | "pct" | "rate" | "money"
  | "bool" | "list";

/**
 * How a column says its figures open a breakup.
 *
 * Both fields are templates resolved against the row, because the keys are built two
 * ways: most rows carry theirs precomputed (`{stock_detail_key}`), and the rest are
 * composed from a prefix and a field the row already holds (`LLSCHEDULE|{bucket}`). It
 * is data rather than a function for the same reason `copies` is: columns cross the
 * server-to-client boundary as props, and a function cannot.
 */
export type DetailSpec = {
  key: string;
  title: string;
  /**
   * A field on the row that must be truthy for the figure to open at all.
   *
   * Some breakups exist only where there is something to break up: a lot with no aged
   * tonnage, a bucket nothing was signed off against, an ancillary with no open credit
   * note. The key is still on the row in those cases, so the guard is on the figure.
   */
  when?: string;
};

export type Severity = "alert" | "attention" | "ok";

/**
 * How a column says its figures carry a verdict rather than merely a number.
 *
 * Only three things on this dashboard mean act now — a size short of cover, a lot aged
 * past the governed boundary, a receivable past due — and only the columns carrying
 * those take a colour. Everything else stays graphite, so an inked figure is always a
 * verdict and never a decoration. `globals.css` has the other half of that argument.
 *
 * It is data rather than a function for the reason `detail` and `copies` are: columns
 * cross the server-to-client boundary as props, and a function cannot.
 *
 * Two forms, and the choice between them matters:
 *
 *  - **`words`** reads the build's own verdict off a field. Prefer it wherever the
 *    pipeline already decided, because then the ink and the word beside it cannot drift
 *    apart — and because the same field can mean different things on different tabs.
 *    `coverage_days` is the case in point: the long-length tracker judges it against a
 *    45-day target and the STR plan against 15, so re-thresholding the *number* would
 *    quietly mis-colour one of the two. Reading `risk` gets both right for free.
 *  - **`direction`/`alert`/`attention`** thresholds the figure itself, for the columns
 *    the pipeline publishes no verdict for.
 */
export type SeveritySpec = {
  /** Read the band off this field instead of the column's own value. */
  from?: string;
  /**
   * Only ink the figure when this field is truthy.
   *
   * The counterpart to `DetailSpec.when`, and needed for the same reason: `high_age_mt`
   * takes its band from the age beside it, so a lot with a 700-day oldest batch and no
   * aged tonnage would otherwise print a red `0.000`.
   */
  when?: string;
  /** Which direction is bad. */
  direction?: "low" | "high";
  /** At or beyond this (below it, when `direction` is `low`) the figure is an alert. */
  alert?: number;
  /** Likewise, for attention. Checked only after `alert` fails. */
  attention?: number;
  /** The build's own verdict, mapped to a band. `null` means the word takes no ink. */
  words?: Record<string, Severity | null>;
};

/**
 * A column the reader writes rather than reads.
 *
 * The mapping queues are the working end of this dashboard: a code carrying no governed
 * bucket reaches no tracker, so somebody has to say which bucket it belongs to. The
 * decision is saved against the material code and applied by the next refresh — not to
 * the build on screen, which is a self-contained answer that a single reassignment would
 * leave internally inconsistent.
 */
/**
 * Which space an answer is in.
 *
 * `bucket` is a governed bucket from `Bucketting`; `megh_sku` a key on the Megh plan;
 * `ctl_bucket` a bucket with a cut length appended, which is what the RFD 4731 queue is
 * short of; `oem` the customer's OEM, whose subject is a customer name rather than a
 * material code. They are stored under the same key in `bucket_assignments` and told
 * apart by this, so a value saved in one space can never be read as another.
 *
 * A scope belongs in this union only once the pipeline reads it back by the same string.
 * `test_the_assignable_spaces_agree_everywhere` checks all five places at once.
 */
export type AssignScope = "bucket" | "megh_sku" | "ctl_bucket" | "oem";

export type AssignSpec = {
  /** Which space the choice is in. */
  scope: AssignScope;
  /** The field holding the material code the decision is recorded against. */
  codeField: string;
  /** Which list of choices to offer, by name. The page supplies the lists. */
  options: string;
};

/**
 * A column the reader writes, whose answer changes a figure on the same row now.
 *
 * The counterpart to `assign`, and different from it in the way that matters: a bucket
 * assignment decides which tracker a code's tonnage lands on, so it cannot take effect
 * until the pipeline recomputes everything downstream and the cell says so. A SKU's
 * operations and a customer's PO price feed one arithmetic each, over numbers already on
 * the row, so the browser redoes them and the price beside the control moves.
 */
export type EditSpec =
  | { kind: "operations" }
  | { kind: "po_price"; quarter: string };

export type Column = {
  field: string;
  label: string;
  kind?: Kind;
  /** Sum this column in the totals row. Only quantities; never a rate. */
  total?: boolean;
  /** A month column, so the average-month totals rule can find them. */
  month?: boolean;
  wide?: boolean;
  /** This column's figures open the lines behind them. */
  detail?: DetailSpec;
  /**
   * This column is worked out from the row rather than read off it.
   *
   * For facts the build already carries in pieces and the reader needs in one word — the
   * mapping queues state which master failed and which tabs are short because of it, both
   * of which follow from `mapping_type`, `cause` and the queue the row is on. Deriving
   * here rather than publishing three more fields keeps the pipeline, and the TypeScript
   * port being held to it row for row, untouched.
   *
   * A derived column still needs a unique `field`, because that is what keys its header
   * filter — it just never reaches the row.
   */
  derive?: (row: Record<string, unknown>) => string;
  /** This column is a decision the reader makes, not a figure the build carries. */
  assign?: AssignSpec;
  /** This column's figures carry a verdict, and are inked by it. */
  severity?: SeveritySpec;
  /** This column is editable, and editing it recomputes the row. */
  edit?: EditSpec;
  /** The quarter a price column prices, so its build-up can be recomputed too. */
  priceQuarter?: string;
};

/** What the pricing tab needs to recompute a price the reader has corrected. */
export type PricingContext = {
  /** INR per tonne, from the build's own `operation_rates_inr_per_ton`. */
  rates: OperationRates;
  quarters: string[];
  /** Corrections already recorded, by `customer|bucket|material code|length`. */
  operations: Record<string, string[]>;
  /** PO prices already recorded, by `customer|bucket|material code|length|quarter`. */
  poPrices: Record<string, { price: number; unit: string }>;
  /** Whether this reader may record one. The database enforces it either way. */
  canEdit: boolean;
};

type Corrections = {
  operations: Record<string, string[]>;
  poPrices: Record<string, { price: number; unit: string }>;
};

/**
 * One row with the reader's corrections applied.
 *
 * The base price per metre is recovered from the *published* figures, never from the
 * corrected ones, or a second edit would compound on the first.
 */
function corrected(
  row: Record<string, unknown>,
  pricing: PricingContext,
  held: Corrections,
): Record<string, unknown> {
  const key = skuKey(row);
  const override = key ? held.operations[key] : undefined;
  const operations = override ?? publishedOperations(row);
  const out: Record<string, unknown> = {
    ...row,
    operations,
    operations_per_m: operationsPerM(operations, pricing.rates, row.kg_per_m),
    operations_corrected: override !== undefined,
  };
  for (const quarter of pricing.quarters) {
    const price = priceFor(row, quarter, operations, pricing.rates);
    out[quarter] = price === null ? null : Math.round(price * 100) / 100;
    const base = basePerM(row, quarter);
    out[`${quarter} per m`] =
      base === null ? null : base + operationsPerM(operations, pricing.rates, row.kg_per_m);
    const po = key ? held.poPrices[`${key}|${quarter}`] : undefined;
    out[`${quarter} customer price`] = po ? po.price : null;
    out[`${quarter} diff`] =
      po && price !== null ? Math.round((po.price - price) * 100) / 100 : null;
  }
  return out;
}

/** Closes the table on an average month rather than on a window total. */
export type AverageOver = { monthsField: string; avgField: string; totalField: string };

const NUMERIC: Kind[] = ["mt", "nos", "int", "inr", "days", "pct", "rate", "money"];

const isNumeric = (c: Column) => NUMERIC.includes(c.kind ?? "text");

/** `months.2026-01` reaches into the row's month dict; everything else is a plain key. */
export function get(row: Record<string, unknown>, field: string): unknown {
  if (!field.includes(".")) return row[field];
  const [head, ...rest] = field.split(".");
  const inner = row[head];
  if (inner && typeof inner === "object") {
    return (inner as Record<string, unknown>)[rest.join(".")];
  }
  return undefined;
}

/**
 * Which band a figure falls in, or null for no ink.
 *
 * Silent on everything it cannot judge — an absent field, a null figure, a verdict the
 * map does not list. That is deliberate: a colour is a claim about a number, and the
 * one thing worse than an uncoloured figure here is a confidently coloured wrong one.
 * `tools/check_severity_fields.mjs` is what stops that silence hiding a typo, by failing
 * when a `from`/`when` field or a `words` verdict never appears in the published build.
 */
export function severityOf(
  c: Column,
  row: Record<string, unknown>,
): Severity | null {
  const s = c.severity;
  if (!s) return null;
  if (s.when !== undefined && !get(row, s.when)) return null;

  const value = get(row, s.from ?? c.field);

  if (s.words) {
    if (value === null || value === undefined) return null;
    return s.words[String(value)] ?? null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (s.direction === "low") {
    if (s.alert !== undefined && value < s.alert) return "alert";
    if (s.attention !== undefined && value < s.attention) return "attention";
    return "ok";
  }
  if (s.direction === "high") {
    if (s.alert !== undefined && value >= s.alert) return "alert";
    if (s.attention !== undefined && value >= s.attention) return "attention";
    return "ok";
  }
  return null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const fixed = (value: number, dp: number) =>
  value.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function format(value: unknown, kind: Kind = "text"): string {
  if (kind === "bool") return value === true ? "yes" : "—";
  if (kind === "list") {
    const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
    return list.length ? list.join(", ") : "—";
  }
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "yes" : "no";

  if (typeof value === "number") {
    switch (kind) {
      case "mt": return fixed(value, 3);
      case "nos":
      case "int":
      case "inr":
      case "money": return fixed(value, 0);
      case "days": return fixed(value, Number.isInteger(value) ? 0 : 1);
      case "pct": return `${fixed(value, 2)}%`;
      case "rate": return fixed(value, 2);
      default: return fixed(value, Number.isInteger(value) ? 0 : 3);
    }
  }
  return String(value);
}

const collate = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/**
 * A detail template against one row: `LLSCHEDULE|{bucket}` -> `LLSCHEDULE|25.4-0-2.5-…`.
 *
 * **A placeholder that resolves to nothing makes the whole template resolve to nothing**,
 * and the cell then renders as plain text. Most buckets carry no open order and most
 * sizes are not signed off; a button that opens an empty panel reads as a defect, so a
 * column only offers the drill-down on the rows that have one.
 */
export function fill(template: string, row: Record<string, unknown>): string | null {
  let missing = false;
  const filled = template.replace(/\{([^}]+)\}/g, (_, field: string) => {
    const value = get(row, field);
    if (value === null || value === undefined || value === "") missing = true;
    return String(value ?? "");
  });
  return missing ? null : filled;
}

type Sort = { index: number; dir: 1 | -1 };

/**
 * What a cell pastes as. A copied figure has to arrive in the spreadsheet as a number,
 * so the grouping separators come off anything numeric; `—` and text pass through as
 * they read on the page, because a blank cell in a pasted queue reads as "nothing to
 * report" when the empty cells are the work.
 */
const forPaste = (text: string, column: Column) =>
  isNumeric(column) ? text.replace(/,/g, "") : text;

/* ---- The per-column filter popup ----------------------------------------- */

/**
 * The distinct values in one column, searchable and multi-selectable.
 *
 * It is anchored to the header with fixed positioning through a portal rather than
 * placed inside the cell: the table sits in an `overflow-x: auto` box, which clips an
 * absolutely positioned child, and the last column's list was the one that needed
 * reaching most. Both edges are clamped to the viewport, and it opens upwards when
 * there is no room beneath, so no list is ever off screen.
 */
function FilterPopup({
  cell,
  values,
  chosen,
  onChange,
  onClose,
}: {
  cell: HTMLTableCellElement;
  values: string[];
  chosen: Set<string> | undefined;
  onChange: (next: Set<string> | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<DOMRect>(() => cell.getBoundingClientRect());
  const box = useRef<HTMLDivElement>(null);

  // Values hidden by the search box keep whatever state they had, so searching narrows
  // what you can tick without silently dropping the rest of the selection.
  const ticked = useMemo(
    () => new Set(chosen ? [...chosen] : values),
    [chosen, values],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? values.filter((v) => v.toLowerCase().includes(needle)) : values;
  }, [values, query]);

  const commit = useCallback(
    (next: Set<string>) => onChange(next.size === values.length ? null : next),
    [onChange, values.length],
  );

  const toggle = (value: string) => {
    const next = new Set(ticked);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    commit(next);
  };

  const setShown = (on: boolean) => {
    const next = new Set(ticked);
    for (const v of shown) {
      if (on) next.add(v);
      else next.delete(v);
    }
    commit(next);
  };

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    /**
     * Follow the header rather than dismissing on scroll.
     *
     * This used to close the panel, because scrolling the table sideways left it pointing
     * at nothing. The header is sticky now, so a vertical scroll does not move the cell at
     * all and closing would look like the panel dismissing itself for no reason. So
     * re-measure instead, in the capture phase so the `overflow: auto` box counts too, and
     * close only when the cell has genuinely gone — a re-render that replaces the row, or
     * a filter that removes the column.
     */
    const track = () => {
      if (!cell.isConnected) {
        onClose();
        return;
      }
      setAnchor(cell.getBoundingClientRect());
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", track, true);
    window.addEventListener("resize", track);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", track, true);
      window.removeEventListener("resize", track);
    };
  }, [cell, onClose]);

  const margin = 8;
  const width = 274;
  const height = Math.min(340, window.innerHeight - 2 * margin);
  const below = anchor.bottom + 4;
  const top =
    below + height + margin <= window.innerHeight
      ? below
      : Math.max(margin, Math.min(anchor.top - height - 4, window.innerHeight - height - margin));

  return createPortal(
    <div
      ref={box}
      className="filter-pop"
      style={{
        left: Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin)),
        top,
        width,
        maxHeight: height,
      }}
    >
      <input
        type="search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search values"
        aria-label="Search values"
      />
      <div className="filter-pop-actions">
        <button type="button" onClick={() => setShown(true)}>Select all</button>
        <button type="button" onClick={() => setShown(false)}>Clear</button>
        <button type="button" onClick={() => { onChange(null); onClose(); }}>Remove filter</button>
      </div>
      <div className="filter-pop-list">
        {shown.length === 0 ? (
          <div className="filter-pop-empty">No matching values.</div>
        ) : (
          shown.map((value) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={ticked.has(value)}
                onChange={() => toggle(value)}
              />
              <span>{value === "" ? <em>(blank)</em> : value}</span>
            </label>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ---- The table ------------------------------------------------------------ */

export default function DataTable({
  title,
  note,
  columns,
  rows: published,
  averageOver,
  capped,
  copies,
  copyContext,
  buildId,
  layouts,
  assignments,
  assignOptions,
  canAssign,
  unmapped,
  pricing,
}: {
  title: string;
  note?: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  averageOver?: AverageOver;
  capped?: number;
  copies?: CopySpec[];
  copyContext?: CopyContext;
  /** The build the figures came from, so a breakup is fetched from the same one. */
  buildId: string;
  /** The per-prefix column layouts, from the build's own `detail_columns`. */
  layouts: DetailLayouts;
  /** Decisions already recorded, keyed `scope|material code`. Not build-scoped. */
  assignments?: Record<string, string>;
  /** The choices each assignable column offers, by the name the column asks for. */
  assignOptions?: Record<string, string[]>;
  /** Whether this reader may record a decision. The database enforces it either way. */
  canAssign?: boolean;
  /** Fields that decide whether a row still needs an answer — see `unmapped` on TableSpec. */
  unmapped?: string[];
  /** Corrections to the contract price, and what they are computed against. */
  pricing?: PricingContext;
}) {
  /**
   * The rows as corrected, not as published.
   *
   * A price is arithmetic over figures already on the row, so an operation added or
   * removed is redone here rather than waited on. Deriving whole rows — rather than
   * teaching each price column to recompute itself — is what keeps the rest of this
   * component from having to know anything about pricing: the filters, the text sort, the
   * totals row, the copy buttons and the detail templates all read the corrected figure
   * because they read the row.
   */
  const [corrections, setCorrections] = useState<Corrections>(() => ({
    operations: pricing?.operations ?? {},
    poPrices: pricing?.poPrices ?? {},
  }));
  const rows = useMemo(
    () => (pricing ? published.map((row) => corrected(row, pricing, corrections)) : published),
    [published, pricing, corrections],
  );

  /** The SKU an override is recorded against, or null where the row cannot be keyed. */
  const skuOf = (row: Record<string, unknown>) => {
    const length = Number(row.length_mm);
    if (!Number.isFinite(length)) return null;
    return {
      customer: String(row.customer ?? ""),
      bucket: String(row.bucket ?? ""),
      material_code: String(row.material_code ?? ""),
      length_mm: length,
    };
  };

  const setOperations = (row: Record<string, unknown>, next: string[] | null) => {
    const key = skuKey(row);
    if (!key) return;
    setCorrections((held) => {
      const operations = { ...held.operations };
      if (next === null) delete operations[key];
      else operations[key] = next;
      return { ...held, operations };
    });
  };

  const setPoPrice = (
    row: Record<string, unknown>,
    quarter: string,
    next: { price: number; unit: string } | null,
  ) => {
    const key = skuKey(row);
    if (!key) return;
    setCorrections((held) => {
      const poPrices = { ...held.poPrices };
      if (next === null) delete poPrices[`${key}|${quarter}`];
      else poPrices[`${key}|${quarter}`] = next;
      return { ...held, poPrices };
    });
  };

  /**
   * The price build-up for a corrected SKU, or nothing — in which case the panel fetches
   * the pipeline's own rows, so an untouched price always opens the published working.
   */
  const correctedBuildUp = (row: Record<string, unknown>, column: Column) => {
    if (!pricing || !column.priceQuarter || !row.operations_corrected) return undefined;
    return buildUp(
      row, column.priceQuarter, publishedOperations(row), pricing.rates,
    ) as unknown as Record<string, unknown>[];
  };

  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  /** Hide the rows somebody has already answered. Only offered where `unmapped` is set. */
  const [unansweredOnly, setUnansweredOnly] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);
  const [open, setOpen] = useState<{ index: number; cell: HTMLTableCellElement } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  /**
   * What the last copy attempt did, and which button did it.
   *
   * A refusal is a sentence, not a word — "filter to one customer first" does not fit on
   * a chip — so it is said in full under the toolbar while the button keeps its label.
   * A success is said on the button, where the eye already is.
   */
  const [flash, setFlash] = useState<{ id: string; message: string; ok: boolean } | null>(null);

  /**
   * What every cell reads as, worked out once.
   *
   * Filters and text sort run on the rendered text, not on the underlying value, for the
   * same reason the old page did: the list a header offers has to be the list the reader
   * can see in the column. A null is `—` in both places, a tonnage is grouped and rounded
   * in both, so ticking a value always hides exactly the rows showing it.
   */
  const display = useMemo(
    () =>
      rows.map((row) =>
        columns.map((c) => {
          // An assignable column holds a decision, not a figure, and the decision does
          // not live on the row. It still has to read as text here or the header filter
          // could not offer "unassigned", the sort could not group by bucket, and the
          // copied queue would go out with the assignment column blank.
          if (c.assign) {
            return assignments?.[`${c.assign.scope}|${get(row, c.assign.codeField)}`]
              ?? "unassigned";
          }
          // Derived here as well as in the cell, so a filter offers what the column shows
          // and the copied queue goes out with the same words on it.
          if (c.derive) return format(c.derive(row) || null, "text");
          return format(get(row, c.field), c.kind);
        }),
      ),
    [rows, columns, assignments],
  );

  const chosen = useMemo(() => {
    const map = new Map<number, Set<string>>();
    for (const [index, values] of Object.entries(picked)) map.set(Number(index), new Set(values));
    return map;
  }, [picked]);

  const needle = search.trim().toLowerCase();

  /**
   * The columns that decide whether a row is still unanswered, as indices into `display`.
   *
   * Read off the rendered text rather than the row, which is what lets one list mix a
   * field the row carries (`bucket`) with one only the cell knows (`__assign_bucket`):
   * both are just text by the time they get here, and both read `—` or `unassigned` when
   * there is nothing in them.
   */
  const unmappedAt = useMemo(
    () => (unmapped ?? [])
      .map((field) => columns.findIndex((c) => c.field === field))
      .filter((i) => i >= 0),
    [unmapped, columns],
  );

  /** What an empty answer looks like once rendered. */
  const blank = (text: string) => text === "" || text === "—" || text === "unassigned";

  /**
   * A row passes when the search box accepts it, the unanswered toggle accepts it, and
   * every column filter except the one being edited accepts it. Skipping the edited
   * column is what makes the filters compose: the values a header offers are drawn from
   * the rows the *other* headers still allow, so narrowing one column narrows the choices
   * in the next without a column ever hiding its own unticked values from itself.
   *
   * The toggle sits inside this gate deliberately, rather than narrowing `rows` before
   * it. Everything downstream — the row count, the totals under the table, the copy
   * buttons, the values each header offers — reads what this returns, so putting it here
   * is what keeps all five saying the same thing about the same rows.
   */
  const passes = useCallback(
    (i: number, skip: number) => {
      const cells = display[i];
      if (needle && !cells.some((text) => text.toLowerCase().includes(needle))) return false;
      // Answered by *any* of them, not all: a code the master already governs is not
      // work, and neither is one somebody has since assigned.
      if (unansweredOnly && unmappedAt.length
        && !unmappedAt.every((index) => blank(cells[index]))) return false;
      for (const [index, allowed] of chosen) {
        if (index === skip) continue;
        if (!allowed.has(cells[index])) return false;
      }
      return true;
    },
    [display, needle, chosen, unansweredOnly, unmappedAt],
  );

  const visible = useMemo(() => {
    const keep: number[] = [];
    for (let i = 0; i < rows.length; i++) if (passes(i, -1)) keep.push(i);
    if (sort) {
      const column = columns[sort.index];
      if (isNumeric(column)) {
        keep.sort(
          (a, b) =>
            (num(get(rows[a], column.field)) - num(get(rows[b], column.field))) * sort.dir,
        );
      } else {
        keep.sort((a, b) => collate(display[a][sort.index], display[b][sort.index]) * sort.dir);
      }
    }
    return keep;
  }, [rows, columns, display, passes, sort]);

  /** The distinct values the open header can offer, over the rows its siblings allow. */
  const options = useMemo(() => {
    if (!open) return [];
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) if (passes(i, open.index)) seen.add(display[i][open.index]);
    return [...seen].sort(collate);
  }, [open, rows.length, display, passes]);

  const filtered = needle !== "" || chosen.size > 0 || unansweredOnly;

  const clearAll = () => {
    setSearch("");
    setPicked({});
    setUnansweredOnly(false);
    setOpen(null);
  };

  const setColumn = (index: number, next: Set<string> | null) =>
    setPicked((state) => {
      const copy = { ...state };
      if (next === null) delete copy[index];
      else copy[index] = [...next];
      return copy;
    });

  const cycleSort = (index: number) =>
    setSort((state) =>
      !state || state.index !== index
        ? { index, dir: 1 }
        : state.dir === 1
          ? { index, dir: -1 }
          : null,
    );

  // Totals over what is on screen, not over what was fetched.
  const totals: Record<string, number> = {};
  for (const c of columns) {
    if (c.total && isNumeric(c)) {
      totals[c.field] = visible.reduce((sum, i) => sum + num(get(rows[i], c.field)), 0);
    }
  }

  // Months that moved at all across the visible rows — the denominator the average
  // month is taken over. A window of eight months in which a SKU sold in three is a
  // three-month average, and the totals row must say the same thing the cells do.
  if (averageOver) {
    const monthFields = columns.filter((c) => c.month).map((c) => c.field);
    const moved = monthFields.filter((f) =>
      visible.some((i) => num(get(rows[i], f)) !== 0),
    ).length;
    // Sum the total field here rather than reading it out of `totals`: a table that has
    // dropped its window-total column still has the field on the row, and reading a
    // missing key would have made every average zero rather than obviously broken.
    const totalOver = visible.reduce(
      (sum, i) => sum + num(get(rows[i], averageOver.totalField)),
      0,
    );
    totals[averageOver.monthsField] = moved;
    totals[averageOver.avgField] = moved ? totalOver / moved : 0;
  }

  const count = visible.length.toLocaleString("en-IN");
  const held = rows.length.toLocaleString("en-IN");

  // The totals row, worked out once. The rendered cells and the copied ones read off the
  // same array, so a pasted sheet can never close on a different figure from the page.
  const footer = columns.map((c, i) =>
    i === 0
      ? `${count} rows`
      : c.field in totals
        ? format(totals[c.field], c.field === averageOver?.monthsField ? "int" : c.kind)
        : "",
  );

  /**
   * The table as tab-separated text, for paste into a spreadsheet.
   *
   * **What is copied is what is on screen** — the visible rows, in the order they are
   * sorted into, closing on the totals row that was re-added over exactly them. A copy
   * button that quietly pastes the rows a filter just hid produces a sheet that
   * disagrees with the screen it was taken from, and the reader has no way to tell.
   */
  const tableAsTsv = () =>
    [
      columns.map((c) => c.label),
      ...visible.map((i) => columns.map((c, k) => forPaste(display[i][k], c))),
      footer.map((cell, k) => forPaste(cell, columns[k])),
    ]
      .map((line) => line.join("\t"))
      .join("\n");

  const announce = (id: string, message: string, ok: boolean) => {
    setFlash({ id, message, ok });
    setTimeout(() => setFlash((was) => (was?.id === id ? null : was)), ok ? 1600 : 6000);
  };

  /** Put text on the clipboard, or say why there is none to put there. */
  const run = async (id: string, produce: () => { text: string } | { error: string }) => {
    const result = produce();
    if ("error" in result) {
      announce(id, result.error, false);
      return;
    }
    try {
      await writeClipboard(result.text);
      announce(id, "Copied", true);
    } catch {
      announce(id, "The browser refused the clipboard. Copy again, or check permissions.", false);
    }
  };

  /** The rows a bespoke format works on: the visible ones, in the order they are shown. */
  const visibleRows = () => visible.map((i) => rows[i]);

  return (
    <section style={{ marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, letterSpacing: "-0.015em" }}>{title}</h2>
        <span className="label">
          {filtered ? `${count} of ${held} rows` : `${held} row${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {note && (
        <p className="hint" style={{ margin: "6px 0 0", maxWidth: 860 }}>
          {note}
        </p>
      )}

      {capped !== undefined && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          Showing the first {held} rows; this table is capped at{" "}
          {capped.toLocaleString("en-IN")} and there are more behind it. The filters and
          the totals below cover only what is shown.
        </div>
      )}

      {rows.length > 0 && (
        <div className="filters">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter rows"
            aria-label={`Filter ${title}`}
          />
          {unmappedAt.length > 0 && (
            <button
              type="button"
              className={unansweredOnly ? "chip on" : "chip"}
              aria-pressed={unansweredOnly}
              title={
                "Show only the rows nobody has answered yet — no value in the master and "
                + "no assignment recorded. The count and the totals follow it."
              }
              onClick={() => setUnansweredOnly((on) => !on)}
            >
              Only unanswered
            </button>
          )}
          <button
            type="button"
            className="chip"
            onClick={() => run("table", () => ({ text: tableAsTsv() }))}
          >
            {flash?.id === "table" && flash.ok ? "Copied" : "Copy table"}
          </button>
          {copyContext &&
            (copies ?? []).map((spec) => {
              const format = COPY_FORMATS[spec.kind];
              const id = `${spec.kind}:${spec.arg ?? ""}`;
              return (
                <button
                  key={id}
                  type="button"
                  className="chip"
                  onClick={() =>
                    run(id, () => format.build(visibleRows(), copyContext, spec.arg))
                  }
                >
                  {flash?.id === id && flash.ok ? "Copied" : format.label(spec.arg)}
                </button>
              );
            })}
          {filtered && (
            <button type="button" className="chip" onClick={clearAll}>
              Clear filters
            </button>
          )}
          {sort && (
            <button type="button" className="chip" onClick={() => setSort(null)}>
              Sorted by {columns[sort.index].label} {sort.dir === 1 ? "↑" : "↓"} — clear
            </button>
          )}
          <span className="hint" style={{ fontSize: 12.5 }}>
            Every header filters and sorts; what is copied is what is left.
          </span>
        </div>
      )}

      {flash && !flash.ok && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          {flash.message}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="notice" style={{ marginTop: 10 }}>
          Nothing on this table for the published build. That is either an empty queue —
          which is the good outcome — or a tab your account has no grant for, in which
          case the policies returned no rows rather than hiding them.
        </div>
      ) : (
        <div className="sheet" style={{ marginTop: 10 }}>
          <div className="scroll-box">
            <table>
              <thead>
                <tr>
                  {columns.map((c, index) => {
                    const on = chosen.has(index);
                    return (
                      <th
                        key={c.field}
                        className={isNumeric(c) ? "num" : undefined}
                        data-filtered={on ? "1" : undefined}
                        aria-sort={
                          sort?.index === index
                            ? sort.dir === 1 ? "ascending" : "descending"
                            : undefined
                        }
                      >
                        <span className="th-inner">
                          <button
                            type="button"
                            className="th-label"
                            onClick={() => cycleSort(index)}
                            title={`Sort by ${c.label}`}
                          >
                            {c.label}
                            {sort?.index === index && (
                              <span className="th-sort">{sort.dir === 1 ? "▲" : "▼"}</span>
                            )}
                          </button>
                          <button
                            type="button"
                            className="th-filter"
                            title={`Filter ${c.label}`}
                            aria-label={`Filter ${c.label}`}
                            onClick={(e) => {
                              // Read `currentTarget` inside the handler, not inside the
                              // state updater: React clears it once the handler returns,
                              // and a lazy updater runs after that. The cell itself is
                              // stored rather than its rect, so the panel can follow a
                              // sticky header instead of dismissing when the page scrolls.
                              const cell = e.currentTarget.closest("th");
                              if (!cell) return;
                              setOpen((state) =>
                                state?.index === index ? null : { index, cell },
                              );
                            }}
                          >
                            ≡
                          </button>
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.map((i) => (
                  <tr key={i}>
                    {columns.map((c, index) => {
                      // The button carries the same text the cell would have shown, so the
                      // filters, the text sort and the copy — all of which read the
                      // rendered string — cannot tell a clickable column from a plain one.
                      const guarded =
                        c.detail?.when !== undefined && !get(rows[i], c.detail.when);
                      const key = c.detail && !guarded ? fill(c.detail.key, rows[i]) : null;
                      // The severity class goes on the cell rather than on the figure
                      // inside it, so a plain number and a `.drill` button are inked by
                      // the same rule — the button declares `color: inherit`.
                      const sev = severityOf(c, rows[i]);
                      const classes = [isNumeric(c) ? "num" : "", sev ? `sev-${sev}` : ""]
                        .filter(Boolean).join(" ");
                      return (
                        <td
                          key={c.field}
                          className={classes || undefined}
                          style={
                            c.wide
                              ? { maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }
                              : undefined
                          }
                          // The rendered text, not the raw field: a derived column has no
                          // field to read, and its full value is exactly what a truncated
                          // cell needs a tooltip for.
                          title={c.wide ? display[i][index] : undefined}
                        >
                          {c.assign ? (
                            <AssignCell
                              scope={c.assign.scope}
                              code={String(get(rows[i], c.assign.codeField) ?? "")}
                              options={assignOptions?.[c.assign.options] ?? []}
                              initial={
                                assignments?.[
                                  `${c.assign.scope}|${get(rows[i], c.assign.codeField)}`
                                ] ?? ""
                              }
                              canAssign={canAssign ?? false}
                            />
                          ) : c.edit?.kind === "operations" && pricing ? (
                            <OperationsCell
                              sku={skuOf(rows[i])}
                              operations={publishedOperations(rows[i])}
                              offered={Object.keys(pricing.rates).sort()}
                              corrected={Boolean(rows[i].operations_corrected)}
                              canEdit={pricing.canEdit}
                              onChange={(next) => setOperations(rows[i], next)}
                            />
                          ) : c.edit?.kind === "po_price" && pricing ? (
                            <PoPriceCell
                              sku={skuOf(rows[i])}
                              quarter={c.edit.quarter}
                              unit={String(rows[i].unit ?? "")}
                              price={
                                typeof rows[i][c.field] === "number"
                                  ? (rows[i][c.field] as number)
                                  : null
                              }
                              canEdit={pricing.canEdit}
                              onChange={(next) =>
                                setPoPrice(rows[i], (c.edit as { quarter: string }).quarter, next)
                              }
                            />
                          ) : key && c.detail ? (
                            <button
                              type="button"
                              className="drill"
                              onClick={() =>
                                setDetail({
                                  key,
                                  title: fill(c.detail!.title, rows[i]) ?? c.label,
                                  // A corrected SKU's build-up is recomputed here rather
                                  // than fetched: the stored rows are the pipeline's, and
                                  // they will not carry the correction until it reruns.
                                  rows: correctedBuildUp(rows[i], c),
                                })
                              }
                            >
                              {display[i][index]}
                            </button>
                          ) : (
                            display[i][index]
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  {columns.map((c, i) => (
                    <td key={c.field} className={isNumeric(c) ? "num" : undefined}>
                      {footer[i]}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {visible.length === 0 && rows.length > 0 && (
        <div className="notice" style={{ marginTop: 10 }}>
          No row matches the filters on this table. The {held} rows behind them are still
          here —{" "}
          <button type="button" className="linkish" onClick={clearAll}>
            clear the filters
          </button>{" "}
          to see them.
        </div>
      )}

      {open && (
        <FilterPopup
          cell={open.cell}
          values={options}
          chosen={chosen.get(open.index)}
          onChange={(next) => setColumn(open.index, next)}
          onClose={() => setOpen(null)}
        />
      )}

      {detail && (
        <DetailPanel
          detail={detail}
          buildId={buildId}
          layouts={layouts}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}
