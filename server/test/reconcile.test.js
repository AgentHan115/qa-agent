import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileReadyDocuments } from "../lib/reconcile.js";

const silent = { warn: () => {} };

const setup = (docs, vectorCounts) => {
  const failed = [];
  return {
    failed,
    deps: {
      listDocumentsByStatus: async (status) => docs.filter((d) => d.status === status),
      countVectors: async (id) => vectorCounts[id] ?? 0,
      markFailed: async (id, reason) => failed.push({ id, reason }),
      log: silent,
    },
  };
};

test("leaves documents whose Chroma count matches Postgres", async () => {
  const { deps, failed } = setup([{ id: "a", status: "ready", chunk_count: 12 }], { a: 12 });
  const result = await reconcileReadyDocuments(deps);
  assert.deepEqual(result, { checked: 1, drifted: [] });
  assert.equal(failed.length, 0);
});

test("marks a ready document failed when its collection is missing", async () => {
  const { deps, failed } = setup([{ id: "a", status: "ready", chunk_count: 212 }], {});
  const result = await reconcileReadyDocuments(deps);
  assert.deepEqual(result.drifted, ["a"]);
  assert.equal(failed[0].id, "a");
  assert.match(failed[0].reason, /expected 212, found 0/);
});

test("treats a partial collection as drift", async () => {
  const { deps, failed } = setup([{ id: "a", status: "ready", chunk_count: 212 }], { a: 100 });
  await reconcileReadyDocuments(deps);
  assert.match(failed[0].reason, /expected 212, found 100/);
});

test("only checks ready documents", async () => {
  const { deps, failed } = setup(
    [
      { id: "p", status: "processing", chunk_count: null },
      { id: "f", status: "failed", chunk_count: null },
    ],
    {}
  );
  const result = await reconcileReadyDocuments(deps);
  assert.equal(result.checked, 0);
  assert.equal(failed.length, 0);
});
