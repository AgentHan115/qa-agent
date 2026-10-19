// prepareContext with substituted retrieval and search: mode handling, the
// hybrid fallbacks in both directions, time budget and cancellation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareContext,
  WebSearchUnavailableError,
  RetrievalUnavailableError,
  NoSourcesError,
} from "../pipeline/answer.js";
import { VectorsMissingError } from "../lib/vectors.js";

const docs = [{ text: "An MVP tests a hypothesis with minimal effort.", page: 3 }];
const results = [
  { title: "MVP", url: "https://example.com/mvp", snippet: "Minimum viable product.", date: null, provider: "fake" },
];

const retrieve = async (q, id, meta) => {
  meta.embed_ms = 1;
  meta.chroma_ms = 1;
  return docs;
};
const brokenRetrieve = async () => {
  throw new Error("Chroma unreachable");
};
const okSearch = async () => ({ results, attempts: 1 });
const failingSearch = async () => {
  throw Object.assign(new Error("upstream 503"), { attempts: 3 });
};
// Never resolves on its own; rejects when its signal aborts (like a real provider).
const hangingSearch = (q, { signal }) =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
const noRetrieve = async () => assert.fail("retrieval must not run in web mode");
const noSearch = async () => assert.fail("search must not run in docs mode");

const q = { question: "What is an MVP?", documentId: "doc-1" };

test("hybrid uses both source types in one context", async () => {
  const { context, meta } = await prepareContext({ ...q, mode: "hybrid" }, { retrieve, search: okSearch });
  assert.deepEqual(context.sources.map((s) => s.id), ["D1", "W1"]);
  assert.equal(meta.web.status, "ok");
  assert.equal(meta.web.attempts, 1);
  assert.equal(meta.retrieval.status, "ok");
  assert.deepEqual(meta.sources, { documents: 1, web: 1 });
});

test("docs mode never calls search; web mode never touches documents", async () => {
  const d = await prepareContext({ ...q, mode: "docs" }, { retrieve, search: noSearch });
  assert.equal(d.meta.web, null);
  assert.equal(d.meta.retrieval.status, "ok");
  const w = await prepareContext({ ...q, documentId: null, mode: "web" }, { retrieve: noRetrieve, search: okSearch });
  assert.equal(w.meta.retrieval, null);
  assert.deepEqual(w.context.sources.map((s) => s.id), ["W1"]);
});

test("hybrid falls back to documents when search fails", async () => {
  const { context, meta } = await prepareContext({ ...q, mode: "hybrid" }, { retrieve, search: failingSearch });
  assert.deepEqual(context.sources.map((s) => s.id), ["D1"]);
  assert.equal(meta.web.status, "error");
  assert.equal(meta.web.attempts, 3);
  assert.match(meta.web.error, /upstream 503/);
});

test("hybrid falls back to the web when retrieval fails", async () => {
  const { context, meta } = await prepareContext({ ...q, mode: "hybrid" }, { retrieve: brokenRetrieve, search: okSearch });
  assert.deepEqual(context.sources.map((s) => s.id), ["W1"]);
  assert.equal(meta.retrieval.status, "error");
  assert.match(meta.retrieval.error, /Chroma unreachable/);
});

test("hybrid with no sources at all is an error", async () => {
  await assert.rejects(
    prepareContext({ ...q, mode: "hybrid" }, { retrieve: brokenRetrieve, search: failingSearch }),
    NoSourcesError
  );
});

test("missing vectors are never papered over, even in hybrid", async () => {
  const missing = async () => {
    throw new VectorsMissingError("doc-1");
  };
  await assert.rejects(prepareContext({ ...q, mode: "hybrid" }, { retrieve: missing, search: okSearch }), VectorsMissingError);
});

test("docs mode surfaces retrieval failures as RetrievalUnavailableError", async () => {
  await assert.rejects(
    prepareContext({ ...q, mode: "docs" }, { retrieve: brokenRetrieve, search: noSearch }),
    RetrievalUnavailableError
  );
});

test("the search budget aborts the search itself, then falls back", async () => {
  process.env.SEARCH_TIMEOUT_MS = "50";
  try {
    let searchSignal;
    const t = Date.now();
    const { context, meta } = await prepareContext(
      { ...q, mode: "hybrid" },
      {
        retrieve,
        search: (query, opts) => {
          searchSignal = opts.signal;
          return hangingSearch(query, opts);
        },
      }
    );
    assert.ok(Date.now() - t < 1000);
    assert.equal(meta.web.status, "timeout");
    assert.equal(searchSignal.aborted, true, "the search was told to stop, not left running");
    assert.deepEqual(context.sources.map((s) => s.id), ["D1"]);
  } finally {
    delete process.env.SEARCH_TIMEOUT_MS;
  }
});

test("a cancelled request rejects and cancels the search", async () => {
  const controller = new AbortController();
  let searchSignal;
  const p = prepareContext(
    { ...q, mode: "hybrid", signal: controller.signal },
    {
      retrieve,
      search: (query, opts) => {
        searchSignal = opts.signal;
        return hangingSearch(query, opts);
      },
    }
  );
  setTimeout(() => controller.abort(Object.assign(new Error("Client disconnected"), { name: "AbortError" })), 20);
  await assert.rejects(p, { name: "AbortError" });
  assert.equal(searchSignal.aborted, true);
});

test("hybrid records empty search results as 'empty'", async () => {
  const { meta } = await prepareContext({ ...q, mode: "hybrid" }, { retrieve, search: async () => ({ results: [], attempts: 1 }) });
  assert.equal(meta.web.status, "empty");
});

test("web mode with no usable results is an error, not an empty answer", async () => {
  await assert.rejects(
    prepareContext({ ...q, mode: "web" }, { retrieve: noRetrieve, search: failingSearch }),
    WebSearchUnavailableError
  );
  await assert.rejects(
    prepareContext({ ...q, mode: "web" }, { retrieve: noRetrieve, search: async () => ({ results: [], attempts: 1 }) }),
    WebSearchUnavailableError
  );
});
