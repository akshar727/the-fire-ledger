import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // FE-018: the record moved from / to /record and / became the story; later /record was renamed /ledger (Fire Ledger).
  // Old shared links (/?region=…, /?from=…, /?to=…, /record?…) still open the ledger; Next.js carries the query
  // string over unchanged.
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
    // Vercel restores .next/cache between builds. On 2026-11-15 a restored Turbopack cache from a pre-theme build
    // shipped stale Tailwind CSS (html{font-family:var(--font-geist-sans)}) next to the new Work Sans / Plex Mono
    // fonts, so production fell back to the browser default font. A cold compile is no slower here (~12 s either
    // way), so builds skip Turbopack's on-disk cache.
    // https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache
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
