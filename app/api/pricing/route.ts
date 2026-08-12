import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Correcting a SKU's operations, and recording what the customer's PO says.
 *
 * Both writes go through the **caller's** client and never the service role, so the
 * policy decides whether they land. The controls are only rendered for an admin, but a
 * control that is merely not drawn is not access control — anyone can post here. A
 * viewer's request is refused by the database and the refusal is what the cell reports.
 *
 * Unlike a bucket assignment, both of these apply **immediately**. The price is arithmetic
 * over numbers already on the row — the contract base per metre, the tube's kg/m, the
 * length — so the browser can redo it exactly, and nothing else on the dashboard is
 * derived from either. The next refresh recomputes from the same stored rows, so what the
 * page shows now and what the pipeline publishes tomorrow are the same figure.
 */

type Body = {
  kind?: string;
  customer?: string;
  bucket?: string;
  material_code?: string;
  length_mm?: number | string | null;
  /** `operations` only. Null is not a value here: clearing is `[]`, absent is a delete. */
  operations?: string[] | null;
  /** `po_price` only. */
  quarter?: string;
  price?: number | string | null;
  unit?: string;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const kind = String(body.kind ?? "");
  if (kind !== "operations" && kind !== "po_price") {
    return NextResponse.json({ error: `Unknown kind ${kind}.` }, { status: 400 });
  }

  const customer = String(body.customer ?? "").trim();
  // Part of the key, not decoration: one customer can schedule one material code at one
  // length under two different buckets, and they are two SKUs with different prices.
  const bucket = String(body.bucket ?? "").trim();
  // The empty string, not null: 38 of the 375 priced rows carry no material code, and a
  // null in a primary key would let the same SKU be recorded twice.
  const code = String(body.material_code ?? "").trim();
  const length = Number(body.length_mm);
  if (!customer || !bucket || !Number.isFinite(length)) {
    return NextResponse.json(
      { error: "A customer, a bucket and a length are required to identify the SKU." },
      { status: 400 },
    );
  }

  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const sku = { customer, bucket, material_code: code, length_mm: length };
  const stamp = { set_by: auth.user.id, set_at: new Date().toISOString() };

  let error;
  if (kind === "operations") {
    const operations = body.operations;
    if (operations === null || operations === undefined) {
      // Clearing the correction, not clearing the operations. The row goes, and the SKU
      // reads off the schedule's own flags again — "nobody has corrected this" rather
      // than "somebody decided it carries none", which `[]` means and is a real answer.
      ({ error } = await supabase
        .from("sku_operations")
        .delete()
        .eq("customer", customer)
        .eq("bucket", bucket)
        .eq("material_code", code)
        .eq("length_mm", length));
    } else {
      if (!Array.isArray(operations) || operations.some((op) => typeof op !== "string")) {
        return NextResponse.json({ error: "Operations must be a list of names." }, { status: 400 });
      }
      ({ error } = await supabase.from("sku_operations").upsert(
        { ...sku, ...stamp, operations: [...new Set(operations)].sort() },
        { onConflict: "customer,bucket,material_code,length_mm" },
      ));
    }
  } else {
    const quarter = String(body.quarter ?? "").trim();
    if (!quarter) {
      return NextResponse.json({ error: "A quarter is required." }, { status: 400 });
    }
    const raw = body.price;
    const price = raw === null || raw === undefined || String(raw).trim() === ""
      ? null
      : Number(raw);
    if (price !== null && !Number.isFinite(price)) {
      return NextResponse.json({ error: "That is not a price." }, { status: 400 });
    }
    if (price === null) {
      ({ error } = await supabase
        .from("customer_po_prices")
        .delete()
        .eq("customer", customer)
        .eq("bucket", bucket)
        .eq("material_code", code)
        .eq("length_mm", length)
        .eq("quarter", quarter));
    } else {
      ({ error } = await supabase.from("customer_po_prices").upsert(
        { ...sku, ...stamp, quarter, price, unit: String(body.unit ?? "") },
        { onConflict: "customer,bucket,material_code,length_mm,quarter" },
      ));
    }
  }

  if (error) {
    // A policy refusal comes back as an ordinary error, and reads as one to anyone who is
    // not an admin. Say which it is rather than showing a database string.
    const refused = error.code === "42501" || /row-level security/i.test(error.message);
    const what = kind === "operations" ? "a SKU's operations" : "a PO price";
    return NextResponse.json(
      {
        error: refused
          ? `Only the admin account can change ${what}. Nothing was saved.`
          : `Not saved: ${error.message}`,
      },
      { status: refused ? 403 : 500 },
    );
  }

  return NextResponse.json({ saved: true });
}
