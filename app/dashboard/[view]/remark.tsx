"use client";

/**
 * Why this invoice is late, in a table cell.
 *
 * The overdue drill-down says what is owed and for how long. The reason it has not been
 * paid is the only part of the row that is judgement rather than arithmetic, and until now
 * it lived in somebody's head — so the same invoice got chased twice, and whoever chased
 * it the second time started from nothing.
 *
 * Three things this control is careful about, two of them shared with `AssignCell`:
 *
 *  - **It saves against the invoice number, not against the build.** The next refresh
 *    replaces the build wholesale and the drill-down rows carry no stable identity within
 *    one, so a remark written onto a row would be gone by morning.
 *  - **A refusal is reported, not swallowed.** The database is what holds the write to
 *    readers of the overdue tab, so a request from an ungranted account gets the policy's
 *    answer rather than a cell that silently does nothing.
 *  - **It applies now, not at the next refresh.** This is where it parts company with the
 *    mapping queue. A bucket assignment decides which tracker a code's tonnage lands on,
 *    so it cannot be true until the pipeline recomputes everything downstream of it; a
 *    remark feeds no figure on any tab. Saying "applies at the next refresh" here would be
 *    a caveat about nothing.
 */

import { useEffect, useRef, useState } from "react";

/** `2026-08-12T…` -> `12 Aug 2026`. */
const when = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

export default function RemarkCell({
  invoiceNo,
  ancillary,
  initial,
  at,
  onSaved,
}: {
  invoiceNo: string;
  ancillary: string;
  initial: string;
  at: string;
  onSaved: (invoiceNo: string, remark: string, at: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved">(
    initial ? "saved" : "idle",
  );
  const [error, setError] = useState("");
  // What the database is known to hold. The commit compares against this rather than
  // against the initial prop, so tabbing through a cell nobody edited writes nothing.
  const held = useRef(initial);

  // Another line of the same invoice was edited, or the panel re-read its remarks.
  useEffect(() => {
    if (initial !== held.current) {
      held.current = initial;
      setValue(initial);
      setState(initial ? "saved" : "idle");
    }
  }, [initial]);

  if (!invoiceNo) return <span className="hint">no invoice number</span>;

  const save = async () => {
    const next = value.trim();
    if (next === held.current) return;
    const previous = held.current;
    setState("saving");
    setError("");
    try {
      const response = await fetch("/api/remark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_no: invoiceNo, ancillary, remark: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Put the cell back to what the database still holds, so the screen never shows a
        // remark that was not recorded.
        setValue(previous);
        setState("idle");
        setError(body.error ?? "The remark was not saved.");
        return;
      }
      held.current = next;
      setValue(next);
      setState(next ? "saved" : "idle");
      onSaved(invoiceNo, next, String(body.remarked_at ?? ""));
    } catch {
      setValue(previous);
      setState("idle");
      setError("No answer from the server. The remark was not saved.");
    }
  };

  return (
    <span className="remark">
      <input
        type="text"
        value={value}
        disabled={state === "saving"}
        placeholder="why it is late"
        aria-label={`Remark against invoice ${invoiceNo}`}
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          // Escape closes the panel; inside a half-typed remark it should abandon the edit
          // instead, and go no further.
          if (event.key === "Escape") {
            event.stopPropagation();
            setValue(held.current);
            setError("");
          }
        }}
      />
      {state === "saving" && <span className="hint">saving…</span>}
      {state === "saved" && !error && (
        <span className="hint">{at ? `saved · ${when(at)}` : "saved"}</span>
      )}
      {error && <span className="assign-error">{error}</span>}
    </span>
  );
}
