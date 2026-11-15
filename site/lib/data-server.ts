// DP-018: build-time reads of per-region files for server components (/, /method, the site-wide copy in the layout and
// /record's header). A synchronous fs read while those static pages are prerendered, as lib/story-data.ts does, so no
// page bundles every region's record and the browser downloads none of them. These pages MUST stay static: on a
// dynamic route the read would run in a serverless function, where public/ is not traced. A missing file fails the
// build on purpose (index.json lists only regions with a record).
import { readFileSync } from "node:fs";
import path from "node:path";
import { spanOf, type Annual } from "@/lib/annual";
import { REGION_LIST, REGIONS, type RegionId } from "@/lib/data";

const cache = new Map<RegionId, Annual>();

/** A region's annual.json, read from site/public/data/<region>/annual.json at build time. */
export function readAnnual(region: RegionId): Annual {
  let a = cache.get(region);
  if (!a) {
    a = JSON.parse(readFileSync(path.join(process.cwd(), "public", "data", region, "annual.json"), "utf8")) as Annual;
    cache.set(region, a);
  }
  return a;
}

/** The whole published record across the cell regions, for site-wide copy (`spanOf` in lib/annual.ts). Whole countries
 * (DP-009) are left out: they are listed apart, and their archive-only record would shorten every page's year range. */
export function recordSpan() {
  const cells = REGION_LIST.filter((r) => r.tier === "region");
  return spanOf(cells.map((r) => readAnnual(r.id)), cells.map((r) => REGIONS[r.id]));
}
