"use client";

/**
 * The tab's one selector.
 *
 * It writes to the URL rather than to component state, for the same reason the unit
 * switch does: every table on the tab is server-rendered from it, so there is exactly
 * one answer to "which customer is this" and a link to the page carries it. Choosing
 * replaces the history entry instead of pushing one, so Back leaves the tab rather than
 * walking every customer looked at on the way here.
 */

import { useRouter, useSearchParams } from "next/navigation";

export default function Picker({
  param,
  label,
  options,
  value,
  view,
}: {
  param: string;
  label: string;
  options: string[];
  value: string;
  view: string;
}) {
  const router = useRouter();
  const search = useSearchParams();

  const choose = (next: string) => {
    const query = new URLSearchParams(search.toString());
    if (next) query.set(param, next);
    else query.delete(param);
    const rest = query.toString();
    router.replace(`/dashboard/${view}${rest ? `?${rest}` : ""}`);
  };

  return (
    <div
      className="rise"
      style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" }}
    >
      <span className="label">{label}</span>
      <select
        value={value}
        onChange={(event) => choose(event.target.value)}
        aria-label={label}
        className="picker"
      >
        <option value="">Select {label.toLowerCase()}…</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <span className="hint" style={{ fontSize: 12.5 }}>
        One selection drives every table on this tab, and the copy buttons read it too.
      </span>
    </div>
  );
}
