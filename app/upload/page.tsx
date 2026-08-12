import { redirect } from "next/navigation";

/**
 * Where uploading used to live.
 *
 * It is a tab now, inside the dashboard shell, so this only exists for the bookmarks and
 * the mails that still point here. A redirect rather than a copy: two upload pages that
 * can drift is exactly the arrangement this project has been bitten by elsewhere.
 */
export default function LegacyUploadPage() {
  redirect("/dashboard/upload");
}
