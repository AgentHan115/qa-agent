import { test } from "node:test";
import assert from "node:assert/strict";
import { isPermanentProviderError, failFastOnPermanentErrors } from "../lib/errors.js";

// Shape observed from OpenAI (via @langchain/openai) on an account with no credits.
const noCredits = Object.assign(new Error("429 You have no credits remaining."), {
  status: 429,
  code: "credit_balance_exhausted",
  type: "insufficient_quota",
  error: { code: "credit_balance_exhausted", type: "insufficient_quota" },
});

test("empty credit balance is permanent even though it is a 429", () => {
  assert.equal(isPermanentProviderError(noCredits), true);
  assert.throws(() => failFastOnPermanentErrors(noCredits));
});

test("plain rate limit (429) is transient and retried", () => {
  const rateLimited = Object.assign(new Error("429 Rate limit reached"), { status: 429 });
  assert.equal(isPermanentProviderError(rateLimited), false);
  assert.doesNotThrow(() => failFastOnPermanentErrors(rateLimited));
});

test("auth and bad-request errors are permanent", () => {
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isPermanentProviderError({ status }), true, `status ${status}`);
  }
});

test("server and network errors are transient", () => {
  assert.equal(isPermanentProviderError({ status: 503 }), false);
  assert.equal(isPermanentProviderError(new Error("ECONNRESET")), false);
  assert.equal(isPermanentProviderError(undefined), false);
});

test("aborts stop retries", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.throws(() => failFastOnPermanentErrors(abort));
});
