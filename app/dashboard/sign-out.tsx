"use client";

import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function SignOut() {
  const router = useRouter();
  return (
    <button
      className="ghost"
      style={{ padding: "5px 10px", fontSize: 10 }}
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
