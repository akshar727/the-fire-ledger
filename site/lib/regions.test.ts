// Run with `npm test`. Keeps the hand-written region list in lib/regions.ts in step with the pipeline's index.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIRE_SEASON, isRegionId, REGIONS } from "./regions.ts";

const index = JSON.parse(readFileSync(new URL("../public/data/index.json", import.meta.url), "utf8"));

test("REGIONS and FIRE_SEASON list the index.json regions, in order", () => {
  const ids = index.regions.map((r: { id: string }) => r.id);
  assert.deepEqual(Object.keys(REGIONS), ids);
  assert.deepEqual(Object.keys(FIRE_SEASON), ids);
});

test("isRegionId accepts only registered ids", () => {
  assert.ok(isRegionId("ghana"));
  for (const v of ["toString", "__proto__", "", "Ghana", null, 3]) assert.equal(isRegionId(v), false, String(v));
});

test("page copy has no en or em dashes", () => {
  for (const s of [...Object.values(REGIONS), ...Object.values(FIRE_SEASON)]) assert.doesNotMatch(s, /[–—]/);
});
