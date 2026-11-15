import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // FE-018: the record moved from / to /record and / became the story. Old shared links (/?region=…, /?from=…,
  // /?to=…) still open the record; Next.js carries the query string over unchanged.
  async redirects() {
    return ["region", "from", "to"].map((key) => ({
      source: "/",
      has: [{ type: "query" as const, key }],
      destination: "/record",
      permanent: false,
    }));
  },
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
