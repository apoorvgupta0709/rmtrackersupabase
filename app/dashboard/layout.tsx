import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, supabaseServer } from "@/lib/supabase/server";
import SignOut from "./sign-out";

export const dynamic = "force-dynamic";

/**
 * The shell: who you are, which build you are looking at, and the tabs you may open.
 *
 * The tab list comes from the grants, but note that hiding a tab is no longer what
 * protects anything — the policies do. If this list were wrong, the worst outcome is a
 * link to a page that renders empty, not a page that shows someone else's prices.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const supabase = await supabaseServer();
  const [{ data: views }, { data: builds }] = await Promise.all([
    supabase.from("dashboard_views").select("key,label,sort_order").order("sort_order"),
    supabase
      .from("dashboard_builds")
      .select("as_of,status,published_at,warnings")
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .limit(1),
  ]);

  const build = builds?.[0];
  const visible = (views ?? []).filter(
    (v) => user.role === "admin" || user.grants.includes(v.key),
  );
  const canUpload = user.role === "admin" || user.role === "uploader";

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ borderBottom: "1px solid var(--rule)", background: "var(--surface)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 20,
            padding: "14px clamp(16px, 3vw, 32px)",
            flexWrap: "wrap",
          }}
        >
          <Link
            href="/dashboard"
            style={{
              fontWeight: 700,
              fontSize: 17,
              letterSpacing: "-0.02em",
              color: "var(--ink)",
              textDecoration: "none",
            }}
          >
            TVSM operations
          </Link>

          {build ? (
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className={`stamp ${build.status.toLowerCase()}`}>{build.status}</span>
              <span className="label">
                as of <span className="figure">{build.as_of}</span>
              </span>
            </span>
          ) : (
            <span className="label">no build published yet</span>
          )}

          <span style={{ flex: 1 }} />
          <span className="label">{user.email}</span>
          {canUpload && (
            <Link href="/upload" className="label" style={{ color: "var(--furnace)" }}>
              Upload dumps
            </Link>
          )}
          <SignOut />
        </div>

        <nav
          className="scroll-x"
          style={{ display: "flex", gap: 0, padding: "0 clamp(16px, 3vw, 32px)" }}
        >
          {visible.map((view) => (
            <Link
              key={view.key}
              href={`/dashboard/${view.key}`}
              className="label"
              style={{
                padding: "10px 14px 12px",
                color: "var(--ink-soft)",
                textDecoration: "none",
                borderBottom: "2px solid transparent",
                whiteSpace: "nowrap",
              }}
            >
              {view.label}
            </Link>
          ))}
        </nav>
      </header>

      <main style={{ flex: 1, padding: "clamp(20px, 3vw, 36px)" }}>{children}</main>

      <footer
        className="label"
        style={{
          borderTop: "1px solid var(--rule)",
          padding: "12px clamp(16px, 3vw, 32px)",
          display: "flex",
          gap: 18,
          flexWrap: "wrap",
        }}
      >
        <span>
          {visible.length} of {(views ?? []).length} tabs granted
        </span>
        {build?.warnings && Array.isArray(build.warnings) && build.warnings.length > 0 && (
          <span style={{ color: "var(--warn)" }}>
            {build.warnings.length} warning{build.warnings.length === 1 ? "" : "s"} on this build
          </span>
        )}
      </footer>
    </div>
  );
}
