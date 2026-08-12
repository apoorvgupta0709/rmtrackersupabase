"use client";

/**
 * The drill-down: the lines behind one figure.
 *
 * On this dashboard the breakup is the answer. A bucket short of cover is only
 * actionable once you can see which batches, at which plant, held for whom, make up the
 * pool — so every quantity on every tab opens the rows it was added from.
 *
 * The rows are not carried with the page. There are 16,689 of them across 6,013 keys,
 * 56% of the old payload, for data nobody sees until they open one; so a key is fetched
 * when it is opened and kept for the rest of the visit.
 *
 * Three rules govern the totals row, and each of them was wrong on this dashboard once:
 *
 *  - **A formula breakup has no total.** Coverage days and the two gap cards list their
 *    inputs and their result; adding a column of those is meaningless arithmetic that
 *    still renders as a figure.
 *  - **A breakup whose rows are months closes on an average month.** Adding a history
 *    gives the size of the window, not the size of a month, and the schedule beside it is
 *    one month of demand.
 *  - **Each quantity column totals its own field.** The sign-off breakup carries three —
 *    signed, not signed, order — and one total computed from `qty` and repeated across
 *    them read as a bucket both fully signed off and fully outstanding.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabaseBrowser } from "@/lib/supabase/client";
import { writeClipboard } from "./clipboard";
import RemarkCell from "./remark";

/** A column of a breakup, as the pipeline declares it in `detail_columns`. */
export type DetailColumn = {
  label: string;
  field: string;
  kind?: "num" | "qty" | "mt" | "plant" | "remark";
  /** Sum this column even though it is not the row's own quantity field. */
  add?: boolean;
};

export type DetailLayouts = Record<string, DetailColumn[]>;

/**
 * What a figure opens: the key to fetch, and what to call the panel it opens into.
 *
 * `rows` short-circuits the fetch, and is used for exactly one thing: a price whose
 * operations the reader has corrected. The stored breakup is the pipeline's and will not
 * carry the correction until it reruns, so a panel that fetched it would explain a
 * different number from the one the reader just clicked. Everything else fetches.
 */
export type Detail = { key: string; title: string; rows?: Record<string, unknown>[] };

/**
 * The layout for a prefix the pipeline declares nothing for. Sixteen of the thirty-four
 * live prefixes carry a layout; the rest are source-and-quantity lists and fall back here
 * deliberately rather than shipping an empty table.
 */
const DEFAULT_DETAIL_COLUMNS: DetailColumn[] = [
  { label: "Source / Plant", field: "__source_plant" },
  { label: "SKU", field: "sku" },
  { label: "Material code", field: "material_code" },
  { label: "Quantity", field: "qty", kind: "qty" },
];

/** Formula breakups: inputs and a result, so a column of them adds to nothing. */
const NO_TOTAL = new Set(["LLCOVERAGE", "LLGAP45", "LLGAP", "BALANCE"]);

/** Breakups whose rows are months, and only the months that moved. */
const AVERAGE_BY_MONTH = new Set(["LLHISTORY", "SKUHISTORY"]);

/**
 * The one column here the pipeline does not declare.
 *
 * Every other column of every breakup comes from the build's `detail_columns`, because
 * every other column is build data. A remark is not: it is written from this panel, lives
 * in its own table and outlives the build it was typed against. Declaring it in the
 * pipeline would also mean it did not appear until the next refresh had run, for a column
 * that has nothing to do with a refresh.
 */
const REMARK_COLUMN: DetailColumn = { label: "Remark", field: "__remark", kind: "remark" };

/** What a remark is held against: the invoice, not the accounting document. */
const invoiceOf = (row: Record<string, unknown>) => String(row.invoice_no ?? "").trim();

/** A remark as the panel holds it, keyed by invoice number. */
type Remark = { remark: string; at: string };

/** `STOCKCTL|789|3177055|Allied` -> `STOCKCTL`. It is what a grant is checked against. */
export const detailPrefix = (key: string) => key.split("|", 1)[0];

/** The plant codes that are written with their leading zero. */
const displayPlant = (plant: unknown) => {
  const value = String(plant ?? "");
  return ["789", "788", "56"].includes(value) ? value.padStart(4, "0") : value;
};

const fixed = (value: unknown, dp: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : "—";

/**
 * How many decimals a quantity is read to, from the row's own unit. Pieces are counted,
 * rupees are read to the paisa, and tonnage to the kilogram.
 */
const digitsFor = (unit: unknown) => (unit === "NOS" ? 0 : unit === "INR" ? 2 : 3);

const isNumeric = (c: DetailColumn) => c.kind === "num" || c.kind === "qty" || c.kind === "mt";

function detailCell(
  row: Record<string, unknown>,
  column: DetailColumn,
  remarks?: Map<string, Remark>,
): string {
  // The default layout puts the two together, because on a stock list neither answers
  // "where is this" on its own.
  if (column.field === "__source_plant") {
    return `${row.source ?? "—"} · ${displayPlant(row.plant)}`;
  }
  // Not on the row: a remark is looked up by invoice number. Reading it as text is what
  // lets the copied table carry it alongside the columns the build declared.
  if (column.kind === "remark") return remarks?.get(invoiceOf(row))?.remark || "—";
  const value = row[column.field];
  if (column.kind === "qty") return `${fixed(value, digitsFor(row.unit))} ${row.unit ?? ""}`.trim();
  if (column.kind === "num") return fixed(value, 0);
  if (column.kind === "mt") return fixed(value, 3);
  if (column.kind === "plant") return displayPlant(value);
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/**
 * Fetched keys, kept for the visit.
 *
 * Keyed by build as well as by detail key: an admin can read every build, so a cache on
 * the key alone would serve yesterday's breakup under today's figure after a republish.
 */
const cache = new Map<string, Record<string, unknown>[]>();

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; rows: Record<string, unknown>[] };

export default function DetailPanel({
  detail,
  buildId,
  layouts,
  onClose,
}: {
  detail: Detail;
  buildId: string;
  layouts: DetailLayouts;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>(() => {
    const held = cache.get(`${buildId}|${detail.key}`);
    return held ? { phase: "ready", rows: held } : { phase: "loading" };
  });
  const [copied, setCopied] = useState(false);
  // Deliberately not in `cache`: that is keyed by build and holds what the build says,
  // which is exactly what a remark is not. Keeping them together would serve a stale
  // remark the moment one was saved, and again every time the panel was reopened.
  const [remarks, setRemarks] = useState<Map<string, Remark>>(() => new Map());
  const card = useRef<HTMLDivElement>(null);
  const closer = useRef<HTMLButtonElement>(null);

  const prefix = detailPrefix(detail.key);
  const declared = layouts[prefix] ?? DEFAULT_DETAIL_COLUMNS;
  // Only an overdue invoice can be remarked. The offsets beside it are credit notes and
  // collections — documents, not receivables anybody is chasing a reason for.
  const remarkable = prefix === "OVERDUE";
  const columns = useMemo(
    () => (remarkable ? [...declared, REMARK_COLUMN] : declared),
    [declared, remarkable],
  );

  /** `OVERDUE|BALAJI PRESS PRODUCTS INDIA` -> `BALAJI PRESS PRODUCTS INDIA`. */
  const ancillary = detail.key.slice(prefix.length + 1);

  useEffect(() => {
    // A different figure was opened: drop the last one's remarks rather than letting them
    // sit behind the new rows until their own read returns.
    setRemarks(new Map());
    // Rows handed in are not cached: they are this reader's correction, not the build's
    // answer, and caching them would serve the correction to the next figure opened
    // against the same key after it had been reverted.
    if (detail.rows) {
      setState({ phase: "ready", rows: detail.rows });
      return;
    }
    const slot = `${buildId}|${detail.key}`;
    if (cache.has(slot)) {
      setState({ phase: "ready", rows: cache.get(slot)! });
      return;
    }
    let live = true;
    setState({ phase: "loading" });
    (async () => {
      // The prefix is passed as well as the key: it leads the primary key, and it is what
      // the RLS policy checks a grant against. The build id is passed rather than left
      // implicit — the policies hold a viewer to the current build but let an admin read
      // every build, so an unfiltered query would merge them.
      const { data, error } = await supabaseBrowser()
        .from("detail_rows")
        .select("row")
        .eq("build_id", buildId)
        .eq("prefix", prefix)
        .eq("detail_key", detail.key)
        .order("seq");
      if (!live) return;
      if (error) {
        setState({
          phase: "error",
          message:
            `The breakup behind this figure could not be read: ${error.message}. `
            + "The figure itself is from the published build and is unaffected.",
        });
        return;
      }
      const rows = (data ?? []).map((d) => d.row as Record<string, unknown>);
      cache.set(slot, rows);
      setState({ phase: "ready", rows });
    })();
    return () => {
      live = false;
    };
  }, [buildId, detail.key, detail.rows, prefix]);

  // Escape closes the panel and goes no further: the column filter listens for the same
  // key, and one press should not dismiss two things.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key, true);
    closer.current?.focus();
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);

  const rows = useMemo(
    () => (state.phase === "ready" ? state.rows : []),
    [state],
  );

  // The remarks for the invoices on screen, read once the rows are known and held apart
  // from them. A failure here is quiet on purpose: the breakup is the answer and it has
  // already loaded, so an empty remark column is a worse outcome than a warning banner
  // over figures that are perfectly good.
  useEffect(() => {
    if (!remarkable || !rows.length) return;
    const invoices = [...new Set(rows.map(invoiceOf).filter(Boolean))];
    if (!invoices.length) return;
    let live = true;
    (async () => {
      const { data } = await supabaseBrowser()
        .from("invoice_remarks")
        .select("invoice_no,remark,remarked_at")
        .in("invoice_no", invoices);
      if (!live) return;
      setRemarks(
        new Map(
          (data ?? []).map((r) => [
            String(r.invoice_no),
            { remark: String(r.remark ?? ""), at: String(r.remarked_at ?? "") },
          ]),
        ),
      );
    })();
    return () => {
      live = false;
    };
  }, [remarkable, rows]);

  // One invoice can arrive as several line items. They are the same invoice with the same
  // reason for being late, so the save from any of them moves all of them.
  const noteSaved = useCallback((invoice: string, remark: string, at: string) => {
    setRemarks((held) => {
      const next = new Map(held);
      if (remark) next.set(invoice, { remark, at });
      else next.delete(invoice);
      return next;
    });
  }, []);

  /**
   * The totals row, or none. A summable column is one holding the row's own quantity or
   * one the layout marks outright — `kind: "mt"` is not enough, being also weight per
   * metre and rupees per metre on the price build-up.
   */
  const footer = useMemo(() => {
    if (!rows.length || NO_TOTAL.has(prefix)) return null;
    const summable = columns.filter((c) => c.kind === "qty" || c.add === true);
    if (!summable.length) return null;
    const byMonth = AVERAGE_BY_MONTH.has(prefix);
    const over = byMonth ? rows.length : 1;
    const unit = rows[0].unit;
    return columns.map((c, index) => {
      if (!(c.kind === "qty" || c.add === true)) {
        return index === 0 ? (byMonth ? "Average month" : "Total") : "";
      }
      const total = rows.reduce((sum, row) => sum + (Number(row[c.field]) || 0), 0);
      // A summable column is not necessarily in the row's own unit. The pieces column
      // beside a tonnage is a count: it takes no unit and no decimals.
      const counts = c.kind === "num";
      const places = counts ? 0 : c.kind === "qty" ? digitsFor(unit) : 3;
      return `${fixed(total / over, places)}${counts ? "" : ` ${unit ?? ""}`}`.trim();
    });
  }, [rows, columns, prefix]);

  const asTsv = () =>
    [
      columns.map((c) => c.label),
      ...rows.map((row) =>
        columns.map((c) => {
          const text = detailCell(row, c, remarks);
          return isNumeric(c) ? text.replace(/,/g, "") : text;
        }),
      ),
      ...(footer ? [footer.map((cell, k) => (isNumeric(columns[k]) ? cell.replace(/,/g, "") : cell))] : []),
    ]
      .map((line) => line.join("\t"))
      .join("\n");

  const copy = async () => {
    try {
      await writeClipboard(asTsv());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const note =
    state.phase === "loading"
      ? "Reading the lines behind this figure…"
      : state.phase === "error"
        ? "Could not be read"
        : `${rows.length.toLocaleString("en-IN")} line${rows.length === 1 ? "" : "s"} · ${prefix}`;

  return createPortal(
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={detail.title}
      onMouseDown={(event) => {
        if (!card.current?.contains(event.target as Node)) onClose();
      }}
    >
      <section className="modal-card" ref={card}>
        <div className="modal-head">
          <div>
            <h2 className="modal-title">{detail.title}</h2>
            <p className="modal-note">{note}</p>
          </div>
          <div className="filters" style={{ margin: 0 }}>
            {state.phase === "ready" && rows.length > 0 && (
              <button type="button" className="chip" onClick={copy}>
                {copied ? "Copied" : "Copy table"}
              </button>
            )}
            <button
              type="button"
              className="modal-close"
              ref={closer}
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        <div className="modal-body">
          {state.phase === "error" && <div className="notice warn">{state.message}</div>}

          {state.phase === "ready" && rows.length === 0 && (
            <div className="notice">
              Nothing stands behind this figure. That is what an empty pool looks like —
              the figure is a zero, or the lines it was built from carry no detail — not a
              breakup that failed to load.
            </div>
          )}

          {state.phase === "ready" && rows.length > 0 && (
            <div className="scroll-box">
              <table>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.field} className={isNumeric(c) ? "num" : undefined}>
                        <span className="th-inner">
                          <span className="th-label">{c.label}</span>
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      {columns.map((c) =>
                        c.kind === "remark" ? (
                          <td key={c.field}>
                            <RemarkCell
                              // Keyed by the invoice so opening a different breakup
                              // starts each field fresh rather than carrying a
                              // half-typed remark down onto another invoice's row.
                              key={invoiceOf(row)}
                              invoiceNo={invoiceOf(row)}
                              ancillary={ancillary}
                              initial={remarks.get(invoiceOf(row))?.remark ?? ""}
                              at={remarks.get(invoiceOf(row))?.at ?? ""}
                              onSaved={noteSaved}
                            />
                          </td>
                        ) : (
                          <td key={c.field} className={isNumeric(c) ? "num" : undefined}>
                            {detailCell(row, c)}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
                {footer && (
                  <tfoot>
                    <tr>
                      {columns.map((c, i) => (
                        <td key={c.field} className={isNumeric(c) ? "num" : undefined}>
                          {footer[i]}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          {state.phase === "loading" && <div className="notice">Reading the breakup…</div>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
