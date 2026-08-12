import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Recording why an invoice is late.
 *
 * The write goes through the **caller's** client, not the service role, so the policy
 * decides whether it lands. The cell is only reachable from a tab the reader was granted,
 * but a control that is merely not drawn is not access control — anyone can post to this
 * route. Someone with no grant on the overdue tab is refused by the database, and the
 * refusal is what the panel reports.
 *
 * A remark takes effect immediately, and this route is the whole of it. Unlike a bucket
 * assignment it is not an input to the next refresh: it annotates an invoice and moves no
 * figure, so nothing downstream has to be recomputed before it is true.
 */

export async function POST(request: Request) {
  let body: { invoice_no?: string; ancillary?: string; remark?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const invoice = String(body.invoice_no ?? "").trim();
  const ancillary = String(body.ancillary ?? "").trim();
  const remark = body.remark == null ? "" : String(body.remark).trim();

  if (!invoice) {
    return NextResponse.json({ error: "An invoice number is required." }, { status: 400 });
  }
  if (remark && !ancillary) {
    return NextResponse.json(
      { error: "The ancillary the invoice belongs to is required." },
      { status: 400 },
    );
  }

  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const at = new Date().toISOString();

  // Clearing is a delete rather than a row holding an empty string, so the invoice reads
  // as "nobody has said why" again rather than "somebody said nothing".
  const { error } = remark === ""
    ? await supabase.from("invoice_remarks").delete().eq("invoice_no", invoice)
    : await supabase.from("invoice_remarks").upsert(
        { invoice_no: invoice, ancillary, remark, remarked_by: auth.user.id, remarked_at: at },
        { onConflict: "invoice_no" },
      );

  if (error) {
    // A policy refusal comes back as an ordinary error, and reads as one to anyone
    // without the grant. Say which it is rather than showing a database string.
    const refused = error.code === "42501" || /row-level security/i.test(error.message);
    return NextResponse.json(
      {
        error: refused
          ? "Your account is not granted the overdue tab, so the remark was not saved."
          : `The remark was not saved: ${error.message}`,
      },
      { status: refused ? 403 : 500 },
    );
  }

  return NextResponse.json(
    remark === "" ? { remark: "" } : { remark, remarked_at: at },
  );
}
