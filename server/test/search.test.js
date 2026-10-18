import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSerpApiResponse } from "../search/serpapi.js";
import { createFakeProvider } from "../search/fake.js";
import { SearchProviderError } from "../search/provider.js";

// Shaped like a real SerpAPI Google response: lots of fields we don't use.
const serpResponse = {
  search_metadata: { id: "abc", status: "Success", total_time_taken: 1.2 },
  search_parameters: { engine: "google", q: "minimum viable product" },
  related_questions: [{ question: "What is an MVP example?" }],
  knowledge_graph: { title: "Minimum viable product" },
  organic_results: [
    {
      position: 1,
      title: "Minimum viable product - Wikipedia",
      link: "https://en.wikipedia.org/wiki/Minimum_viable_product",
      snippet: "A minimum viable product (MVP) is a version of a product with just enough features\n  to be usable by early customers.",
      date: "Sep 3, 2026",
      sitelinks: { inline: [{ title: "History" }] },
    },
    { position: 2, title: "No link here", snippet: "missing url" },
    { position: 3, title: "  What is an MVP?  ", link: "https://www.example.com/mvp", snippet: "x".repeat(900) },
  ],
};

test("maps organic results to the normalized shape and drops unusable ones", () => {
  const results = mapSerpApiResponse(serpResponse);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    title: "Minimum viable product - Wikipedia",
    url: "https://en.wikipedia.org/wiki/Minimum_viable_product",
    snippet:
      "A minimum viable product (MVP) is a version of a product with just enough features to be usable by early customers.",
    position: 1,
    date: "Sep 3, 2026",
    provider: "serpapi",
  });
  assert.equal(results[1].title, "What is an MVP?");
  assert.ok(results[1].snippet.length <= 500, "snippets are capped");
});

test("normalized results are a small fraction of the raw payload", () => {
  const raw = JSON.stringify(serpResponse).length;
  const normalized = JSON.stringify(mapSerpApiResponse(serpResponse)).length;
  assert.ok(normalized < raw);
});

test("'no results' is an empty list, not a failure", () => {
  assert.deepEqual(mapSerpApiResponse({ error: "Google hasn't returned any results for this query." }), []);
  assert.deepEqual(mapSerpApiResponse({ search_metadata: {} }), []);
});

test("API errors and malformed responses throw SearchProviderError", () => {
  assert.throws(() => mapSerpApiResponse({ error: "Invalid API key." }), SearchProviderError);
  assert.throws(() => mapSerpApiResponse({ organic_results: "nope" }), SearchProviderError);
  assert.throws(() => mapSerpApiResponse(null), SearchProviderError);
});

test("fake provider supports ok, empty and error modes", async () => {
  assert.equal((await createFakeProvider({ latencyMs: 0 }).search("q", { num: 3 })).length, 3);
  assert.deepEqual(await createFakeProvider({ latencyMs: 0, mode: "empty" }).search("q"), []);
  await assert.rejects(createFakeProvider({ latencyMs: 0, mode: "error" }).search("q"), SearchProviderError);
});
