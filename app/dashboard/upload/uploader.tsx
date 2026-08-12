"use client";

import { useCallback, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { parseWorkbook, type ParsedGrid } from "@/lib/dumps/parse";
import { previouslySeen, uploadGrid } from "@/lib/dumps/upload";
import { SLOTS } from "@/lib/dumps/adapters";
import { slotChoices } from "@/lib/dumps/recognise";
import { mapSheet, visibleName, type SheetMapping } from "@/lib/dumps/columns";

type Row = {
  key: string;
  grid: ParsedGrid;
  state: "parsed" | "uploading" | "done" | "failed";
  written: number;
  seenBefore?: string;
  error?: string;
  /** How this file reached its slot: by name, by its sheets, or by hand. */
  how: string;
  /** What the read will call this sheet's columns, and which declared ones are there. */
  mapping: SheetMapping;
};

/** A workbook nothing recognised, held so the reader can say what it is. */
type Unassigned = { file: File; sheetNames: string[] };


/**
 * What one sheet was read as: which declared columns were found, which were not, and
 * five rows of it.
 *
 * The point of showing it is that the failure this catches is otherwise invisible. A
 * dump whose headers have shifted parses cleanly, stores cleanly, and dies hours later
 * inside the refresh naming one column, by which time nobody is holding the file. Five
 * rows under the header is also the cheapest way to see that the *right* file went into
 * the slot — a sales extract in the transfer slot has happened, and it happened because a
 * filename fragment matched.
 */
function SheetPreview({ mapping }: { mapping: SheetMapping }) {
  const [open, setOpen] = useState(false);
  const found = mapping.matched.filter((m) => m.at !== null).length;

  if (mapping.positional) {
    return (
      <div className="hint" style={{ fontSize: 11.5 }}>
        read by column position, not by name
        <button type="button" className="linkish" style={{ marginLeft: 8 }}
                onClick={() => setOpen((o) => !o)}>
          {open ? "hide rows" : "5 rows"}
        </button>
        {open && <PreviewGrid mapping={mapping} keyName={null} />}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        {mapping.missing.length === 0 ? (
          <span className="stamp pass">{found} of {mapping.matched.length} columns mapped</span>
        ) : (
          <span className="stamp fail">{mapping.missing.length} column(s) missing</span>
        )}
        <span className="hint" style={{ fontSize: 11.5 }}>
          {mapping.columns.length} columns in the sheet
        </span>
        <button type="button" className="linkish" onClick={() => setOpen((o) => !o)}>
          {open ? "hide" : "show the mapping and 5 rows"}
        </button>
      </div>

      {mapping.missing.length > 0 && (
        <div className="notice bad" style={{ marginTop: 8, whiteSpace: "normal" }}>
          The pipeline reads {mapping.missing.map(visibleName).join(", ")} off this sheet
          and it does not carry {mapping.missing.length === 1 ? "it" : "them"}. Nothing is
          loaded until that is settled — a stored sheet the refresh cannot read fails hours
          later, when whoever has the workbook has gone.
        </div>
      )}

      {open && (
        <div style={{ marginTop: 10 }}>
          <div className="hint" style={{ fontSize: 11.5, marginBottom: 6 }}>
            {mapping.matched.map((m) => (
              <span key={m.name} style={{ marginRight: 10, whiteSpace: "nowrap" }}>
                <span style={{ color: m.at === null ? "var(--fail)" : "var(--ink-soft)" }}>
                  {m.at === null ? "\u2717" : "\u2713"} {visibleName(m.name)}
                </span>
              </span>
            ))}
          </div>
          <PreviewGrid mapping={mapping} keyName={mapping.keyAt === null ? null : mapping.columns[mapping.keyAt]} />
        </div>
      )}
    </div>
  );
}

/**
 * Five rows, with the key column first.
 *
 * The declared columns lead and the rest follow, because the reader is checking that the
 * right file reached the slot and the material code is what answers that. `visibleName`
 * marks the spaces that are load-bearing and invisible — `Chamferring ` really does end
 * in one, and a reader comparing this to their own sheet has to be able to see it.
 */
function PreviewGrid({ mapping, keyName }: { mapping: SheetMapping; keyName: string | null }) {
  const declared = mapping.matched.filter((m) => m.at !== null).map((m) => m.at as number);
  const lead = keyName === null ? declared : [
    ...new Set([mapping.columns.indexOf(keyName), ...declared].filter((i) => i >= 0)),
  ];
  const rest = mapping.columns.map((_, i) => i).filter((i) => !lead.includes(i));
  const order = [...lead, ...rest];

  return (
    <div className="sheet">
      <div className="scroll-box" style={{ maxHeight: 220 }}>
        <table>
          <thead>
            <tr>
              {order.map((i) => (
                <th key={i} style={{ color: lead.includes(i) ? "var(--furnace)" : undefined }}>
                  {visibleName(mapping.columns[i])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mapping.sample.map((row, r) => (
              <tr key={r}>
                {order.map((i) => (
                  <td key={i} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {row[i] === "" ? "\u2014" : row[i]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Uploader() {
  const [rows, setRows] = useState<Row[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [unassigned, setUnassigned] = useState<Unassigned[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshState, setRefreshState] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  /** Turn one parsed workbook into table rows, checking each against what came before. */
  const absorb = useCallback(async (file: File, assigned?: string[]) => {
    const result = parseWorkbook(file.name, await file.arrayBuffer(), assigned);
    const supabase = supabaseBrowser();
    const made: Row[] = [];
    for (const grid of result.grids) {
      const digest = await (await import("@/lib/dumps/parse")).digestOf(grid.rows);
      const seen = await previouslySeen(supabase, grid.slot, digest);
      made.push({
        key: `${grid.slot}::${grid.sheet}`,
        grid,
        state: "parsed",
        written: 0,
        seenBefore: seen.seen ? seen.uploadedAt : undefined,
        how: result.how,
        mapping: mapSheet(grid.slot, grid.rows),
      });
    }
    return { made, result };
  }, []);

  const merge = (next: Row[]) =>
    // A second drop of the same slot replaces the first rather than queueing both.
    setRows((current) => {
      const merged = new Map(current.map((r) => [r.key, r]));
      next.forEach((r) => merged.set(r.key, r));
      return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
    });

  const take = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      setProblems([]);
      const next: Row[] = [];
      const found: string[] = [];
      const waiting: Unassigned[] = [];

      for (const file of Array.from(files)) {
        const { made, result } = await absorb(file);
        found.push(...result.problems);
        next.push(...made);
        if (result.unassigned) {
          waiting.push({ file, sheetNames: result.unassigned.sheetNames });
        }
      }
      setProblems(found);
      setUnassigned((current) => [
        ...current.filter((u) => !waiting.some((w) => w.file.name === u.file.name)),
        ...waiting,
      ]);
      merge(next);
    },
    [absorb],
  );

  /** The reader has said what an unrecognised workbook is. */
  const assign = useCallback(
    async (entry: Unassigned, slot: string) => {
      if (!slot) return;
      const { made, result } = await absorb(entry.file, [slot]);
      if (result.problems.length || made.length === 0) {
        // Say why nothing happened rather than dropping the file off the list: an
        // assignment that reads no sheet is the reader picking the wrong slot, and a
        // workbook that quietly vanishes reads as one that loaded.
        setProblems(
          result.problems.length
            ? result.problems
            : [
                `${entry.file.name} has no sheet for slot ${slot} — it holds ` +
                  `${entry.sheetNames.join(", ") || "no sheets"}. Pick a different slot.`,
              ],
        );
        return;
      }
      setProblems([]);
      merge(made);
      setUnassigned((current) => current.filter((u) => u.file.name !== entry.file.name));
    },
    [absorb],
  );

  async function send() {
    setBusy(true);
    const supabase = supabaseBrowser();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setBusy(false);
      setProblems(["Session expired — sign in again."]);
      return;
    }

    for (const row of rows) {
      if (row.state === "done") continue;
      setRows((c) => c.map((r) => (r.key === row.key ? { ...r, state: "uploading", written: 0 } : r)));
      try {
        await uploadGrid(supabase, row.grid, user.id, (p) =>
          setRows((c) => c.map((r) => (r.key === row.key ? { ...r, written: p.rowsWritten } : r))),
        );
        setRows((c) =>
          c.map((r) => (r.key === row.key ? { ...r, state: "done", written: r.grid.rows.length } : r)),
        );
      } catch (error) {
        setRows((c) =>
          c.map((r) =>
            r.key === row.key
              ? { ...r, state: "failed", error: error instanceof Error ? error.message : String(error) }
              : r,
          ),
        );
      }
    }
    setBusy(false);
  }

  async function refresh() {
    setRefreshState("Asking GitHub to run the refresh…");
    const response = await fetch("/api/refresh", { method: "POST" });
    const body = await response.json();
    setRefreshState(
      response.ok
        ? "Refresh started. It takes about a minute; the dashboard updates when the build is published."
        : `Could not start: ${body.error}`,
    );
  }

  const ready = rows.length > 0 && rows.some((r) => r.state !== "done");
  const allDone = rows.length > 0 && rows.every((r) => r.state === "done");
  // A sheet the pipeline cannot read is not loaded. Storing it would put the refresh
  // hours away from a `KeyError` naming one column, with nobody left holding the file.
  const unreadable = rows.filter((r) => r.mapping.missing.length > 0);

  return (
    <>
      <div className="rise" style={{ marginBottom: 4, maxWidth: 860 }}>
        <div className="label">upload</div>
        <h1 style={{ fontSize: 26, margin: "4px 0 8px", letterSpacing: "-0.025em" }}>
          Upload the day&apos;s dumps
        </h1>
        <p className="hint">
          Drop the workbooks as they were mailed. Each one is read in this browser, matched
          to the slot it fills, checked against the columns the pipeline reads off it, and
          written straight to the database — nothing is parsed on a server. A workbook
          holding several sheets fills several slots at once.
        </p>
      </div>

      <div
        className="sheet rise"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          take(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        style={{
          padding: 40,
          textAlign: "center",
          cursor: "pointer",
          borderStyle: "dashed",
          animationDelay: "60ms",
        }}
      >
        <input
          ref={input}
          type="file"
          multiple
          accept=".xlsx,.xls,.XLSX"
          hidden
          onChange={(e) => take(e.target.files)}
        />
        <div className="label">Drop .xlsx files, or click to choose</div>
        <div className="hint" style={{ marginTop: 10 }}>
          Drop them named as they were mailed. A workbook is matched on its name, or on
          the sheets it holds when the name has been changed; anything left over is listed
          below to be assigned by hand rather than refused.
        </div>
        <div className="hint" style={{ marginTop: 8, opacity: 0.75 }}>
          Canonical names: {Object.values(SLOTS).flatMap((s) => s.files).filter((f, i, a) => a.indexOf(f) === i).join(", ")}
        </div>
      </div>

      {unassigned.length > 0 && (
        <div className="sheet rise" style={{ marginTop: 24, padding: 18 }}>
          <div className="label">Not recognised — say what these are</div>
          <p className="hint" style={{ margin: "8px 0 14px", maxWidth: "70ch" }}>
            Neither the filename nor the sheets identified these. Nothing is guessed: a
            dump put in the wrong slot is not caught further down. Pick the slot and it is
            read the same way a recognised file would be.
          </p>
          {unassigned.map((entry) => (
            <div
              key={entry.file.name}
              style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}
            >
              <div style={{ minWidth: 240 }}>
                <div className="figure" style={{ fontSize: 14 }}>{entry.file.name}</div>
                <div className="hint" style={{ fontSize: 12 }}>
                  sheets: {entry.sheetNames.join(", ") || "none"}
                </div>
              </div>
              <select
                defaultValue=""
                aria-label={`Slot for ${entry.file.name}`}
                style={{ width: "auto", minWidth: 320, padding: "8px 10px", fontSize: 13 }}
                onChange={(e) => assign(entry, e.target.value)}
              >
                <option value="">Choose the slot it fills…</option>
                {slotChoices().map((c) => (
                  <option key={c.slot} value={c.slot}>{c.describe}</option>
                ))}
              </select>
              <button
                className="ghost"
                onClick={() => setUnassigned((c) => c.filter((u) => u.file.name !== entry.file.name))}
              >
                Ignore
              </button>
            </div>
          ))}
        </div>
      )}

      {problems.length > 0 && (
        <div style={{ marginTop: 18 }}>
          {problems.map((p) => (
            <div className="notice bad" key={p} style={{ marginBottom: 6 }}>
              {p}
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="sheet rise" style={{ marginTop: 24 }}>
          <table>
            <thead>
              <tr>
                <th>Slot</th>
                <th>Sheet</th>
                <th>From</th>
                <th className="num">Rows</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => [
                <tr key={row.key}>
                  <td className="figure">{row.grid.slot}</td>
                  <td>{row.grid.sheet}</td>
                  <td className="hint">
                    {row.grid.sourceFile}
                    {row.how !== "filename" && (
                      <div style={{ fontSize: 11, color: "var(--warn)" }}>
                        matched {row.how === "sheets" ? "on its sheets" : "by hand"}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {row.state === "uploading"
                      ? `${row.written.toLocaleString()} / ${row.grid.rows.length.toLocaleString()}`
                      : row.grid.rows.length.toLocaleString()}
                  </td>
                  <td>
                    {row.state === "done" && <span className="stamp pass">loaded</span>}
                    {row.state === "uploading" && <span className="stamp warn">writing</span>}
                    {row.state === "failed" && <span className="stamp fail">failed</span>}
                    {row.state === "parsed" && row.seenBefore && (
                      <span className="label" style={{ color: "var(--warn)" }}>
                        identical to an earlier upload
                      </span>
                    )}
                    {row.state === "parsed" && !row.seenBefore && (
                      <span className="label">ready</span>
                    )}
                    {row.error && <div className="hint" style={{ color: "var(--fail)" }}>{row.error}</div>}
                  </td>
                </tr>,
                // The mapping gets a row of its own rather than a sixth column: it is a
                // paragraph and a grid, and squeezing it beside the state would make both
                // unreadable.
                <tr key={`${row.key}::mapping`}>
                  <td colSpan={5} style={{ paddingTop: 0, whiteSpace: "normal" }}>
                    <SheetPreview mapping={row.mapping} />
                  </td>
                </tr>,
              ])}
            </tbody>
          </table>
        </div>
      )}

      {unreadable.length > 0 && (
        <div className="notice bad" style={{ marginTop: 16 }}>
          {unreadable.length} sheet(s) are missing a column the pipeline reads, so nothing
          is loaded. Either the extract changed shape — in which case the registry in
          <span className="figure"> scripts/sources.py</span> is what needs updating — or
          the wrong workbook reached the slot.
        </div>
      )}

      {rows.some((r) => r.seenBefore) && (
        <div className="notice warn" style={{ marginTop: 16 }}>
          One or more of these is byte-for-byte identical to a previous upload, which
          usually means an extract was re-sent unchanged. Comparing content and not size
          is the point: on 7 August rfd_4731.xlsx arrived at exactly the previous
          day&apos;s size with different content. Load it anyway if you know it is new.
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" }}>
        <button onClick={send} disabled={!ready || busy || unreadable.length > 0}>
          {busy ? "Writing…" : `Load ${rows.filter((r) => r.state !== "done").length} sheet(s)`}
        </button>
        <button className="ghost" onClick={refresh} disabled={!allDone}>
          Run refresh
        </button>
      </div>

      {refreshState && (
        <div className="notice" style={{ marginTop: 16 }}>
          {refreshState}
        </div>
      )}
    </>
  );
}
