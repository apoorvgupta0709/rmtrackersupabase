"use client";

/**
 * Apply the recorded mappings now, instead of waiting for tomorrow's refresh.
 *
 * A mapping saves to the database the moment it is typed — that part is already
 * immediate. But the figures on every tab come from a published build, and a build is
 * computed once, from the dumps *and* the mappings as they stood when it ran. So "make
 * my answer effective" has exactly one honest meaning: rebuild. This button does that,
 * and then watches for the new build and reloads the page on it.
 *
 * Two decisions here are load-bearing:
 *
 *  - **It rebuilds under the current build's as-of, not today's.** The rebuild
 *    republishes the same dumps with new mappings; dating them today would age every
 *    figure computed from the as-of — days overdue, month-end ageing, which schedule
 *    sheet is read — and an unchanged stock extract re-stamped with a fresh date is the
 *    one failure the refresh pipeline exists to prevent. The daily refresh on the upload
 *    page still stamps today, because there the dumps really did just arrive.
 *  - **Completion is detected, not estimated.** The GitHub run takes two to three
 *    minutes and this page cannot see into it, so the button polls the current build id
 *    and reloads when it changes. If nothing has changed after ten minutes it says so
 *    rather than spinning forever — the run may have failed its QC gate, which is a
 *    result, not a hang.
 */

import { useEffect, useRef, useState } from "react";

export default function ApplyMappings({ asOf, buildId }: { asOf: string; buildId: string }) {
  const [state, setState] = useState<"idle" | "starting" | "waiting" | "done" | "failed">("idle");
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const apply = async () => {
    setState("starting");
    setMessage("Asking GitHub to rebuild…");
    try {
      const response = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ as_of: asOf }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setState("failed");
        setMessage(body.error ?? "The rebuild could not be started.");
        return;
      }
    } catch {
      setState("failed");
      setMessage("No answer from the server. The rebuild was not started.");
      return;
    }

    setState("waiting");
    setMessage(
      "Rebuilding with your mappings — takes two to three minutes. "
      + "This page reloads itself when the new build publishes.",
    );

    const startedAt = Date.now();
    timer.current = setInterval(async () => {
      if (Date.now() - startedAt > 10 * 60_000) {
        if (timer.current) clearInterval(timer.current);
        setState("failed");
        setMessage(
          "No new build after ten minutes. The run may have failed its quality gate — "
          + "in which case the previous build stays published on purpose. Check the "
          + "GitHub Actions log, or try again.",
        );
        return;
      }
      try {
        const response = await fetch("/api/refresh", { method: "GET" });
        if (!response.ok) return;
        const body = await response.json();
        if (body.build_id && body.build_id !== buildId) {
          if (timer.current) clearInterval(timer.current);
          setState("done");
          setMessage("Published. Reloading…");
          window.location.reload();
        }
      } catch {
        // A dropped poll is not a failure; the next tick asks again.
      }
    }, 15_000);
  };

  return (
    <div className="notice" style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
      <button
        type="button"
        className="chip"
        disabled={state === "starting" || state === "waiting"}
        onClick={apply}
      >
        {state === "waiting" ? "Rebuilding…" : "Apply mappings — rebuild now"}
      </button>
      <span className="hint">
        {message
          || `Answers save to the database the moment you type them. The figures on the tabs `
          + `come from the published build, so press this to rebuild it (as-of ${asOf}) — `
          + `or they land with tomorrow's refresh.`}
      </span>
    </div>
  );
}
