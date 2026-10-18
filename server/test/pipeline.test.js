// prepareContext with substituted retrieval and search: mode handling and the
// hybrid fallback when web search fails, times out, or comes back empty.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareContext, WebSearchUnavailableError } from "../pipeline/answer.js";

const docs = [{ text: "An MVP tests a hypothesis with minimal effort.", page: 3 }];
const results = [
  { title: "MVP", url: "https://example.com/mvp", snippet: "Minimum viable product.", date: null, provider: "fake" },
];

const retrieve = async (q, id, meta) => {
  meta.embed_ms = 1;
  meta.chroma_ms = 1;
  return docs;
};
const okSearch = async () => results;
const failingSearch = async () => {
  throw new Error("upstream 503");
};
const hangingSearch = () => new Promise(() => {});
const noRetrieve = async () => assert.fail("retrieval must not run in web mode");
const noSearch = async () => assert.fail("search must not run in docs mode");

const q = { question: "What is an MVP?", documentId: "doc-1" };

test("hybrid uses both source types in one context", async () => {
  const { context, meta } = await prepareContext({ ...q, mode: "hybrid" }, { retrieve, search: okSearch });
  assert.deepEqual(context.sources.map((s) => s.id), ["D1", "W1"]);
  assert.equal(meta.web.status, "ok");
  assert.deepEqual(meta.sources, { documents: 1, web: 1 });
});

test("docs mode never calls search; web mode never touches documents", async () => {
  const d = await prepareContext({ ...q, mode: "docs" }, { retrieve, search: noSearch });
  assert.equal(d.meta.web, null);
  const w = await prepareContext({ ...q, documentId: null, mode: "web" }, { retrieve: noRetrieve, search: okSearch });
  assert.equal(w.meta.retrieval, null);
  assert.deepEqual(w.context.sources.map((s) => s.id), ["W1"]);
});

test("hybrid falls back to documents when search fails", async () => {
  const { context, meta } = await prepareContext({ ...q, mode: "hybrid" }, { retrieve, search: failingSearch });
  assert.deepEqual(context.sources.map((s) => s.id), ["D1"]);
  assert.equal(meta.web.status, "error");
  assert.match(meta.web.error, /upstream 503/);
});

test("hybrid falls back to documents when search exceeds its time budget", async () => {
  process.env.SEARCH_TIMEOUT_MS = "50";
  try {
    const t = Date.now();
    const { context, meta } = await prepareContext({ ...q, mode: "hybrid" }, { retrieve, search: hangingSearch });
    assert.ok(Date.now() - t < 1000);
    assert.equal(meta.web.status, "timeout");
    assert.deepEqual(context.sources.map((s) => s.id), ["D1"]);
  } finally {
    delete process.env.SEARCH_TIMEOUT_MS;
  }
});

test("hybrid records empty search results as 'empty'", async () => {
  const { meta } = await prepareContext({ ...q, mode: "hybrid" }, { retrieve, search: async () => [] });
  assert.equal(meta.web.status, "empty");
});

test("web mode with no usable results is an error, not an empty answer", async () => {
  await assert.rejects(
    prepareContext({ ...q, mode: "web" }, { retrieve: noRetrieve, search: failingSearch }),
    WebSearchUnavailableError
  );
  await assert.rejects(
    prepareContext({ ...q, mode: "web" }, { retrieve: noRetrieve, search: async () => [] }),
    WebSearchUnavailableError
  );
});
