"use client";

/**
 * One decision, in a table cell.
 *
 * The mapping queues exist because a material code carrying no governed bucket reaches
 * no tracker: its tonnage is real and shows nowhere. Somebody has to say which bucket it
 * belongs to, and until now that somebody had to say it in a spreadsheet and send it on.
 *
 * Three things this control is careful about:
 *
 *  - **It saves against the material code, not against the build.** The next refresh
 *    replaces the build wholesale; the decision has to outlive it, or the queue comes
 *    back tomorrow with the same rows in it.
 *  - **It never pretends to have changed the figures.** The assignment applies at the
 *    next refresh, because a bucket decides which tracker the tonnage lands on and what
 *    coverage that bucket then shows. So a saved row says *saved · applies at the next
 *    refresh* rather than quietly implying the tab has moved.
 *  - **A refusal is reported, not swallowed.** Writing is the admin's alone and the
 *    database is what enforces it, so a viewer gets the policy's answer rather than a
 *    control that silently does nothing.
 */

import { useState } from "react";

type Saved = { value: string; at: "saved" | "pending" } | null;

export default function AssignCell({
  scope,
  code,
  options,
  initial,
  canAssign,
}: {
  scope: string;
  code: string;
  options: string[];
  initial: string;
  canAssign: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved">(
    initial ? "saved" : "idle",
  );
  const [error, setError] = useState("");

  if (!code) return <span className="hint">no code</span>;

  if (!canAssign) {
    return value
      ? <span className="assigned">{value}</span>
      : <span className="hint">unassigned</span>;
  }

  const save = async (next: string) => {
    const previous = value;
    setValue(next);
    setState("saving");
    setError("");
    try {
      const response = await fetch("/api/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, material_code: code, assigned_to: next || null }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        // Put the cell back to what the database still holds, so the screen never shows
        // a decision that was not recorded.
        setValue(previous);
        setState(previous ? "saved" : "idle");
        setError(body.error ?? "The assignment was not saved.");
        return;
      }
      setState(next ? "saved" : "idle");
    } catch {
      setValue(previous);
      setState(previous ? "saved" : "idle");
      setError("No answer from the server. The assignment was not saved.");
    }
  };

  return (
    <span className="assign">
      <select
        value={value}
        disabled={state === "saving"}
        onChange={(event) => save(event.target.value)}
        aria-label={`Assign ${code}`}
      >
        <option value="">— unassigned —</option>
        {/* A value already saved that is no longer offered still has to be shown, or the
            cell would silently read as unassigned. */}
        {(options.includes(value) || !value ? options : [value, ...options]).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {state === "saving" && <span className="hint">saving…</span>}
      {state === "saved" && !error && (
        <span className="hint" title="The pipeline reads assignments at the start of a run">
          saved · applies at the next refresh
        </span>
      )}
      {error && <span className="assign-error">{error}</span>}
    </span>
  );
}
