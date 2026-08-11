import Link from "next/link";
import { notFound } from "next/navigation";
import { currentBuildId, supabaseServer } from "@/lib/supabase/server";
import DataTable from "./table";
import Picker from "./pick";
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
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { view } = await params;
  const spec = VIEWS[view];
  if (!spec) notFound();

  const query = await searchParams;
  const unit: Unit = query.unit === "nos" ? "nos" : "mt";
  const pick = spec.pick ? (query[spec.pick.param] ?? "") : "";

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

  // `metadata` rides along on every tab: it carries the build's as-of date, which the
  // copy formats date their documents with. `detail_columns` rides along for the same
  // reason — every tab has figures that open a breakup, and it is the layout each one is
  // rendered with. Neither is admin-only, so any reader who can see the tab can see them.
  const { data: scalarRows } = await supabase
    .from("build_scalars")
    .select("key,value")
    .eq("build_id", buildId)
    .in("key", [...spec.scalars, "metadata", "detail_columns"]);
  const scalars: Record<string, any> = Object.fromEntries(
    (scalarRows ?? []).map((s) => [s.key, s.value]),
  );

  const tables = spec.tables({
    months: (scalars.sales_trend?.months as string[]) ?? [],
    quarters: (scalars.sku_pricing?.quarters as string[]) ?? [],
    unit,
    scalars,
    pick: pick || undefined,
  });

  // Two tables can be built from one section — the STR plan's buckets and the lines
  // nested inside them, the customer's tube lines and its CRFH book — so each section is
  // fetched once. A section a `flatten` reads across is named by the table that needs it,
  // so it is already here.
  const sections = [...new Set(tables.map((t) => t.section).filter(Boolean) as string[])];
  const fetched = Object.fromEntries(
    await Promise.all(
      sections.map(
        async (section) => [section, await fetchSection(supabase, buildId, section)] as const,
      ),
    ),
  );
  const sectionRows = Object.fromEntries(
    Object.entries(fetched).map(([section, held]) => [section, held.rows]),
  );

  function rowsFor(table: TableSpec): { rows: Rows; capped: boolean } {
    let rows: Rows = [];
    let capped = false;
    if (table.section) {
      rows = fetched[table.section].rows;
      capped = fetched[table.section].capped;
    } else if (table.scalar) {
      const [key, field] = table.scalar;
      const value = scalars[key]?.[field];
      rows = Array.isArray(value) ? (value as Rows) : [];
    }
    // Narrow before deriving, so a `flatten` that joins across sections sees only the
    // rows the reader asked for — the history's "on schedule" column is this customer's
    // schedule, not everybody's.
    if (table.pickField) {
      rows = pick ? rows.filter((row) => String(row[table.pickField!] ?? "") === pick) : [];
    }
    if (table.flatten) rows = table.flatten(rows, { sections: sectionRows, pick: pick || undefined });
    return { rows, capped };
  }

  // A table narrowed by the selector is not shown until a selection is made: the old page
  // asked for a customer first, and 396 lines across sixteen of them answers nobody's
  // question. Everything without a `pickField` — the list you choose from — stays up.
  const shown = tables
    .map((table) => ({ table, ...rowsFor(table) }))
    .filter(({ table, rows }) => {
      if (table.pickField && !pick) return false;
      return !(table.hideWhenEmpty && rows.length === 0);
    });

  const facts = spec.facts ? spec.facts(scalars) : [];
  const anyRows = shown.some(({ rows }) => rows.length > 0);

  // What the bespoke copy formats need beyond the rows of the table they sit under: the
  // build's date, this tab's scalars, and the sections already fetched for it — the PCR
  // walks the code repository while pricing off the priced-SKU section beside it. Only
  // sections this tab already holds are passed, so no format costs an extra query.
  const copyContext = {
    asOf: String(scalars.metadata?.as_of ?? ""),
    scalars,
    sections: sectionRows,
  };

  // The options the selector offers, drawn from the section rather than declared, so a
  // customer that arrives in a build appears without a code change.
  const pickOptions = spec.pick
    ? [
        ...new Set(
          (sectionRows[spec.pick.from.section] ?? [])
            .map((row) => String(row[spec.pick!.from.field] ?? ""))
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }))
    : [];

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

      {spec.pick && (
        <Picker
          param={spec.pick.param}
          label={spec.pick.label}
          options={pickOptions}
          value={pick}
          view={view}
        />
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

      {!anyRows && !(spec.pick && !pick) && (
        <div className="notice" style={{ marginTop: 20, maxWidth: 720 }}>
          Nothing on this tab. Either no build is published yet, or this tab is not granted
          to your account — an ungranted tab returns no rows rather than hiding them.
        </div>
      )}

      {spec.pick && !pick && (
        <div className="notice" style={{ marginTop: 20, maxWidth: 720 }}>
          {spec.pick.prompt}
        </div>
      )}

      {shown.map(({ table, rows, capped }) => (
        <DataTable
          key={table.key}
          title={table.title}
          note={table.note}
          columns={table.columns}
          rows={rows}
          averageOver={table.averageOver}
          capped={capped ? CAP : undefined}
          copies={table.copies}
          copyContext={copyContext}
          buildId={buildId}
          layouts={scalars.detail_columns ?? {}}
        />
      ))}
    </>
  );
}
