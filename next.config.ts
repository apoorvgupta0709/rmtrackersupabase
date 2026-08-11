import type { NextConfig } from "next";

const config: NextConfig = {
  // Emit .next/standalone so the container carries a server and only the traced
  // node_modules — no build toolchain and no dev dependencies.
  //
  // Only for the container. Vercel does *not* ignore this: standalone folds the file
  // trace into .next/standalone instead of writing .next/next-server.js.nft.json, and
  // Vercel's onBuildComplete hook opens that file by name and dies with ENOENT. Setting
  // it unconditionally compiles cleanly, passes typecheck, generates every page — and
  // then fails the deploy on the last line. So the Dockerfile opts in and nothing else
  // does; keep it that way, and keep the flag positive rather than testing for Vercel,
  // because the thing that needs standalone is the image, not the absence of a host.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,

  // The dashboard is behind a login and shows numbers that change on every refresh, so
  // nothing here should be cached at the edge. Correct-and-slightly-slower is the right
  // trade for a page whose whole job is to tell you today's position.
  headers: async () => [
    {
      source: "/:path*",
      headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
    },
  ],
};

export default config;
