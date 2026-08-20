import { NextResponse } from "next/server";
import { currentUser, supabaseServer, currentBuildId } from "@/lib/supabase/server";

/**
 * Which build is current, for anyone watching a refresh land.
 *
 * The Apply-mappings button rebuilds and then wants to know when the new build has
 * published; the upload page has the same question. Both poll this rather than the
 * whole dashboard. The id goes through the caller's own client, so a signed-out poll
 * gets nothing rather than a build id.
 */
export async function GET() {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json({ build_id: await currentBuildId(supabase) });
}

/**
 * Ask GitHub to run the refresh.
 *
 * The work itself does not happen here. A refresh is pandas over a hundred thousand rows
 * and takes about three quarters of a minute, which is the wrong shape for a serverless
 * request — and it needs numpy, pandas and openpyxl, which is the wrong shape for a
 * Vercel bundle. So this fires a repository_dispatch and returns; the Action reads the
 * uploads, runs the pipeline and writes a build, and the page watches for it to appear.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user || (user.role !== "admin" && user.role !== "uploader")) {
    return NextResponse.json({ error: "Not permitted to refresh." }, { status: 403 });
  }

  // An optional as-of, for a rebuild that republishes the dumps already in. The daily
  // flow sends none and the run stamps today, because the dumps were just uploaded; the
  // Apply-mappings button sends the *current build's* as-of, because it is republishing
  // that build's dumps with new mappings and must not re-date them.
  let asOf: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body.as_of === "string") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.as_of)) {
        return NextResponse.json(
          { error: `as_of must be YYYY-MM-DD, not ${JSON.stringify(body.as_of)}.` },
          { status: 400 },
        );
      }
      asOf = body.as_of;
    }
  } catch {
    // No body at all is the daily flow.
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  // Vercel does not set GITHUB_REPOSITORY — that is a GitHub Actions variable, and
  // believing otherwise is what put a bare repository name in the deployment's settings.
  // What Vercel does set is the owner and the repository name, separately. Joining them
  // is right by construction, so fall back to it rather than to a typed-in guess.
  const { VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: slug } = process.env;
  const repo =
    process.env.GITHUB_REPOSITORY || (owner && slug ? `${owner}/${slug}` : undefined);
  // Name the one that is actually missing. Reporting both sends the reader to check a
  // variable that is already set, which is where the time goes.
  if (!token || !repo) {
    const missing = [
      !token && "GITHUB_DISPATCH_TOKEN",
      !repo && "GITHUB_REPOSITORY",
    ].filter(Boolean);
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

  // Both halves, or nothing. A bare repository name goes down the wire as
  // /repos/{name}/dispatches, which GitHub reads as the two-segment /repos/{owner}/{repo}
  // and answers with a 404 documented against *updating a repository* — a reply that
  // reads as a dead token or a missing scope, and sends the reader looking for the fault
  // everywhere except in the variable that caused it.
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return NextResponse.json(
      {
        error:
          `GITHUB_REPOSITORY is set to something that is not owner/repo, so GitHub has ` +
          `nothing to dispatch to. Set it to the full path — owner and repository, one ` +
          `slash between them — and redeploy. The uploads are already saved, so only the ` +
          `refresh needs re-running.`,
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
      client_payload: { requested_by: user.email, ...(asOf ? { as_of: asOf } : {}) },
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
