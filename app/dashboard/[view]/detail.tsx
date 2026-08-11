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

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabaseBrowser } from "@/lib/supabase/client";
import { writeClipboard } from "./clipboard";

/** A column of a breakup, as the pipeline declares it in `detail_columns`. */
export type DetailColumn = {
  label: string;
  field: string;
  kind?: "num" | "qty" | "mt" | "plant";
  /** Sum this column even though it is not the row's own quantity field. */
  add?: boolean;
};

export type DetailLayouts = Record<string, DetailColumn[]>;

/** What a figure opens: the key to fetch, and what to call the panel it opens into. */
export type Detail = { key: string; title: string };

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

function detailCell(row: Record<string, unknown>, column: DetailColumn): string {
  // The default layout puts the two together, because on a stock list neither answers
  // "where is this" on its own.
  if (column.field === "__source_plant") {
    return `${row.source ?? "—"} · ${displayPlant(row.plant)}`;
  }
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
  const card = useRef<HTMLDivElement>(null);
  const closer = useRef<HTMLButtonElement>(null);

  const prefix = detailPrefix(detail.key);
  const columns = layouts[prefix] ?? DEFAULT_DETAIL_COLUMNS;

  useEffect(() => {
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
  }, [buildId, detail.key, prefix]);

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

  const rows = state.phase === "ready" ? state.rows : [];

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
          const text = detailCell(row, c);
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
            <div className="scroll-x">
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
                      {columns.map((c) => (
                        <td key={c.field} className={isNumeric(c) ? "num" : undefined}>
                          {detailCell(row, c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {footer && (
                  <tfoot>
                    <tr>
                      {columns.map((c, i) => (
                        <td
                          key={c.field}
                          className={isNumeric(c) ? "num" : undefined}
                          style={{
                            borderTop: "1px solid var(--rule-strong)",
                            fontFamily: "var(--mono)",
                            fontWeight: 600,
                            background: "var(--paper)",
                            whiteSpace: "nowrap",
                          }}
                        >
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
