import type { Annual } from "./annual.ts";

const cache = new Map<string, Promise<Annual | null>>();

export function fetchAnnual(region: string): Promise<Annual | null> {
  let p = cache.get(region);
  if (!p) {
    p = fetch(`/data/${region}/annual.json`)
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((a) => (a && Array.isArray((a as Annual).years) ? (a as Annual) : null))
      .catch(() => null);
    cache.set(region, p);
  }
  return p;
}

export function clearAnnualCache() {
  cache.clear();
}
