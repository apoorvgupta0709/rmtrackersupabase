import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

/**
 * The signed-in user's client, for anything rendered on the server.
 *
 * Reads go through this rather than through the service role, so a page cannot show a
 * tab the reader has no grant for even by accident: the policies decide, and a page that
 * asks for pricing without the grant gets an empty list rather than a leak.
 */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(URL, PUBLISHABLE, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only. Refreshing the
          // session is middleware's job; ignoring it here is the documented pattern.
        }
      },
    },
  });
}

/**
 * The service-role client. Bypasses every policy.
 *
 * Only two things need it: writing an upload into the raw tables, and the refresh
 * worker. Both run on the server. It must never be imported into a component that ships
 * to the browser — the key is deliberately not on a NEXT_PUBLIC_ name so that a mistake
 * of that kind fails to compile rather than shipping a master key to every viewer.
 */
export function supabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(URL, key, { auth: { persistSession: false } });
}

/** The caller's profile and grants, or null when not signed in. */
export async function currentUser() {
  const supabase = await supabaseServer();
  // getUser, never getSession: getSession trusts the cookie, getUser verifies it with
  // the auth server. On a page that decides who may see contract prices, that matters.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: profile }, { data: grants }] = await Promise.all([
    supabase.from("profiles").select("id, email, full_name, role").eq("id", user.id).single(),
    supabase.from("view_grants").select("view_key"),
  ]);

  return {
    id: user.id,
    email: user.email ?? profile?.email ?? "",
    fullName: profile?.full_name ?? null,
    role: (profile?.role ?? "viewer") as "admin" | "uploader" | "viewer",
    grants: (grants ?? []).map((g) => g.view_key as string),
  };
}
