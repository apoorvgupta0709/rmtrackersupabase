"use client";

/**
 * One decision, in a table cell.
 *
 * The mapping queues exist because a material code carrying no governed bucket reaches
 * no tracker: its tonnage is real and shows nowhere. Somebody has to say which bucket it
 * belongs to, and until now that somebody had to say it in a spreadsheet and send it on.
 *
 * Four things this control is careful about:
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
 *  - **It is a text field, and it takes an answer the master does not carry yet.** This
 *    was a `<select>` of governed buckets, which had the queue backwards: the row is here
 *    *because* nothing governs it, so the bucket that belongs on it is routinely one
 *    `Bucketting` has never held. The governed list is still offered as suggestions, and
 *    a value outside it is saved and flagged rather than refused — the flag is the
 *    reminder that the master needs the same addition, not a rejection of the answer.
 */

import { useEffect, useId, useState } from "react";

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
  /** What the database holds. */
  const [value, setValue] = useState(initial);
  /** What is in the box, which differs from `value` only while it is being typed in. */
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved">(
    initial ? "saved" : "idle",
  );
  const [error, setError] = useState("");
  const listId = useId();

  // The build under the table is replaced on every refresh and the rows are re-keyed, so
  // a cell can be handed a different row's decision without unmounting.
  useEffect(() => {
    setValue(initial);
    setDraft(initial);
    setState(initial ? "saved" : "idle");
    setError("");
  }, [initial]);

  if (!code) return <span className="hint">no code</span>;

  if (!canAssign) {
    return value
      ? <span className="assigned">{value}</span>
      : <span className="hint">unassigned</span>;
  }

  const save = async (next: string) => {
    const trimmed = next.trim();
    // Typing into the box and leaving it as it was found is not a decision to record.
    if (trimmed === value) {
      setDraft(trimmed);
      return;
    }
    const previous = value;
    setValue(trimmed);
    setDraft(trimmed);
    setState("saving");
    setError("");
    try {
      const response = await fetch("/api/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, material_code: code, assigned_to: trimmed || null }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        // Put the cell back to what the database still holds, so the screen never shows
        // a decision that was not recorded.
        setValue(previous);
        setDraft(previous);
        setState(previous ? "saved" : "idle");
        setError(body.error ?? "The assignment was not saved.");
        return;
      }
      setState(trimmed ? "saved" : "idle");
    } catch {
      setValue(previous);
      setDraft(previous);
      setState(previous ? "saved" : "idle");
      setError("No answer from the server. The assignment was not saved.");
    }
  };

  // Only judgeable where there is a list to judge against. The RFD queue assigns a CTL
  // bucket, for which the build publishes no list, and warning on every value there would
  // train the reader to ignore the warning that matters.
  const ungoverned =
    state === "saved" && Boolean(value) && options.length > 0 && !options.includes(value);

  return (
    <span className="assign">
      <input
        type="text"
        list={listId}
        value={draft}
        disabled={state === "saving"}
        spellCheck={false}
        autoComplete="off"
        placeholder="unassigned"
        aria-label={`Assign ${code}`}
        onChange={(event) => setDraft(event.target.value)}
        // On blur and on Enter, not on every keystroke: a save per character would post
        // thirty times for one bucket and leave the last few racing each other.
        onBlur={(event) => save(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      {state === "saving" && <span className="hint">saving…</span>}
      {state === "saved" && !error && (
        <span className="hint" title="The pipeline reads assignments at the start of a run">
          saved · applies at the next refresh
        </span>
      )}
      {ungoverned && !error && (
        <span
          className="assign-warn"
          title="Saved. The pipeline will use it, and the master needs the same addition."
        >
          ⚠ not in the master yet
        </span>
      )}
      {error && <span className="assign-error">{error}</span>}
    </span>
  );
}
