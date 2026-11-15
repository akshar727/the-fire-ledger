// Run with `npm test`. DP-018: fetchAnnual returns one promise per region, never rejects, and never refetches a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearAnnualCache, fetchAnnual } from "./fetch-annual.ts";

function stub(respond: (url: string) => Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => {
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
  clearAnnualCache();
  return calls;
}

test("a record is fetched once per region and the same promise is returned", async () => {
  const calls = stub(async () => new Response(JSON.stringify({ years: [2001] }), { status: 200 }));
  const a = fetchAnnual("ghana"), b = fetchAnnual("ghana");
  assert.equal(a, b);
  assert.deepEqual(await a, { years: [2001] });
  assert.deepEqual(calls, ["/data/ghana/annual.json"]);
  fetchAnnual("portugal");
  assert.equal(calls.length, 2);
});

test("a 404 resolves null, stays cached, and is not fetched again", async () => {
  const calls = stub(async () => new Response("not found", { status: 404 }));
  const a = fetchAnnual("nowhere");
  assert.equal(await a, null);
  assert.equal(fetchAnnual("nowhere"), a);
  assert.equal(calls.length, 1);
});

test("a network error or a file that is not a record resolves null, never rejects", async () => {
  stub(async () => {
    throw new TypeError("offline");
  });
  assert.equal(await fetchAnnual("ghana"), null);
  stub(async () => new Response("{\"schema\":1}", { status: 200 }));
  assert.equal(await fetchAnnual("ghana"), null);
  stub(async () => new Response("not json", { status: 200 }));
  assert.equal(await fetchAnnual("ghana"), null);
});
