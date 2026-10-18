// Cases marked "observed" are real measurements from Ollama 0.33 + qwen3:8b.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertFitsContext,
  checkPromptUsage,
  assertNoThinking,
  ContextOverflowError,
  ThinkingEnabledError,
} from "../lib/guards.js";

const ollama16k = { runtime: "ollama", contextTokens: 16384, maxOutputTokens: 1024 };
const ollama32k = { runtime: "ollama", contextTokens: 32768, maxOutputTokens: 1024 };

test("pre-flight lets through prompts that could fit", () => {
  // Observed: 50,970 chars of raw SerpAPI JSON were 29,693 tokens and fit in 32k.
  assert.doesNotThrow(() => assertFitsContext("x".repeat(50970), ollama32k));
});

test("pre-flight refuses prompts that cannot fit under any tokenization", () => {
  assert.throws(() => assertFitsContext("x".repeat(200000), ollama32k), ContextOverflowError);
});

test("short prompts can never be truncated", () => {
  // Observed: doc-path prompt, 2,422 chars -> 584 tokens.
  const r = checkPromptUsage("x".repeat(2422), { input_tokens: 584 }, ollama32k);
  assert.equal(r.truncation_ruled_out_by, "short_prompt");
});

test("dense JSON that fully fit is accepted", () => {
  // Observed: 50,970 chars -> 29,693 tokens at num_ctx 32768 (1.72 chars/token).
  const r = checkPromptUsage("x".repeat(50970), { input_tokens: 29693 }, ollama32k);
  assert.equal(r.truncation_ruled_out_by, "above_ollama_truncation_size");
  assert.equal(r.chars_per_token, 1.72);
});

test("detects Ollama truncation of prose", () => {
  // Observed: 58,986 chars silently cut to 8,194 tokens at num_ctx 16384.
  assert.throws(
    () => checkPromptUsage("x".repeat(58986), { input_tokens: 8194 }, ollama16k),
    ContextOverflowError
  );
});

test("detects truncation of dense JSON that a chars/token heuristic would miss", () => {
  // A JSON prompt truncated to num_ctx/2 + 2 still looks like ~3.4 chars/token.
  assert.throws(
    () => checkPromptUsage("x".repeat(56000), { input_tokens: 16386 }, ollama32k),
    ContextOverflowError
  );
});

test("flags prompts that leave no room for the answer", () => {
  assert.throws(
    () => checkPromptUsage("x".repeat(60000), { input_tokens: 32000 }, ollama32k),
    ContextOverflowError
  );
});

test("unverified runtimes fail closed on long prompts", () => {
  const unknown = { runtime: "sglang", contextTokens: 32768, maxOutputTokens: 1024 };
  assert.throws(
    () => checkPromptUsage("x".repeat(50970), { input_tokens: 29693 }, unknown),
    ContextOverflowError
  );
  // ...but short prompts are still provably safe on any runtime.
  assert.doesNotThrow(() => checkPromptUsage("x".repeat(2422), { input_tokens: 584 }, unknown));
});

test("missing usage is reported as unverified, not as a pass", () => {
  assert.equal(checkPromptUsage("hello", undefined, ollama32k).truncation_check, "unverified");
});

test("thinking check passes a plain answer", () => {
  assert.doesNotThrow(() =>
    assertNoThinking({ content: "51", usage_metadata: { output_token_details: {} } })
  );
});

test("thinking check catches think tags, reasoning tokens and reasoning text", () => {
  assert.throws(() => assertNoThinking({ content: "<think>hmm</think>51" }), ThinkingEnabledError);
  assert.throws(
    () => assertNoThinking({ content: "51", usage_metadata: { output_token_details: { reasoning: 250 } } }),
    ThinkingEnabledError
  );
  assert.throws(
    () => assertNoThinking({ content: "51", additional_kwargs: { reasoning_content: "Let me think" } }),
    ThinkingEnabledError
  );
});
