// Real MCP round trips against mcp-server.js, using the fake provider (no network).

import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.SEARCH_PROVIDER = "fake";
process.env.FAKE_SEARCH_LATENCY_MS = "20";

const { searchViaMcp, closeMcpClient, stats } = await import("../search/mcp-client.js");

after(() => closeMcpClient());

test("concurrent first calls share one connection and all succeed", async () => {
  const before = stats.connects;
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => searchViaMcp(`query ${i}`, { num: 2 }))
  );
  assert.deepEqual(
    outcomes.map((o) => o.status),
    Array(8).fill("fulfilled"),
    outcomes.filter((o) => o.status === "rejected").map((o) => o.reason?.message).join("; ")
  );
  assert.equal(stats.connects - before, 1, "exactly one MCP server process was started");
  assert.equal(outcomes[0].value.results.length, 2);
  assert.equal(outcomes[0].value.attempts, 1);
});

test("a cancelled call rejects promptly and the connection stays usable", async () => {
  const controller = new AbortController();
  // The fake provider takes 20ms; abort before it can answer.
  const p = searchViaMcp("slow", { signal: controller.signal });
  controller.abort(Object.assign(new Error("budget"), { name: "AbortError" }));
  await assert.rejects(p);

  const before = stats.connects;
  const ok = await searchViaMcp("after cancel", { num: 1 });
  assert.equal(ok.results.length, 1);
  assert.equal(stats.connects, before, "no reconnect needed after a cancelled call");
});

test("a failed search reports how many attempts the server made", async () => {
  // A fresh server process with a provider that always fails retryably.
  await closeMcpClient();
  process.env.FAKE_SEARCH_MODE = "transient";
  process.env.FAKE_SEARCH_LATENCY_MS = "1";
  try {
    await assert.rejects(searchViaMcp("q"), (err) => {
      assert.match(err.message, /fake provider unavailable/);
      assert.equal(err.attempts, 3, "1 attempt + 2 retries");
      return true;
    });
  } finally {
    await closeMcpClient();
    process.env.FAKE_SEARCH_MODE = "ok";
    process.env.FAKE_SEARCH_LATENCY_MS = "20";
  }
});
