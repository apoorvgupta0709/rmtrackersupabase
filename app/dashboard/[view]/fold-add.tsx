"use client";

/**
 * A new fold rule, born on the tab.
 *
 * Every other master's rows arrive in a workbook; a fold rule exists nowhere until the
 * owner states it here, so this is the one place on the dashboard a *row* is created
 * rather than a cell answered. It posts to the same route as every assign cell and the
 * database's policy is what decides — the form not being drawn for a viewer is
 * presentation, not access control.
 *
 * Two things it is careful about, both inherited from the assign cell:
 *
 *  - **It never pretends the figures moved.** A fold re-keys every join a written size
 *    reaches, so it applies at the next refresh and the confirmation says so.
 *  - **A warning is not a refusal.** A written value that is itself governed would be
 *    *swallowed* by the fold — every real 2.5 wall would land on whatever it was folded
 *    onto — so the form warns loudly. But the owner may know better, so it warns and
 *    saves rather than blocking; the note field is where that judgement gets recorded.
 */

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

export default function FoldAdd({
  scope,
  options,
  canAssign,
}: {
  scope: "thickness_fold" | "od_fold";
  options: string[];
  canAssign: boolean;
}) {
  const [written, setWritten] = useState("");
  const [governed, setGoverned] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");
  const listId = useId();
  const router = useRouter();

  if (!canAssign) return null;

  const what = scope === "thickness_fold" ? "thickness" : "OD";
  const swallows =
    written.trim() !== "" &&
    options.includes(String(Number(written))) &&
    String(Number(written)) !== String(Number(governed));

  const save = async () => {
    const writtenValue = written.trim();
    const governedValue = governed.trim();
    if (!writtenValue || !governedValue) {
      setError(`Both the written and the governed ${what} are needed.`);
      return;
    }
    if (!Number.isFinite(Number(writtenValue)) || !Number.isFinite(Number(governedValue))) {
      setError(`A ${what} is a number.`);
      return;
    }
    setState("saving");
    setError("");
    try {
      const response = await fetch("/api/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          material_code: writtenValue,
          assigned_to: governedValue,
          note: note.trim() || null,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setState("idle");
        setError(body.error ?? "The fold was not saved.");
        return;
      }
      setWritten("");
      setGoverned("");
      setNote("");
      setState("saved");
      // The table above reads the master live on the server, so a refresh shows the row.
      router.refresh();
    } catch {
      setState("idle");
      setError("No answer from the server. The fold was not saved.");
    }
  };

  return (
    <div className="fold-add" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
      <span className="label">Add a fold</span>
      <input
        type="text"
        value={written}
        disabled={state === "saving"}
        spellCheck={false}
        autoComplete="off"
        placeholder={`written ${what}`}
        aria-label={`Written ${what}`}
        style={{ width: 130 }}
        onChange={(event) => setWritten(event.target.value)}
      />
      <span className="hint">folds onto</span>
      <input
        type="text"
        list={listId}
        value={governed}
        disabled={state === "saving"}
        spellCheck={false}
        autoComplete="off"
        placeholder={`governed ${what}`}
        aria-label={`Governed ${what}`}
        style={{ width: 130 }}
        onChange={(event) => setGoverned(event.target.value)}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      <input
        type="text"
        value={note}
        disabled={state === "saving"}
        spellCheck={false}
        autoComplete="off"
        placeholder="why — who writes it, what proved it"
        aria-label="Note"
        style={{ width: 280 }}
        onChange={(event) => setNote(event.target.value)}
      />
      <button type="button" disabled={state === "saving"} onClick={save}>
        {state === "saving" ? "saving…" : "Save fold"}
      </button>
      {swallows && !error && (
        <span
          className="assign-warn"
          title={`The governed buckets already carry a ${what} of ${String(Number(written))}. Folding it
 would send every real one somewhere else. Save only if you are sure, and say why in the note.`}
        >
          ⚠ {String(Number(written))} is itself governed — this fold would swallow it
        </span>
      )}
      {state === "saved" && !error && (
        <span className="hint">saved · press Apply mappings to rebuild</span>
      )}
      {error && <span className="assign-error">{error}</span>}
    </div>
  );
}
