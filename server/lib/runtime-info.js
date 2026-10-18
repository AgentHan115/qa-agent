// A reproducibility record of what this server is actually running: model and
// embedding configuration, retrieval parameters, and — where the serving
// runtime exposes it — exact model digests and server versions. Secrets are
// never included. Served at GET /runtime and stored with every eval run.

import { llmConfig, embeddingConfig } from "./llm.js";
import { CHUNK_SIZE, CHUNK_OVERLAP } from "../ingest.js";
import { TOP_K } from "../query.js";

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

export const describeRuntime = async () => {
  const llm = llmConfig();
  const embedding = embeddingConfig();
  const info = {
    llm: { ...llm },
    embedding: { ...embedding },
    retrieval: { top_k: TOP_K, chunk_size: CHUNK_SIZE, chunk_overlap: CHUNK_OVERLAP },
    web_search: { provider: "serpapi", engine: "google", num: 5 },
    serving: null,
  };
  try {
    if (llm.runtime === "ollama") {
      info.serving = await describeOllama(llm.baseURL, [llm.model, embedding.model]);
    }
  } catch (err) {
    info.serving = { error: err.message };
  }
  return info;
};
