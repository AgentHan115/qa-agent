// A reproducibility record of what this server is actually running: model and
// embedding configuration, retrieval parameters, and — where the serving
// runtime exposes it — exact model digests and server versions. Secrets are
// never included. Served at GET /runtime and stored with every eval run.

import { llmConfig, embeddingConfig } from "./llm.js";
import { CHUNK_SIZE, CHUNK_OVERLAP } from "../ingest.js";
import { TOP_K } from "../pipeline/retrieve.js";
import { searchConfig } from "../search/index.js";
import { INSTRUCTIONS } from "../pipeline/context.js";
import { createHash } from "crypto";

const getJson = async (url, init) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), ...init });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

// Ollama exposes version, digests and quantization on its native API
// (the OpenAI-compatible /v1 path is a sibling of /api).
const describeOllama = async (baseURL, modelNames) => {
  const origin = new URL(baseURL).origin;
  const [{ version }, { models }] = await Promise.all([
    getJson(`${origin}/api/version`),
    getJson(`${origin}/api/tags`),
  ]);
  const describe = async (name) => {
    const tag = models.find((m) => m.name === name || m.name === `${name}:latest`);
    const show = await getJson(`${origin}/api/show`, {
      method: "POST",
      body: JSON.stringify({ model: name }),
    });
    return {
      name,
      digest: tag?.digest ?? null,
      quantization: show.details?.quantization_level ?? null,
      parameter_size: show.details?.parameter_size ?? null,
      family: show.details?.family ?? null,
      parent_model: show.details?.parent_model || null,
      parameters: show.parameters ?? null, // includes num_ctx when set via Modelfile
    };
  };
  return { server: "ollama", version, models: await Promise.all(modelNames.map(describe)) };
};

// SGLang serves its model and server settings next to /v1. /get_server_info
// also holds secrets (api_key, admin_api_key), so only listed fields are kept.
const SGLANG_SERVER_FIELDS = [
  "attention_backend",
  "sampling_backend",
  "dtype",
  "kv_cache_dtype",
  "quantization",
  "context_length",
  "max_total_num_tokens", // KV-cache pool: the real per-request prompt limit
  "mem_fraction_static",
  "chunked_prefill_size",
  "cuda_graph_max_bs_decode",
  "disable_radix_cache",
  "enable_cache_report",
  "enable_deterministic_inference",
];
const describeSglang = async (baseURL) => {
  const origin = new URL(baseURL).origin;
  const [model, server] = await Promise.all([getJson(`${origin}/get_model_info`), getJson(`${origin}/get_server_info`)]);
  return {
    server: "sglang",
    version: server.version ?? null,
    model: {
      name: model.served_model_name ?? null,
      path: model.model_path ?? null,
      // Hugging Face cache paths end in snapshots/<commit>.
      hf_revision: model.model_path?.match(/snapshots\/([0-9a-f]{40})/)?.[1] ?? null,
    },
    args: Object.fromEntries(SGLANG_SERVER_FIELDS.map((k) => [k, server[k] ?? null])),
  };
};

export const describeRuntime = async () => {
  const llm = llmConfig();
  const embedding = embeddingConfig();
  const info = {
    llm: { ...llm },
    embedding: { ...embedding },
    retrieval: { top_k: TOP_K, chunk_size: CHUNK_SIZE, chunk_overlap: CHUNK_OVERLAP },
    web_search: searchConfig(),
    // Identifies the exact answer instructions without embedding them here.
    prompt: { instructions_sha1: createHash("sha1").update(INSTRUCTIONS).digest("hex").slice(0, 12) },
    serving: null,
  };
  try {
    if (llm.runtime === "ollama") {
      info.serving = await describeOllama(llm.baseURL, [llm.model, embedding.model]);
    } else if (llm.runtime === "sglang") {
      info.serving = await describeSglang(llm.baseURL);
    }
  } catch (err) {
    info.serving = { error: err.message };
  }
  return info;
};
