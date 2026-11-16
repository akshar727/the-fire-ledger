import { test } from "node:test";
import assert from "node:assert/strict";
import { FEATURE_TILES, featureTiles, worldCounts } from "./features.ts";

const deep = (id: string) => ({ id, tier: "region", first_year: 2001 });
const country = (id: string, ship: string) => ({ id, tier: "country", ship, first_year: 2001 });

test("counts: countries with a record, model = model + caveat", () => {
  const index = {
    regions: [
      deep("portugal"),
      country("brazil", "caveat"),
      country("china", "model"),
      country("india", "ratio"),
      country("andorra", "sparse"),
      { id: "built-only", tier: "country", ship: "model" },
    ],
  };
  assert.deepEqual(worldCounts(index), { countries: 4, model: 2, deepDives: 1 });
  const tiles = featureTiles(index, "portugal");
  assert.equal(tiles[0].title, "Explore 4 countries on a 3D globe");
  assert.match(tiles[1].title, /it won in 2 of 4 countries$/);
  assert.equal(tiles.find((t) => t.tag === "From space")!.href, "/calendar?region=portugal");
});

test("with only the deep dives, the world tiles are left out", () => {
  const tiles = featureTiles({ regions: [deep("portugal"), deep("ghana")] }, "portugal");
  assert.deepEqual(
    tiles.map((t) => t.tag),
    ["Proof", "Calendar", "From space", "Drift"],
  );
});

test("the shipped tiles: real links, no dashes, numbers from the data", () => {
  assert.ok(FEATURE_TILES.length >= 4 && FEATURE_TILES.length <= 6);
  for (const t of FEATURE_TILES) {
    assert.match(t.href, /^\/(globe|method|calendar)(\?region=[a-z0-9-]+)?(#[a-z]+)?$/, t.href);
    for (const s of [t.tag, t.title, t.text]) assert.doesNotMatch(s, /[–—]/, s);
  }
});
