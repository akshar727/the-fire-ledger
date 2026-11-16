import { readFileSync } from "node:fs";
import path from "node:path";
import { spanOf, type Annual } from "@/lib/annual";
import { REGION_LIST, REGIONS, type RegionId } from "@/lib/data";

const cache = new Map<RegionId, Annual>();

export function readAnnual(region: RegionId): Annual {
  let a = cache.get(region);
  if (!a) {
    a = JSON.parse(readFileSync(path.join(process.cwd(), "public", "data", region, "annual.json"), "utf8")) as Annual;
    cache.set(region, a);
  }
  return a;
}

export function recordSpan() {
  const cells = REGION_LIST.filter((r) => r.tier === "region");
  return spanOf(cells.map((r) => readAnnual(r.id)), cells.map((r) => REGIONS[r.id]));
}
