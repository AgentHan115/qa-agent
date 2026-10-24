// Load test for an OpenAI-compatible serving runtime (built for SGLang) on the
// frozen retrieved prompts: real RAG prompts, no retrieval or search. Streams
// every request to measure time to first token (TTFT), time per output token
// (TPOT) and end-to-end latency, at several concurrency levels.
//
//   node eval/bench-runtime.js --frozen=eval/frozen/contexts-<ts>.json --label=radix-on
//                              [--concurrency=1,2,4,8,16] [--reps=2]
//                              [--reference=results/replay-<ts>.json]
//
// Each (concurrency, rep) runs all prompts through `concurrency` workers (a
// closed loop) after flushing the server's prefix cache, so a radix-cache run
// starts cold and only reuses prefixes shared within that pass. --reference
// counts answers byte-identical to an earlier sequential replay (batching can
// change greedy outputs). Uses the LLM_* settings, like replay-contexts.js.
// Writes results/bench-<label>-<timestamp>.json.

import dotenv from "dotenv";
dotenv.config();

import { createHash } from "crypto";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";

import { llmConfig } from "../lib/llm.js";
import { describeRuntime } from "../lib/runtime-info.js";
import { planCalls, promptText, sha1 } from "./replay.js";

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const frozenPath = argValue("frozen");
const label = argValue("label");
if (!frozenPath || !label) {
  console.error("Usage: node eval/bench-runtime.js --frozen=<contexts.json> --label=<name> [--concurrency=1,2,4,8,16] [--reps=2] [--reference=<replay.json>]");
  process.exit(1);
}
const levels = (argValue("concurrency") ?? "1,2,4,8,16").split(",").map(Number);
const reps = Number(argValue("reps") ?? 2);
const config = llmConfig();
if (config.runtime !== "sglang") {
  console.error("bench-runtime.js flushes the cache through SGLang's /flush_cache; set LLM_RUNTIME=sglang.");
  process.exit(1);
}
const origin = new URL(config.baseURL).origin;

const frozenText = readFileSync(frozenPath, "utf8");
const frozen = JSON.parse(frozenText);
const prompts = planCalls(frozen, undefined, ["retrieved"]).map((call) => {
  const { user, prompt_sha1 } = call.context;
  if (sha1(promptText(frozen.system, user)) !== prompt_sha1) throw new Error(`${call.id}: prompt doesn't match the frozen prompt_sha1`);
  return { id: call.id, user };
});
const referencePath = argValue("reference");
const reference = referencePath
  ? new Map(JSON.parse(readFileSync(referencePath, "utf8")).answers.filter((a) => a.condition === "retrieved").map((a) => [a.id, a.answer]))
  : null;

// One streamed chat completion, timed from just before the request is sent.
const request = async ({ id, user }) => {
  const body = {
    model: config.model,
    messages: [
      { role: "system", content: frozen.system },
      { role: "user", content: user },
    ],
    temperature: config.temperature,
    seed: config.seed,
    max_tokens: config.maxOutputTokens,
    chat_template_kwargs: { enable_thinking: false },
    stream: true,
    stream_options: { include_usage: true },
  };
  const t0 = performance.now();
  let ttft = null;
  let text = "";
  let usage = null;
  try {
    const res = await fetch(`${config.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of res.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const chunk = JSON.parse(line.slice(6));
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          ttft ??= performance.now() - t0;
          text += delta;
        }
        if (chunk.usage) usage = chunk.usage;
      }
    }
  } catch (err) {
    return { id, error: `${err.name}: ${err.message}`, e2e_ms: performance.now() - t0 };
  }
  const e2e = performance.now() - t0;
  const out = usage?.completion_tokens ?? null;
  return {
    id,
    ttft_ms: ttft,
    e2e_ms: e2e,
    // Decode time per token after the first one.
    tpot_ms: out > 1 && ttft !== null ? (e2e - ttft) / (out - 1) : null,
    prompt_tokens: usage?.prompt_tokens ?? null,
    cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    output_tokens: out,
    answer_sha1: sha1(text),
    same_as_reference: reference ? reference.get(id) === text : null,
  };
};

// `concurrency` workers pull prompts in a fixed order until none are left.
const runPass = async (concurrency) => {
  const queue = [...prompts];
  const results = [];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) results.push(await request(queue.shift()));
    })
  );
  return { wall_ms: performance.now() - t0, results };
};

const flushCache = async () => {
  const res = await fetch(`${origin}/flush_cache`, { method: "POST" });
  if (!res.ok) throw new Error(`/flush_cache: HTTP ${res.status}`);
};

const pct = (xs, p) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? Math.round(v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]) : null;
};
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const reproducedAcrossReps = (passes) => {
  const first = new Map(passes[0].results.map((r) => [r.id, r.answer_sha1]));
  const later = passes.slice(1).flatMap((p) => p.results);
  return later.length ? `${later.filter((r) => !r.error && first.get(r.id) === r.answer_sha1).length}/${later.length}` : null;
};
const summarize = (concurrency, passes) => {
  const ok = passes.flatMap((p) => p.results.filter((r) => !r.error));
  const wall = sum(passes.map((p) => p.wall_ms)) / 1000;
  return {
    concurrency,
    requests: passes.reduce((n, p) => n + p.results.length, 0),
    errors: passes.reduce((n, p) => n + p.results.filter((r) => r.error).length, 0),
    ttft_ms: { p50: pct(ok.map((r) => r.ttft_ms), 50), p95: pct(ok.map((r) => r.ttft_ms), 95) },
    tpot_ms: { p50: pct(ok.map((r) => r.tpot_ms), 50), p95: pct(ok.map((r) => r.tpot_ms), 95) },
    e2e_ms: { p50: pct(ok.map((r) => r.e2e_ms), 50), p95: pct(ok.map((r) => r.e2e_ms), 95) },
    requests_per_s: +(ok.length / wall).toFixed(2),
    output_tokens_per_s: Math.round(sum(ok.map((r) => r.output_tokens)) / wall),
    cached_prompt_share: +(sum(ok.map((r) => r.cached_tokens)) / sum(ok.map((r) => r.prompt_tokens))).toFixed(3),
    same_as_reference: reference ? ok.filter((r) => r.same_as_reference).length : null,
    // Greedy outputs that repeat across reps; batching and cache state can change them.
    same_across_reps: reproducedAcrossReps(passes),
  };
};

// Round trip to the server without the model: the network's share of TTFT.
// (/health runs a test generation, so it isn't a network round trip.)
const rtts = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  await (await fetch(`${origin}/get_model_info`)).text();
  rtts.push(performance.now() - t);
}

console.log(`${label}: ${prompts.length} prompts x ${reps} reps at concurrency ${levels.join(", ")} -> ${config.model}`);
await Promise.all(prompts.slice(0, 2).map(request)); // warm-up, not recorded
const runs = [];
for (const concurrency of levels) {
  const passes = [];
  for (let rep = 0; rep < reps; rep++) {
    await flushCache();
    passes.push(await runPass(concurrency));
  }
  const summary = summarize(concurrency, passes);
  runs.push({ summary, passes });
  const s = summary;
  console.log(
    `c=${String(concurrency).padEnd(2)} TTFT p50 ${s.ttft_ms.p50} p95 ${s.ttft_ms.p95} ms | TPOT p50 ${s.tpot_ms.p50} ms | e2e p50 ${s.e2e_ms.p50} p95 ${s.e2e_ms.p95} ms | ` +
      `${s.requests_per_s} req/s, ${s.output_tokens_per_s} out tok/s | cached ${(s.cached_prompt_share * 100).toFixed(1)}% | ` +
      `${s.errors} errors | same across reps ${s.same_across_reps}${reference ? ` | same as reference ${s.same_as_reference}/${s.requests - s.errors}` : ""}`
  );
}

const git = (() => {
  try {
    return {
      commit: execSync("git rev-parse HEAD").toString().trim(),
      dirty: execSync("git status --porcelain --untracked-files=no").toString().trim().length > 0,
    };
  } catch {
    return null;
  }
})();
const runAt = new Date().toISOString();
const out = {
  runAt,
  label,
  git,
  frozen: { path: frozenPath, sha256: createHash("sha256").update(frozenText).digest("hex") },
  reference: referencePath ?? null,
  client: "Mac, through an SSH tunnel to the GPU host",
  network_rtt_ms: { p50: pct(rtts, 50), max: Math.round(Math.max(...rtts)) },
  runtime: await describeRuntime().catch((err) => ({ error: err.message })),
  levels,
  reps,
  runs,
};
mkdirSync("results", { recursive: true });
const outPath = `results/bench-${label}-${runAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`network RTT p50 ${out.network_rtt_ms.p50} ms. Wrote ${outPath}`);
