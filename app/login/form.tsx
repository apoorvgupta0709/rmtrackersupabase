"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = supabaseBrowser();

    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({ email, password });
      setBusy(false);
      if (error) return setError(error.message);
      // A new account is confirmed by email and starts with no grants at all, so there
      // is nothing to redirect to yet. Say so plainly rather than dropping someone on an
      // empty dashboard wondering what broke.
      return setSent(true);
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      // The old dashboard blamed the password whenever access.json failed to load, and
      // it was almost never the password. Say what is actually known.
      return setError(
        error.message.toLowerCase().includes("invalid")
          ? "That email and password do not match an account."
          : error.message,
      );
    }
    router.push(params.get("next") || "/dashboard");
    router.refresh();
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "1.15fr 1fr" }}>
      {/* Left: the sheet's title block. Says what this is and what it is built from. */}
      <section
        className="rise"
        style={{
          padding: "clamp(32px, 6vw, 88px)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          borderRight: "1px solid var(--rule)",
          background:
            "linear-gradient(160deg, var(--paper) 0%, var(--paper-deep) 100%)",
        }}
      >
        <div className="label">Tata Steel · Tubes · TVSM</div>

        <div>
          <h1
            style={{
              fontSize: "clamp(38px, 6vw, 72px)",
              lineHeight: 0.94,
              letterSpacing: "-0.035em",
              fontWeight: 700,
              maxWidth: "13ch",
            }}
          >
            Customer schedule &amp; long-length coverage
          </h1>
          <p className="hint" style={{ maxWidth: "46ch", marginTop: 22 }}>
            Built each day from the sales, stock, WIP, transfer and receivables extracts,
            against the approved RM tracker, ZMAT and contract masters.
          </p>
        </div>

        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0,1fr))",
            gap: 1,
            background: "var(--rule)",
            border: "1px solid var(--rule)",
            margin: 0,
          }}
        >
          {[
            ["Tabs", "11"],
            ["Dumps read", "15"],
            ["Masters", "3"],
          ].map(([term, value]) => (
            <div key={term} style={{ background: "var(--paper)", padding: "14px 16px" }}>
              <dt className="label">{term}</dt>
              <dd className="figure" style={{ margin: "4px 0 0", fontSize: 22 }}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Right: the form. */}
      <section
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "clamp(24px, 4vw, 56px)",
        }}
      >
        <div className="sheet rise" style={{ width: "100%", maxWidth: 380, padding: 32, animationDelay: "90ms" }}>
          <div className="label" style={{ marginBottom: 4 }}>
            {mode === "signin" ? "Sign in" : "Request access"}
          </div>
          <h2 style={{ fontSize: 24, marginBottom: 24, letterSpacing: "-0.02em" }}>
            {mode === "signin" ? "Operations dashboard" : "Create an account"}
          </h2>

          {sent ? (
            <div className="notice">
              Check <span className="figure">{email}</span> for a confirmation link. Once
              confirmed, an admin has to grant you tabs before anything appears — a new
              account can sign in but sees nothing by design.
            </div>
          ) : (
            <form onSubmit={submit}>
              <label className="field">
                <span className="label">Email</span>
                <input
                  type="email"
                  value={email}
                  autoComplete="email"
                  required
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="label">Password</span>
                <input
                  type="password"
                  value={password}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  required
                  minLength={8}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>

              {error && (
                <div className="notice bad" style={{ marginBottom: 16 }}>
                  {error}
                </div>
              )}

              <button type="submit" disabled={busy} style={{ width: "100%" }}>
                {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
              </button>
            </form>
          )}

          <div style={{ marginTop: 20, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
            <button
              className="ghost"
              style={{ width: "100%" }}
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                setSent(false);
              }}
            >
              {mode === "signin" ? "No account yet" : "I already have an account"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
