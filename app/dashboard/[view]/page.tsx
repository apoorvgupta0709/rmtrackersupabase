import Link from "next/link";
import { notFound } from "next/navigation";
import { currentBuildId, currentUser, supabaseServer } from "@/lib/supabase/server";
import DataTable, { type PricingContext } from "./table";
import ApplyMappings from "./apply";
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

/**
 * One drill-down's rows, whole.
 *
 * Paged for the same reason `fetchSection` is: PostgREST caps a response at a thousand
 * rows and says nothing about it, and a quarter of billing for a large customer is well
 * past that. A CN/DN claim built from the first thousand of seventeen hundred invoices
 * would look complete and be short by a third.
 */
async function fetchDetail(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  buildId: string,
  key: string,
): Promise<Rows> {
  const rows: Rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await supabase
      .from("detail_rows")
      .select("row")
      // The prefix explicitly: it leads the primary key and it is what the policy checks
      // a grant against. The build id likewise — an admin may read every build, so an
      // unfiltered query would merge them.
      .eq("build_id", buildId)
      .eq("prefix", key.split("|", 1)[0])
      .eq("detail_key", key)
      .order("seq")
      .range(from, from + PAGE - 1);
    const page = (data ?? []).map((d) => d.row as Record<string, unknown>);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/**
 * The query string with one parameter changed and the rest kept.
 *
 * The unit toggle used to rebuild the URL from `?unit=` alone, which was harmless only
 * because no view had both a unit switch and a selector. The trend tab now has both, and
 * switching Tonnes/Pieces would have silently cleared the customer.
 */
function withParam(
  query: Record<string, string | undefined>,
  key: string,
  value: string,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && k !== key) next.set(k, v);
  next.set(key, value);
  return next.toString();
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

  // Every selector's value, and which of them the tables are actually waiting on. A
  // selector declared `within` another is a narrower: unset means "all of them inside the
  // outer selection", where an unset outer selector means the tab has not been asked a
  // question yet and shows no narrowed table at all.
  const pickSpecs = spec.picks ?? [];
  const picks: Record<string, string> = Object.fromEntries(
    pickSpecs.map((p) => [p.param, query[p.param] ?? ""]),
  );
  const narrower = new Set(pickSpecs.filter((p) => p.within).map((p) => p.param));
  const awaiting = pickSpecs.filter((p) => !p.within && !picks[p.param]);
  const pick = pickSpecs.length ? picks[pickSpecs[0].param] : "";

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
    picks,
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

  // The masters, read live rather than out of the build — see `master` on `TableSpec`.
  // Each carries a "signed in reads the master" policy of its own, so this goes through the
  // reader's client like everything else and a viewer without the grant sees nothing.
  const MASTERS = {
    bucketting: {
      table: "dump_bucketing",
      select: "material_code,bucket,ctl_bucket,ll_or_ctl",
      order: "material_code",
    },
    oem_key: { table: "dump_oem_key", select: "customer,oem,cam", order: "customer" },
  } as const;

  const wantedMasters = [...new Set(tables.map((t) => t.master).filter(Boolean))] as
    (keyof typeof MASTERS)[];
  const masterRows: Record<string, Rows> = Object.fromEntries(
    await Promise.all(wantedMasters.map(async (name) => {
      const spec = MASTERS[name];
      // Through `unknown`: the generated client types a `select` string literal, and a
      // union of two of them is not one it can parse.
      const { data } = await supabase.from(spec.table).select(spec.select as string)
        .order(spec.order, { ascending: true });
      return [name, ((data ?? []) as unknown) as Rows];
    })),
  );

  function rowsFor(table: TableSpec): { rows: Rows; capped: boolean } {
    let rows: Rows = [];
    let capped = false;
    if (table.master) {
      rows = masterRows[table.master] ?? [];
    } else if (table.section) {
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
    for (const [param, field] of Object.entries(table.pickFields ?? {})) {
      const value = picks[param] ?? "";
      if (!value) {
        // An unanswered narrower means every value inside the outer selection; an
        // unanswered outer selector means the table has nothing to show yet.
        if (narrower.has(param)) continue;
        rows = [];
        break;
      }
      rows = rows.filter((row) => String(row[field] ?? "") === value);
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
      const waiting = awaiting.some((p) => table.pickFields?.[p.param]);
      if (waiting) return false;
      return !(table.hideWhenEmpty && rows.length === 0);
    });

  const facts = spec.facts ? spec.facts(scalars) : [];
  const anyRows = shown.some(({ rows }) => rows.length > 0);

  // What the bespoke copy formats need beyond the rows of the table they sit under: the
  // build's date, this tab's scalars, and the sections already fetched for it — the PCR
  // walks the code repository while pricing off the priced-SKU section beside it. Only
  // sections this tab already holds are passed, so no format costs an extra query.
  // Drill-down rows a copy format needs, fetched here because a format cannot fetch: the
  // clipboard is only writable inside the click that asked for it. Nothing is read until
  // a customer is picked, so a tab that is only being looked at costs no extra query.
  for (const { key, as } of spec.prefetchDetails?.(picks, scalars) ?? []) {
    sectionRows[as] = await fetchDetail(supabase, buildId, key);
  }

  const copyContext = {
    asOf: String(scalars.metadata?.as_of ?? ""),
    scalars,
    sections: sectionRows,
  };

  // Decisions the owner has already recorded. Not build-scoped and so not fetched with
  // the build: a material code's bucket has to survive the refresh that replaces every
  // row on this page, or the queue comes back tomorrow with the same rows in it.
  const assignable = tables.some((t) => t.columns.some((c) => c.assign));
  const assignments: Record<string, string> = {};
  let canAssign = false;
  if (assignable) {
    const [{ data: recorded }, me] = await Promise.all([
      supabase.from("bucket_assignments").select("scope,material_code,assigned_to"),
      currentUser(),
    ]);
    for (const row of recorded ?? []) {
      if (row.assigned_to) assignments[`${row.scope}|${row.material_code}`] = row.assigned_to;
    }
    canAssign = me?.role === "admin";
  }

  // Corrections to the contract price, and what they are computed against. Fetched only
  // where a column asks for them, and not build-scoped for the same reason an assignment
  // is not: a SKU's operations and a customer's PO price are facts about the SKU, and a
  // build is replaced wholesale every refresh.
  const editable = tables.some((t) => t.columns.some((c) => c.edit));
  let pricing: PricingContext | undefined;
  if (editable) {
    const [{ data: operationRows }, { data: priceRows }, me] = await Promise.all([
      supabase.from("sku_operations").select("customer,bucket,material_code,length_mm,operations"),
      supabase.from("customer_po_prices").select("customer,bucket,material_code,length_mm,quarter,price,unit"),
      currentUser(),
    ]);
    const operations: Record<string, string[]> = {};
    for (const row of operationRows ?? []) {
      operations[`${row.customer}|${row.bucket}|${row.material_code}|${Number(row.length_mm)}`] =
        (row.operations as string[]) ?? [];
    }
    const poPrices: Record<string, { price: number; unit: string }> = {};
    for (const row of priceRows ?? []) {
      if (row.price === null) continue;
      const key =
        `${row.customer}|${row.bucket}|${row.material_code}|${Number(row.length_mm)}|${row.quarter}`;
      poPrices[key] = { price: Number(row.price), unit: String(row.unit ?? "") };
    }
    pricing = {
      rates: (scalars.sku_pricing?.operation_rates_inr_per_ton as Record<string, number>) ?? {},
      quarters: (scalars.sku_pricing?.quarters as string[]) ?? [],
      operations,
      poPrices,
      canEdit: me?.role === "admin",
    };
  }

  // What each assignable column may be set to. `governed_buckets` is the build's own list
  // of what `Bucketting` governs, so a bucket added upstream is offered the next day
  // without a code change; the Megh keys come from the plan the same way.
  const assignOptions: Record<string, string[]> = {
    buckets: (scalars.governed_buckets as string[]) ?? [],
    megh_skus: [
      ...new Set(
        (sectionRows.megh_tracker ?? []).map((row) => String(row.sku ?? "")).filter(Boolean),
      ),
    ].sort(),
    // The OEMs the key already names, drawn from the master itself rather than declared:
    // a new one added upstream is offered the next time the page loads. There are about a
    // dozen, so this is a real list and not a formality — and a value outside it is still
    // saved, flagged "not in the master yet", which is how a genuinely new OEM gets in.
    oems: [
      ...new Set(
        (masterRows.oem_key ?? []).map((row) => String(row.oem ?? "").trim()).filter(Boolean),
      ),
    ].sort(),
  };

  // The options each selector offers, drawn from the section rather than declared, so a
  // customer that arrives in a build appears without a code change. A narrower offers only
  // what survives its outer selection — a ship-to list spanning every customer would be
  // the 26-name list the grouping exists to avoid.
  const collate = (a: string, b: string) =>
    a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
  const pickOptions: Record<string, string[]> = {};
  for (const p of pickSpecs) {
    const outer = p.within ? pickSpecs.find((q) => q.param === p.within) : undefined;
    const outerValue = outer ? picks[outer.param] : "";
    const source = (sectionRows[p.from.section] ?? []).filter(
      (row) => !outer || !outerValue || String(row[outer.from.field] ?? "") === outerValue,
    );
    pickOptions[p.param] = [
      ...new Set(source.map((row) => String(row[p.from.field] ?? "")).filter(Boolean)),
    ].sort(collate);
  }

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
              href={`/dashboard/${view}?${withParam(query, "unit", option)}`}
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

      {pickSpecs
        // A narrower has nothing to narrow until its outer selector is answered.
        .filter((p) => !p.within || picks[p.within])
        .map((p) => (
          <Picker
            key={p.param}
            param={p.param}
            label={p.label}
            options={pickOptions[p.param] ?? []}
            value={picks[p.param] ?? ""}
            view={view}
            optional={Boolean(p.within)}
            clears={pickSpecs.filter((q) => q.within === p.param).map((q) => q.param)}
            hint={
              p.within
                ? "Leave this on All to read every ship-to the customer buys under."
                : undefined
            }
          />
        ))}

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

      {/* Only where the answers are given, and only to who may give them. The as-of is
          the build's own, so the rebuild republishes these dumps under the date they
          arrived on rather than re-stamping them with today. */}
      {view === "mappingView" && canAssign && scalars.metadata?.as_of ? (
        <ApplyMappings asOf={String(scalars.metadata.as_of)} buildId={buildId} />
      ) : null}

      {!anyRows && awaiting.length === 0 && (
        <div className="notice" style={{ marginTop: 20, maxWidth: 720 }}>
          Nothing on this tab. Either no build is published yet, or this tab is not granted
          to your account — an ungranted tab returns no rows rather than hiding them.
        </div>
      )}

      {awaiting.map((p) => (
        <div key={p.param} className="notice" style={{ marginTop: 20, maxWidth: 720 }}>
          {p.prompt}
        </div>
      ))}

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
          assignments={assignments}
          assignOptions={assignOptions}
          canAssign={canAssign}
          unmapped={table.unmapped}
          source={table.master ?? table.section ?? (table.scalar ? table.scalar.join(".") : undefined)}
          pricing={pricing}
        />
      ))}
    </>
  );
}
