import type { NextConfig } from "next";

const config: NextConfig = {
  // Emit .next/standalone so the container carries a server and only the traced
  // node_modules — no build toolchain, no dev dependencies, no 64 MB of spreadsheets.
  // Vercel ignores this; it only shapes the self-hosted image.
  output: "standalone",

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
