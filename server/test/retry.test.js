import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetries, backoffDelay, sleep } from "../search/retry.js";
import { createSerpApiProvider, classifyHttpError } from "../search/serpapi.js";
import { SearchProviderError } from "../search/provider.js";

const transient = () => Object.assign(new Error("503"), { retryable: true });
const permanent = () => Object.assign(new Error("401"), { retryable: false });
const noDelay = { baseDelayMs: 0, maxDelayMs: 0 };

test("retries retryable errors up to the limit, then gives up", async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(async () => {
      calls++;
      throw transient();
    }, { retries: 2, ...noDelay }),
    (err) => err.attempts === 3
  );
  assert.equal(calls, 3);
});

test("succeeds on a later attempt", async () => {
  let calls = 0;
  const result = await withRetries(async () => {
    if (++calls < 3) throw transient();
    return "ok";
  }, { retries: 2, ...noDelay });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("never retries permanent errors", async () => {
  let calls = 0;
  await assert.rejects(withRetries(async () => {
    calls++;
    throw permanent();
  }, { retries: 5, ...noDelay }));
  assert.equal(calls, 1);
});

test("an abort during backoff stops immediately", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(Object.assign(new Error("budget"), { name: "AbortError" })), 20);
  const t = Date.now();
  await assert.rejects(
    withRetries(async () => {
      throw transient();
    }, { retries: 5, baseDelayMs: 10_000, maxDelayMs: 10_000, random: () => 1, signal: controller.signal }),
    { name: "AbortError" }
  );
  assert.ok(Date.now() - t < 1000, "did not wait out the 10s backoff");
});

test("full-jitter backoff is bounded by base*2^attempt and maxDelay", () => {
  const cfg = { baseDelayMs: 250, maxDelayMs: 2000 };
  assert.equal(backoffDelay(0, { ...cfg, random: () => 0.999 }), 249);
  assert.equal(backoffDelay(2, { ...cfg, random: () => 0.999 }), 999);
  assert.equal(backoffDelay(10, { ...cfg, random: () => 0.999 }), 1998);
  assert.equal(backoffDelay(3, { ...cfg, random: () => 0 }), 0);
});

test("sleep rejects at once on an already-aborted signal", async () => {
  await assert.rejects(sleep(10_000, AbortSignal.abort()));
});

// --- SerpAPI adapter, with fetch substituted -------------------------------

const respond = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});
const provider = (fetchImpl, attemptTimeoutMs = 3000) =>
  createSerpApiProvider({ apiKey: "test-key", fetchImpl, attemptTimeoutMs });

test("serpapi: 200 maps organic results", async () => {
  const results = await provider(
    respond(200, { organic_results: [{ position: 1, title: "T", link: "https://a.com", snippet: "S" }] })
  ).search("q");
  assert.equal(results[0].url, "https://a.com");
});

test("serpapi: HTTP errors are classified for retry", async () => {
  const cases = [
    [429, "You've hit the hourly throughput limit.", true],
    [429, "Your account has run out of searches.", false],
    [401, "Invalid API key.", false],
    [503, "Service unavailable", true],
  ];
  for (const [status, error, retryable] of cases) {
    await assert.rejects(provider(respond(status, { error })).search("q"), (err) => {
      assert.ok(err instanceof SearchProviderError);
      assert.equal(err.status, status);
      assert.equal(err.retryable, retryable, `${status} ${error}`);
      return true;
    });
  }
  assert.equal(classifyHttpError(500), true);
  assert.equal(classifyHttpError(404), false);
});

test("serpapi: network errors and attempt timeouts are retryable", async () => {
  await assert.rejects(
    provider(async () => {
      throw new TypeError("fetch failed");
    }).search("q"),
    (err) => err.retryable === true
  );
  const hang = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  await assert.rejects(provider(hang, 30).search("q"), (err) => err.retryable && /timed out after 30ms/.test(err.message));
});

test("serpapi: a caller abort propagates as-is (not a provider failure)", async () => {
  const hang = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const controller = new AbortController();
  const p = provider(hang).search("q", { signal: controller.signal });
  controller.abort(Object.assign(new Error("client left"), { name: "AbortError" }));
  await assert.rejects(p, (err) => err.name === "AbortError" && !(err instanceof SearchProviderError));
});

test("serpapi: errors never include the API key", async () => {
  await assert.rejects(provider(respond(500, "{}")).search("q"), (err) => !err.message.includes("test-key"));
  await assert.rejects(
    provider(async (url) => {
      throw new TypeError(`fetch failed for ${url.split("?")[0]}`);
    }).search("q"),
    (err) => !err.message.includes("test-key")
  );
});
