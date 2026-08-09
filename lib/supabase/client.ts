"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * The browser's client, holding only the publishable key.
 *
 * That key is not a secret and never was the thing protecting anything — RLS is. It is
 * why the grants had to become policies: under access.json the browser held a payload
 * with every tab in it and the key to read it was "view source".
 */
export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
