import type { NextConfig } from "next";

const config: NextConfig = {
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
