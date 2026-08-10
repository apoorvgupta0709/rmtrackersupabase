import Link from "next/link";
import { notFound } from "next/navigation";
import { currentBuildId, supabaseServer } from "@/lib/supabase/server";
import DataTable from "./table";
import { VIEWS, type TableSpec, type Unit } from "./views";

export const dynamic = "force-dynamic";

/**
 * One tab.
 *
 * The page knows nothing about what any view means — `views.ts` declares the sections
 * and columns, and this fetches them. Reads go through the caller's own client, so a
 * view the reader has no grant for comes back empty from the database rather than being
 * hidden in the markup: the worst outcome of a wrong tab list is a page that renders
 * nothing, never one that shows someone else's prices.
 */

/** PostgREST caps a request at 1,000 rows, and two sections are already above that. */
const PAGE = 1000;
/** How much of a section one page will render. Truncation is always stated, never silent. */
const CAP = 3000;

type Rows = Record<string, unknown>[];

async function fetchSection(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  buildId: string,
  section: string,
): Promise<{ rows: Rows; capped: boolean }> {
  const query = () =>
    supabase
      .from("build_sections")
      .select("row")
      .eq("build_id", buildId)
      .eq("section", section)
      .order("seq");

  const rows: Rows = [];
  for (let from = 0; from < CAP; from += PAGE) {
    const { data } = await query().range(from, Math.min(from + PAGE, CAP) - 1);
    const page = (data ?? []).map((r) => r.row as Record<string, unknown>);
    rows.push(...page);
    if (page.length < PAGE) return { rows, capped: false };
  }
  // Exactly CAP rows came back, so ask for one more to find out whether there are more.
  const { data: more } = await query().range(CAP, CAP);
  return { rows, capped: (more ?? []).length > 0 };
}

export default async function ViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ view: string }>;
  searchParams: Promise<{ unit?: string }>;
}) {
  const { view } = await params;
  const spec = VIEWS[view];
  if (!spec) notFound();

  const { unit: unitParam } = await searchParams;
  const unit: Unit = unitParam === "nos" ? "nos" : "mt";

  const supabase = await supabaseServer();
  const buildId = await currentBuildId(supabase);

  if (!buildId) {
    return (
      <div className="sheet rise" style={{ padding: 24, maxWidth: 620 }}>
        <div className="label">{spec.label}</div>
        <p className="hint" style={{ marginTop: 8 }}>
          No build is published, so there is nothing to read. An empty dashboard is better
          than yesterday&apos;s numbers wearing today&apos;s date.
        </p>
      </div>
    );
  }

  const { data: scalarRows } = spec.scalars.length
    ? await supabase
        .from("build_scalars")
        .select("key,value")
        .eq("build_id", buildId)
        .in("key", spec.scalars)
    : { data: [] };
  const scalars: Record<string, any> = Object.fromEntries(
    (scalarRows ?? []).map((s) => [s.key, s.value]),
  );

  const tables = spec.tables({
    months: (scalars.sales_trend?.months as string[]) ?? [],
    quarters: (scalars.sku_pricing?.quarters as string[]) ?? [],
    unit,
    scalars,
  });

  // Two tables can be built from one section — the STR plan's buckets and the lines
  // nested inside them — so each section is fetched once.
  const sections = [...new Set(tables.map((t) => t.section).filter(Boolean) as string[])];
  const fetched = Object.fromEntries(
    await Promise.all(
      sections.map(
        async (section) => [section, await fetchSection(supabase, buildId, section)] as const,
      ),
    ),
  );

  function rowsFor(table: TableSpec): { rows: Rows; capped: boolean } {
    if (table.section) {
      const held = fetched[table.section];
      const rows = table.flatten ? table.flatten(held.rows) : held.rows;
      return { rows, capped: held.capped };
    }
    if (table.scalar) {
      const [key, field] = table.scalar;
      const value = scalars[key]?.[field];
      return { rows: Array.isArray(value) ? (value as Rows) : [], capped: false };
    }
    return { rows: [], capped: false };
  }

  const facts = spec.facts ? spec.facts(scalars) : [];
  const anyRows = tables.some((t) => rowsFor(t).rows.length > 0);

  return (
    <>
      <div className="rise" style={{ marginBottom: 4, maxWidth: 860 }}>
        <div className="label">{view}</div>
        <h1 style={{ fontSize: 26, margin: "4px 0 8px", letterSpacing: "-0.025em" }}>
          {spec.label}
        </h1>
        <p className="hint">{spec.note}</p>
      </div>

      {spec.unitToggle && (
        <div className="rise" style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
          <span className="label">Read in</span>
          {(["mt", "nos"] as Unit[]).map((option) => (
            <Link
              key={option}
              href={`/dashboard/${view}?unit=${option}`}
              className="label"
              style={{
                padding: "5px 10px",
                border: "1px solid",
                borderColor: unit === option ? "var(--furnace)" : "var(--rule-strong)",
                color: unit === option ? "var(--furnace)" : "var(--ink-soft)",
                textDecoration: "none",
              }}
            >
              {option === "mt" ? "Tonnes" : "Pieces"}
            </Link>
          ))}
          <span className="hint" style={{ fontSize: 12.5 }}>
            One switch drives every table on this tab — two that can disagree are worse
            than one.
          </span>
        </div>
      )}

      {facts.length > 0 && (
        <div
          className="rise"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: 10,
            marginTop: 16,
            animationDelay: "60ms",
          }}
        >
          {facts.map((fact) => (
            <div key={fact.label} className="sheet" style={{ padding: "12px 14px" }}>
              <div className="label">{fact.label}</div>
              <div className="figure" style={{ fontSize: 15, marginTop: 4 }}>
                {fact.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {!anyRows && (
        <div className="notice" style={{ marginTop: 20, maxWidth: 720 }}>
          Nothing on this tab. Either no build is published yet, or this tab is not granted
          to your account — an ungranted tab returns no rows rather than hiding them.
        </div>
      )}

      {tables.map((table) => {
        const { rows, capped } = rowsFor(table);
        return (
          <DataTable
            key={table.key}
            title={table.title}
            note={table.note}
            columns={table.columns}
            rows={rows}
            averageOver={table.averageOver}
            capped={capped ? CAP : undefined}
          />
        );
      })}
    </>
  );
}
