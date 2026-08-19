import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Assigning a material code to a bucket.
 *
 * The write goes through the **caller's** client, not the service role, so the policy
 * decides whether it lands. That matters more than it looks: the control is only
 * rendered for an admin, but a control that is merely not drawn is not access control —
 * anyone can post to this route. A viewer's request is refused by the database, and the
 * refusal is what the page reports.
 *
 * An assignment takes effect at the next refresh. This route deliberately does not touch
 * the published build: a bucket decides which tracker a code's tonnage lands on, what
 * coverage that bucket then shows and what the STR plan does about it, so editing one
 * cell would leave every figure derived from it stale with nothing to say so.
 */

// Four spaces, and the database holds the same list in a check constraint. Both have to
// agree: this one is what returns a readable 400, that one is what stops a decision being
// filed where nothing reads it.
//
// A scope belongs here only once the pipeline reads it. `oem` was admitted on 17 August
// before it did, and had to be withdrawn: the write succeeded, the cell said saved, and
// not one figure moved. Adding the fifth means finding the place the pipeline builds that
// map first, not this line.
const SCOPES = new Set(["bucket", "megh_sku", "ctl_bucket", "oem"]);

export async function POST(request: Request) {
  let body: { scope?: string; material_code?: string; assigned_to?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const scope = String(body.scope ?? "");
  const code = String(body.material_code ?? "").trim();
  const value = body.assigned_to == null ? null : String(body.assigned_to).trim() || null;

  if (!SCOPES.has(scope)) {
    return NextResponse.json({ error: `Unknown scope ${scope}.` }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ error: "A material code is required." }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  // Clearing is a delete rather than a row holding null, so the queue reads as "nobody
  // has decided this yet" again rather than "somebody decided nothing".
  const { error } = value === null
    ? await supabase.from("bucket_assignments").delete().eq("scope", scope).eq("material_code", code)
    : await supabase.from("bucket_assignments").upsert(
        { scope, material_code: code, assigned_to: value, assigned_by: auth.user.id,
          assigned_at: new Date().toISOString() },
        { onConflict: "scope,material_code" },
      );

  if (error) {
    // A policy refusal comes back as an ordinary error, and reads as one to anyone who
    // is not an admin. Say which it is rather than showing a database string.
    const refused = error.code === "42501" || /row-level security/i.test(error.message);
    return NextResponse.json(
      {
        error: refused
          ? "Only the admin account can assign a bucket. The decision was not saved."
          : `The assignment was not saved: ${error.message}`,
      },
      { status: refused ? 403 : 500 },
    );
  }

  return NextResponse.json({ assigned_to: value });
}
