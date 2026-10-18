// Guards against two silent failure modes of LLM servers:
//
// 1. Context truncation. Ollama silently drops part of a prompt that exceeds
//    its context window instead of erroring. Observed with Ollama 0.33: the
//    server keeps exactly num_ctx/2 + 2 tokens (2,050 at 4096; 8,194 at 16384)
//    and the model answers from what is left.
// 2. Thinking left on. A reasoning model that still "thinks" spends hidden
//    tokens and distorts TTFT/latency measurements.
//
// Why not just estimate tokens from characters: the ratio varies too much.
// Prose runs ~3-4 chars/token, but the raw SerpAPI JSON in the web path was
// 1.72 chars/token (50,970 chars -> 29,693 tokens). A truncated JSON prompt
// can therefore look perfectly plausible by ratio alone.
//
// What is sound:
//  - No text tokenizes below ~1 char/token, so a prompt with fewer characters
//    than the context window can never overflow it.
//  - For longer prompts we need runtime evidence. For Ollama, a reported prompt
//    count above num_ctx/2 + 2 proves nothing was cut. Runtimes whose overflow
//    behaviour hasn't been verified fail closed.

export class ContextOverflowError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ContextOverflowError";
    this.details = details;
  }
}

export class ThinkingEnabledError extends Error {
  constructor(message) {
    super(message);
    this.name = "ThinkingEnabledError";
  }
}

// Lower bound on chars per token for any realistic text (CJK is ~1-1.5).
const MIN_CHARS_PER_TOKEN = 1;
// Upper bound on chars per token (long English words); used only to refuse
// prompts that cannot possibly fit even under the most favourable tokenization.
const MAX_CHARS_PER_TOKEN = 6;
// Ollama keeps num_ctx/2 + 2 tokens when it truncates (observed, v0.33).
const OLLAMA_TRUNCATION_MARGIN = 8;

// Before the call: refuse prompts that are certainly too large.
export const assertFitsContext = (prompt, { contextTokens, maxOutputTokens }) => {
  const fewestPossibleTokens = Math.ceil(prompt.length / MAX_CHARS_PER_TOKEN);
  if (fewestPossibleTokens + maxOutputTokens > contextTokens) {
    throw new ContextOverflowError(
      `Prompt cannot fit the context window: at least ~${fewestPossibleTokens} prompt tokens + ${maxOutputTokens} output > ${contextTokens}`,
      { promptChars: prompt.length, fewestPossibleTokens, contextTokens, maxOutputTokens }
    );
  }
};

const truncationRuledOut = (prompt, promptTokens, { contextTokens, runtime }) => {
  // Too short to overflow, whatever it contains.
  if (prompt.length < contextTokens * MIN_CHARS_PER_TOKEN) return "short_prompt";
  // Ollama's truncated prompts report ~num_ctx/2 tokens; anything above proves a full prompt.
  if (runtime === "ollama" && promptTokens > contextTokens / 2 + OLLAMA_TRUNCATION_MARGIN) {
    return "above_ollama_truncation_size";
  }
  return null;
};

// After the call: verify against what the server says it actually processed.
// Returns a record for the request's meta; throws if truncation can't be ruled out.
export const checkPromptUsage = (prompt, usage, config) => {
  const { contextTokens, maxOutputTokens } = config;
  const promptTokens = usage?.input_tokens;
  if (!promptTokens) return { truncation_check: "unverified", prompt_chars: prompt.length };

  const record = {
    truncation_check: "pass",
    prompt_chars: prompt.length,
    prompt_tokens: promptTokens,
    chars_per_token: Number((prompt.length / promptTokens).toFixed(2)),
  };

  // Prompt plus room for the answer must fit, or the server shifts context mid-generation.
  if (promptTokens + maxOutputTokens > contextTokens) {
    throw new ContextOverflowError(
      `Prompt leaves no room for output: ${promptTokens} prompt + ${maxOutputTokens} output > ${contextTokens}`,
      { ...record, truncation_check: "fail" }
    );
  }

  const reason = truncationRuledOut(prompt, promptTokens, config);
  if (!reason) {
    throw new ContextOverflowError(
      `Possible silent truncation: ${prompt.length} chars reported as ${promptTokens} tokens (context ${contextTokens}, runtime ${config.runtime})`,
      { ...record, truncation_check: "fail" }
    );
  }
  return { ...record, truncation_ruled_out_by: reason };
};

// After the call: fail if a model asked not to think still produced reasoning.
export const assertNoThinking = (message) => {
  const content = typeof message?.content === "string" ? message.content : "";
  const reasoningTokens = message?.usage_metadata?.output_token_details?.reasoning ?? 0;
  const reasoningText = message?.additional_kwargs?.reasoning_content ?? message?.additional_kwargs?.reasoning ?? "";
  if (content.includes("<think>") || reasoningTokens > 0 || reasoningText.length > 0) {
    throw new ThinkingEnabledError("Model produced reasoning output although thinking is disabled");
  }
};
