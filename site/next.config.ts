import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  async redirects() {
    return [
      ...["region", "from", "to"].map((key) => ({
        source: "/",
        has: [{ type: "query" as const, key }],
        destination: "/ledger",
        permanent: false,
      })),
      { source: "/record", destination: "/ledger", permanent: true },
    ];
  },
  experimental: {
    turbopackFileSystemCacheForBuild: false,
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
