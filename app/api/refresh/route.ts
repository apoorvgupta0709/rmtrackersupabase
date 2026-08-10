import { NextResponse } from "next/server";
import { currentUser } from "@/lib/supabase/server";

/**
 * Ask GitHub to run the refresh.
 *
 * The work itself does not happen here. A refresh is pandas over a hundred thousand rows
 * and takes about three quarters of a minute, which is the wrong shape for a serverless
 * request — and it needs numpy, pandas and openpyxl, which is the wrong shape for a
 * Vercel bundle. So this fires a repository_dispatch and returns; the Action reads the
 * uploads, runs the pipeline and writes a build, and the page watches for it to appear.
 */
export async function POST() {
  const user = await currentUser();
  if (!user || (user.role !== "admin" && user.role !== "uploader")) {
    return NextResponse.json({ error: "Not permitted to refresh." }, { status: 403 });
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  // Name the one that is actually missing. Reporting both sends the reader to check a
  // variable that is already set, which is where the time goes.
  const missing = [
    !token && "GITHUB_DISPATCH_TOKEN",
    !repo && "GITHUB_REPOSITORY",
  ].filter(Boolean);
  if (missing.length) {
    return NextResponse.json(
      {
        error:
          `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set on this ` +
          `deployment. Add ${missing.length === 1 ? "it" : "them"} in Vercel project ` +
          `settings, then redeploy — the uploads are already saved, so only the refresh ` +
          `needs re-running.`,
      },
      { status: 501 },
    );
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: "refresh-dashboard",
      client_payload: { requested_by: user.email },
    }),
  });

  if (!response.ok) {
    return NextResponse.json(
      { error: `GitHub refused the dispatch: ${response.status} ${await response.text()}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, startedBy: user.email });
}
