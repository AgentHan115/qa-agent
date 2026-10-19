// Single place where chat models and embeddings are constructed.
//
// Everything talks to an OpenAI-compatible API, so switching between OpenAI,
// a local Ollama server, and (later) SGLang/vLLM is configuration only:
//   LLM_BASE_URL / LLM_MODEL / LLM_RUNTIME, EMBEDDING_BASE_URL / EMBEDDING_MODEL.
// The one runtime-specific detail is how "thinking" is turned off, which each
// server exposes differently (see thinkingOffParams).

import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { failFastOnPermanentErrors } from "./errors.js";
import { assertFitsContext, checkPromptUsage, assertNoThinking } from "./guards.js";
import { usageFrom } from "./usage.js";

const env = (name, fallback) => process.env[name] ?? fallback;
const intEnv = (name, fallback) => (process.env[name] ? parseInt(process.env[name], 10) : fallback);
const boolEnv = (name, fallback) => (process.env[name] ? process.env[name] === "true" : fallback);

export const llmConfig = () => ({
  runtime: env("LLM_RUNTIME", "openai"), // openai | ollama | sglang | vllm
  baseURL: env("LLM_BASE_URL", undefined), // undefined = api.openai.com
  model: env("LLM_MODEL", env("OPENAI_MODEL", "gpt-4o")),
  disableThinking: boolEnv("LLM_DISABLE_THINKING", true),
  contextTokens: intEnv("LLM_CONTEXT_TOKENS", 128000), // server-side context window
  maxOutputTokens: intEnv("LLM_MAX_OUTPUT_TOKENS", 1024),
  temperature: Number(env("LLM_TEMPERATURE", "0")),
  seed: intEnv("LLM_SEED", 1),
  timeoutMs: intEnv("LLM_TIMEOUT_MS", 120000),
  maxRetries: intEnv("LLM_MAX_RETRIES", 2),
});

export const embeddingConfig = () => ({
  baseURL: env("EMBEDDING_BASE_URL", env("LLM_BASE_URL", undefined)),
  model: env("EMBEDDING_MODEL", "text-embedding-ada-002"),
  // Prepended to queries only (not documents). Instruction-tuned embedders such
  // as Qwen3-Embedding expect it; leave empty for symmetric models.
  queryInstruction: env("EMBEDDING_QUERY_INSTRUCTION", ""),
  // Inputs per /embeddings request. Ollama 0.33 fails a 212-input batch
  // ("tokenize ... connection reset") while 128 works, so keep it small there.
  batchSize: intEnv("EMBEDDING_BATCH_SIZE", 512),
});

// Request params that turn off reasoning/"thinking" output, per runtime.
// Verified for Ollama 0.33: its OpenAI endpoint ignores `think: false` but
// honours `reasoning_effort: "none"`. SGLang/vLLM pass chat template kwargs.
const thinkingOffParams = (runtime) => {
  switch (runtime) {
    case "ollama":
      return { reasoning_effort: "none" };
    case "sglang":
    case "vllm":
      return { chat_template_kwargs: { enable_thinking: false } };
    default:
      return {};
  }
};

const apiKeyFor = (baseURL) =>
  baseURL ? env("LLM_API_KEY", "not-needed") : process.env.OPENAI_API_KEY;

export const createChatModel = ({ streaming = false, model } = {}) => {
  const c = llmConfig();
  return new ChatOpenAI({
    model: model ?? c.model,
    apiKey: apiKeyFor(c.baseURL),
    configuration: c.baseURL ? { baseURL: c.baseURL } : undefined,
    temperature: c.temperature,
    maxTokens: c.maxOutputTokens,
    timeout: c.timeoutMs,
    maxRetries: c.maxRetries,
    onFailedAttempt: failFastOnPermanentErrors,
    streaming,
    modelKwargs: {
      seed: c.seed,
      ...(c.disableThinking ? thinkingOffParams(c.runtime) : {}),
    },
  });
};

export const createEmbeddings = () => {
  const c = embeddingConfig();
  return new OpenAIEmbeddings({
    model: c.model,
    batchSize: c.batchSize,
    timeout: intEnv("EMBEDDING_TIMEOUT_MS", 60000),
    apiKey: apiKeyFor(c.baseURL),
    configuration: c.baseURL ? { baseURL: c.baseURL } : undefined,
    maxRetries: intEnv("LLM_MAX_RETRIES", 2),
    onFailedAttempt: failFastOnPermanentErrors,
  });
};

export const formatQuery = (question) => {
  const { queryInstruction } = embeddingConfig();
  return queryInstruction ? `${queryInstruction}${question}` : question;
};

// Guarded calls: refuse prompts that may not fit, verify the server-reported
// prompt size afterwards (truncation), and fail if thinking leaked through.
// The returned/filled `check` record belongs in the request's meta.
// `input` is a prompt string or a list of chat messages; `promptText` is the
// text the model reads (all message contents), used for the size checks.
// `options.signal` cancels the request (the server stops generating).
export const invokeGuarded = async (model, input, promptText = input, { signal } = {}) => {
  const c = llmConfig();
  assertFitsContext(promptText, c);
  const message = await model.invoke(input, { signal });
  const check = checkPromptUsage(promptText, message.usage_metadata, c);
  if (c.disableThinking) assertNoThinking(message);
  return { message, check };
};

export async function* streamGuarded(model, input, meta, promptText = input, { signal } = {}) {
  const c = llmConfig();
  assertFitsContext(promptText, c);
  let usage;
  let text = "";
  for await (const chunk of await model.stream(input, { signal })) {
    if (chunk.usage_metadata) usage = chunk.usage_metadata;
    if (chunk.content) {
      text += chunk.content;
      yield chunk;
    }
  }
  // Usage arrives on a final chunk with no content, so record it here.
  meta.usage = usageFrom({ usage_metadata: usage });
  meta.check = checkPromptUsage(promptText, usage, c);
  if (c.disableThinking) assertNoThinking({ content: text, usage_metadata: usage });
}
