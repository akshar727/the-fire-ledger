// DP-018: a region's annual.json, fetched by id in the browser (no region's record is in a page bundle). Relative imports
// only, so `node --test` covers it (fetch-annual.test.ts).
import type { Annual } from "./annual.ts";

const cache = new Map<string, Promise<Annual | null>>();

/**
 * /data/<region>/annual.json, fetched once per region and page load. Never rejects: null when the file is missing,
 * unreadable or not an annual ledger. The SAME promise is returned on every call, including after a failure: React's
 * `use()` re-renders a suspended component from scratch on first mount, so a fresh promise per call would fetch in an
 * endless loop (R10). A failure therefore stays cached until the page reloads, which is what the error message asks for.
 */
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

/** Tests only: forget every cached load. */
export function clearAnnualCache() {
  cache.clear();
}
