import { redirect } from "next/navigation";
import { currentUser } from "@/lib/supabase/server";
import Uploader from "./uploader";

export const dynamic = "force-dynamic";

/**
 * The upload tab.
 *
 * It sits in the tab strip beside the eleven views and is deliberately not one of them:
 * there is no `dashboard_views` row for it, so it cannot be granted to a viewer by
 * mistake. Who may see it is a role, and the gate here is presentation — the database
 * refuses the write whatever the page renders.
 */
export default async function UploadTab() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin" && user.role !== "uploader") redirect("/dashboard");
  return <Uploader />;
}
