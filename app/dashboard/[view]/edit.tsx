"use client";

/**
 * The two cells on the pricing tab that are written rather than read.
 *
 * Both differ from `AssignCell` in the same way, and it is the difference worth keeping
 * straight: a bucket assignment cannot show its effect, because a bucket decides which
 * tracker a code's tonnage lands on and every figure derived from it would go stale — so
 * that cell says *applies at the next refresh*. These two are arithmetic over numbers
 * already on the row, so the price beside them moves as soon as they are saved and saying
 * "applies at the next refresh" would be false. The refresh does re-derive them, from the
 * same stored rows, which is why the two never disagree.
 *
 * A refusal is reported, not swallowed: writing is the admin's alone and the database is
 * what enforces it, so a viewer gets the policy's answer rather than a control that
 * silently does nothing.
 */

import { useState } from "react";

type Body = Record<string, unknown>;

async function save(body: Body): Promise<string> {
  try {
    const response = await fetch("/api/pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return "";
    const failure = await response.json().catch(() => ({}));
    return failure.error ?? "Nothing was saved.";
  } catch {
    return "No answer from the server. Nothing was saved.";
  }
}

/* ---- Operations ----------------------------------------------------------- */

export function OperationsCell({
  sku,
  operations,
  offered,
  corrected,
  canEdit,
  onChange,
}: {
  /** Which SKU this is, as the price build-up names it. */
  sku: { customer: string; bucket: string; material_code: string; length_mm: number } | null;
  operations: string[];
  /** Every operation the contract prices, from the build's own rate table. */
  offered: string[];
  /** Whether what is shown is a correction or the schedule's own flags. */
  corrected: boolean;
  canEdit: boolean;
  onChange: (next: string[] | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const text = operations.length ? operations.join(", ") : "—";
  // A SKU with no length cannot be identified in the override table, and a control that
  // saves against the wrong row is worse than no control.
  if (!canEdit || !sku) return <span>{text}</span>;

  const commit = async (next: string[] | null) => {
    const previous = operations;
    setBusy(true);
    setError("");
    onChange(next);
    const failure = await save({ kind: "operations", ...sku, operations: next });
    setBusy(false);
    if (failure) {
      // Put the cell back to what the database still holds, so the price beside it never
      // shows a correction that was not recorded.
      onChange(corrected ? previous : null);
      setError(failure);
    }
  };

  const rest = offered.filter((op) => !operations.includes(op));

  return (
    <span className="ops">
      {operations.map((op) => (
        <span key={op} className="ops-chip">
          {op}
          <button
            type="button"
            disabled={busy}
            title={`Remove ${op}`}
            aria-label={`Remove ${op}`}
            onClick={() => commit(operations.filter((other) => other !== op))}
          >
            ×
          </button>
        </span>
      ))}
      {!operations.length && !adding && <span className="hint">no value adds</span>}

      {adding ? (
        <select
          autoFocus
          value=""
          disabled={busy}
          aria-label="Add an operation"
          onChange={(event) => {
            setAdding(false);
            if (event.target.value) commit([...operations, event.target.value].sort());
          }}
          onBlur={() => setAdding(false)}
        >
          <option value="">Add…</option>
          {rest.map((op) => (
            <option key={op} value={op}>{op}</option>
          ))}
        </select>
      ) : (
        rest.length > 0 && (
          <button
            type="button"
            className="ops-add"
            disabled={busy}
            title="Add an operation"
            onClick={() => setAdding(true)}
          >
            +
          </button>
        )
      )}

      {busy && <span className="hint">saving…</span>}
      {/* Clearing the correction is not the same as charging no operations: one restores
          the schedule's own flags, the other overrides them with an empty set. */}
      {corrected && !busy && (
        <button
          type="button"
          className="linkish"
          title="Go back to what the schedule flags say"
          onClick={() => commit(null)}
        >
          corrected · revert
        </button>
      )}
      {error && <span className="assign-error">{error}</span>}
    </span>
  );
}

/* ---- The customer's PO price ---------------------------------------------- */

export function PoPriceCell({
  sku,
  quarter,
  unit,
  price,
  canEdit,
  onChange,
}: {
  sku: { customer: string; bucket: string; material_code: string; length_mm: number } | null;
  quarter: string;
  unit: string;
  price: number | null;
  canEdit: boolean;
  onChange: (next: { price: number; unit: string } | null) => void;
}) {
  const [draft, setDraft] = useState(price === null ? "" : String(price));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!canEdit || !sku) {
    return <span>{price === null ? "—" : price.toFixed(2)}</span>;
  }

  const commit = async () => {
    const typed = draft.trim();
    const next = typed === "" ? null : Number(typed);
    if (next !== null && !Number.isFinite(next)) {
      setError("That is not a price.");
      setDraft(price === null ? "" : String(price));
      return;
    }
    if (next === price) return;
    setBusy(true);
    setError("");
    onChange(next === null ? null : { price: next, unit });
    const failure = await save({ kind: "po_price", ...sku, quarter, price: next, unit });
    setBusy(false);
    if (failure) {
      onChange(price === null ? null : { price, unit });
      setDraft(price === null ? "" : String(price));
      setError(failure);
    }
  };

  return (
    <span className="po-price">
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={busy}
        placeholder="—"
        aria-label={`${quarter} PO price`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(price === null ? "" : String(price));
            event.currentTarget.blur();
          }
        }}
      />
      {error && <span className="assign-error">{error}</span>}
    </span>
  );
}
