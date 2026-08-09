"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { parseWorkbook, type ParsedGrid } from "@/lib/dumps/parse";
import { previouslySeen, uploadGrid } from "@/lib/dumps/upload";
import { SLOTS } from "@/lib/dumps/adapters";

type Row = {
  key: string;
  grid: ParsedGrid;
  state: "parsed" | "uploading" | "done" | "failed";
  written: number;
  seenBefore?: string;
  error?: string;
};

export default function UploadPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshState, setRefreshState] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const take = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setProblems([]);
    const supabase = supabaseBrowser();
    const next: Row[] = [];
    const found: string[] = [];

    for (const file of Array.from(files)) {
      const result = parseWorkbook(file.name, await file.arrayBuffer());
      found.push(...result.problems);
      for (const grid of result.grids) {
        const { digest } = { digest: await (await import("@/lib/dumps/parse")).digestOf(grid.rows) };
        const seen = await previouslySeen(supabase, grid.slot, digest);
        next.push({
          key: `${grid.slot}::${grid.sheet}`,
          grid,
          state: "parsed",
          written: 0,
          seenBefore: seen.seen ? seen.uploadedAt : undefined,
        });
      }
    }
    setProblems(found);
    // A second drop of the same slot replaces the first rather than queueing both.
    setRows((current) => {
      const merged = new Map(current.map((r) => [r.key, r]));
      next.forEach((r) => merged.set(r.key, r));
      return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
    });
  }, []);

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

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "clamp(24px, 4vw, 48px)" }}>
      <div className="rise" style={{ marginBottom: 24 }}>
        <Link href="/dashboard" className="label" style={{ textDecoration: "none" }}>
          ← Dashboard
        </Link>
        <h1 style={{ fontSize: 30, margin: "10px 0 8px", letterSpacing: "-0.03em" }}>
          Upload the day&apos;s dumps
        </h1>
        <p className="hint" style={{ maxWidth: "62ch" }}>
          Drop the workbooks as they were mailed. Each one is read in this browser, matched
          to the slot it fills, and written straight to the database — nothing is parsed on
          a server. A workbook holding several sheets fills several slots at once.
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
          Recognised: {Object.values(SLOTS).flatMap((s) => s.files).filter((f, i, a) => a.indexOf(f) === i).join(", ")}
        </div>
      </div>

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
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="figure">{row.grid.slot}</td>
                  <td>{row.grid.sheet}</td>
                  <td className="hint">{row.grid.sourceFile}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
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
        <button onClick={send} disabled={!ready || busy}>
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
    </main>
  );
}
