import { currentUser, supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const CARDS: [string, string, string][] = [
  ["schedule_mt", "Schedule", "MT"],
  ["sales_mt", "Sales", "MT"],
  ["open_balance_mt", "Open balance", "MT"],
  ["tvsm_received_sales_mt", "To TVSM", "MT"],
  ["tsl_billed_sales_mt", "TSL billed", "MT"],
  ["critical_buckets", "Critical buckets", ""],
  ["low_buckets", "Low buckets", ""],
  ["active_schedule_rows", "Schedule lines", ""],
];

function format(value: unknown) {
  if (typeof value !== "number") return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  });
}

export default async function Overview() {
  const user = await currentUser();
  const supabase = await supabaseServer();

  const { data: scalars } = await supabase
    .from("build_scalars")
    .select("key,value")
    .in("key", ["summary", "metadata", "mapping_quality"]);

  const byKey = Object.fromEntries((scalars ?? []).map((s) => [s.key, s.value as Record<string, unknown>]));
  const summary = byKey.summary ?? {};
  const metadata = byKey.metadata ?? {};
  const warnings = (metadata.warnings as string[] | undefined) ?? [];

  if (!scalars || scalars.length === 0) {
    return (
      <div className="sheet rise" style={{ padding: 28, maxWidth: 620 }}>
        <div className="label">Nothing published</div>
        <h2 style={{ fontSize: 22, margin: "6px 0 12px" }}>No build to show yet</h2>
        <p className="hint">
          Upload the day&apos;s dumps and run a refresh. Until a build is published this
          page has nothing to read — which is deliberate: an empty dashboard is better
          than yesterday&apos;s numbers wearing today&apos;s date.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="label rise" style={{ marginBottom: 14 }}>
        Position · {String(metadata.as_of ?? "")} · signed in as {user?.email}
      </div>

      {/* Bordered cards rather than a one-pixel gap over a coloured backing: a partly
          filled last row would otherwise leave a block of rule colour sitting there
          looking like a card whose numbers failed to load. */}
      <div
        className="rise"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 12,
          animationDelay: "60ms",
        }}
      >
        {CARDS.map(([key, label, unit]) => (
          <div
            key={key}
            className="sheet"
            style={{ padding: "16px 18px" }}
          >
            <div className="label">{label}</div>
            <div className="figure" style={{ fontSize: 27, marginTop: 6, letterSpacing: "-0.035em" }}>
              {format(summary[key])}
              {unit && (
                <span className="label" style={{ marginLeft: 6, fontSize: 11 }}>
                  {unit}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <div className="rise" style={{ marginTop: 24, maxWidth: 780, animationDelay: "120ms" }}>
          <div className="label" style={{ marginBottom: 8 }}>
            Published with {warnings.length} warning{warnings.length === 1 ? "" : "s"}
          </div>
          {warnings.map((warning) => (
            <div className="notice warn" key={warning} style={{ marginBottom: 6 }}>
              {warning}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
