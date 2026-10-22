# Project Handoff — Agent AI (Hybrid Document + Web Q&A)

Written 2026-10-19 and updated 2026-10-22 (Step 4 results) so a fresh Claude session can continue the work from the repository alone.

Facts are verified from the repo (code, commit messages, `server/results/`, README) unless marked **[conversation-only]**. Those come from earlier chat sessions, aren't recorded in the repo, and should be re-verified before you rely on them.

---

## START HERE IN A NEW CLAUDE SESSION

1. **Read** this file, then [README.md](README.md) (the integration guide).
2. **Check git state.** Work happens on branch `qa-agent-hardening`; `main` is the untouched original snapshot.
   - Tags: `baseline-dual`, `step1-hybrid`, `step2-reliability`.
   - Last results commit when this was updated: `f8a0b43` (human-graded Step 4 scores).
3. **Run the checks.** `npm test --prefix server` should give 79 pass. One integration test needs Chroma and the demo PDF, otherwise it's skipped. `CI=true npm test` should give 4 pass.
4. **Check the dataset:** `npm run eval:validate --prefix server` should print "All gold pages verified". It needs `sh server/scripts/fetch-demo-doc.sh` first.
5. **Current state: Step 4 (evaluation) is measured; next is a retrieval round.**
   - Human-graded results: end-to-end **20/35** grounded-correct, **26/35** with gold evidence; 7 failures trace to retrieval and 8 to generation. Details in [§8](#8-benchmark-results-and-how-to-read-them).
   - Next steps, in order: [§11](#11-step-4-status-and-next-steps). SGLang: [§13](#13-future-sglang-experiment).
6. **Local services:** `docker compose up -d postgres redis chroma`. Ollama runs on the host. Model setup: [§4](#4-runtime--model-setup).
   - [conversation-only] The previous session ran the API through a Claude preview config named `agentai-api` in `~/.claude/launch.json`, with cwd `server/`. Run it from `server/`, because `dotenv` reads `./.env`.
7. **Read [§14](#14-do-not-accidentally-change) before changing anything.**

Key files: [server/eval/](server/eval/) (capture, replay, grading, scoring) · [server/pipeline/answer.js](server/pipeline/answer.js) · [server/pipeline/context.js](server/pipeline/context.js) · [server/search/](server/search/) · [server/lib/llm.js](server/lib/llm.js) · [server/lib/guards.js](server/lib/guards.js) · [server/ingest.js](server/ingest.js) · [server/server.js](server/server.js) · [server/scripts/eval.js](server/scripts/eval.js)

---

## 1. Goal and current architecture

**Goal** [conversation-only for the motivation]: a credible, honestly measured showcase for a Forward Deployed Engineer internship application at Baidu USA. That team helps developers integrate the Querit real-time web search API into agents and RAG systems. The project should demonstrate search-API integration, retrieval strategy, reliability, and measured quality × latency × cost. Every claim must come from code or from a real run.

**Current architecture** (all in repo):
- **Express API** ([server/server.js](server/server.js)):
  - `/chat` (JSON) and `/chat/stream` (SSE), with `mode=docs|web|hybrid` (default `hybrid`);
  - `/upload`, `/documents/:id`, `/documents/:id/reingest`, `/runtime`, `/metrics`.
- **One answer pipeline** ([server/pipeline/](server/pipeline/)): retrieve from Chroma and search the web in parallel → build one prompt with `[D#]` document and `[W#]` web sources → **one** LLM call → check citations.
- **Web search** behind a provider interface ([server/search/](server/search/)), reached through an MCP stdio server ([server/mcp-server.js](server/mcp-server.js)) or directly.
- **Models** are reached through any OpenAI-compatible server, configured in [server/lib/llm.js](server/lib/llm.js). The local default is Ollama.
- **Ingestion:** BullMQ worker → PDFLoader → 500/50 character splitter → embeddings → one Chroma collection per document. Document status lives in Postgres.
- **React UI** ([src/](src/)): mode switch, citation chips, source list, fallback notices.

## 2. Original architecture and audit findings

The original system is commit `e1a9a25` on `main`, "Add backend, RAG pipeline…".

**How it worked:** two separate pipelines per question, each with its own LLM call, giving two separate answers ("RAG Answer" and "MCP Answer"). Web search always ran. The full raw SerpAPI JSON went into a prompt that didn't even contain the user's question.

**Problems found** (each is fixed or documented in the commits below):

| Problem | Where it's fixed or recorded |
|---|---|
| No real hybrid retrieval; no citations; page numbers lost at ingestion | Step 1 / `69124af` |
| `docker-compose` mounted Chroma's volume at the old `/chroma/chroma` path (Chroma 1.x uses `/data`), so embeddings were lost whenever the container was recreated. The healthcheck used `curl` (not in the image) against the v1 API (410) | `34663ed` |
| Postgres marked documents `ready` while Chroma had no vectors; queries then silently answered "I don't know" | `69124af` |
| BullMQ retries never ran: `defaultJobOptions` was on the Worker, so jobs had `attempts: 0` | `69124af` |
| A retry would have duplicated vectors (random IDs); verified as 424 of 212 chunks | `69124af` |
| An empty OpenAI balance (`credit_balance_exhausted`) was retried by LangChain for about 94 s | `69124af` |
| An async error in an Express 4 route (e.g. Postgres down) exited the process; reproduced with exit code 1 | `7c72e6b` |
| The Docker build failed even at baseline (`npm ci` dependency conflict), and the build context included `server/.env` | `d4f0b38` |
| README was CRA boilerplate; `server/` was untracked; uploads with personal PDFs weren't ignored | `e1a9a25`, `d4f0b38` |

**[conversation-only] Correction:** the Phase-1 audit also claimed an MCP client connection race that "fails". Live, 8 simultaneous first calls all succeeded with the old client: stdio delivers messages in order and the SDK doesn't enforce initialization. The fix in Step 2 is hardening, not a fix for an observed failure.

## 3. Steps 0–3

### Step 0: baseline, hygiene, local model stack
**Commits:** `43e5bfe`, `ec6d985`, `34663ed`, `69124af`, `2e48de6` (tag `baseline-dual`), `cc1a2f4`, `5538d1e`

**What changed:**
- **Instrumentation:** per-stage timings and token usage, returned as `meta`.
- **Clean-up:** removed dead `chat.js` and unused `pino`.
- **Chroma persistence and healthcheck** fixed.
- **Postgres/Chroma consistency:** startup checks every `ready` document against Chroma and marks drifted ones `failed`. Re-ingestion is explicit (`POST /documents/:id/reingest`); only the demo document is retried automatically, once per boot.
- **Ingestion retries** made real and idempotent (§5). Permanent provider errors fail immediately ([server/lib/errors.js](server/lib/errors.js)).
- **Runtime-independent model layer** ([server/lib/llm.js](server/lib/llm.js)) and truncation/thinking guards ([server/lib/guards.js](server/lib/guards.js)).
- **Reproducibility:** `GET /runtime` reports model digests and settings, and the eval stores it with every result.
- **`/chat?web=off`**, added to measure the document pipeline alone. Removed in Step 1 in favour of `mode=docs`.

**Why:** to measure the original design, unchanged, on a $0 local stack. The user had no OpenAI credits and is cost-sensitive.

**Results:** [§8](#8-benchmark-results-and-how-to-read-them).

### Step 1: real hybrid retrieval with typed citations
**Commits:** `0fe88b0`; results in `09be944` (tag `step1-hybrid`)

**What changed:**
- Server-side modules [server/pipeline/](server/pipeline/) and [server/search/](server/search/).
- One prompt, one LLM call, `[D#]` (page number) and `[W#]` (title and URL) sources, deduplication, and a citation check.
- SerpAPI results reduced to `{title, url, snippet, position, date}`.
- The MCP tool returns structured results and sets `isError` on failure.
- The Chroma collection handle is cached per document.
- New UI.

**Decisions:**
- No combined ranking across sources: a Chroma distance and a search rank aren't comparable.
- The fixed instructions are a separate system message, identical across requests and modes (a reusable prompt prefix).
- `SEARCH_TRANSPORT=mcp|direct`, defaulting to `mcp`, to keep a path open for future LLM-driven tool calls.

**Results:** hybrid used about 1.1k input tokens per question, against about 30k for the original web prompt (§8).

### Step 2: reliability
**Commit:** `7c72e6b` (tag `step2-reliability`)

**What changed:**
- SerpAPI is called with `fetch`. The `serpapi` npm package was removed because it hid HTTP status codes and couldn't be cancelled.
- Retries are bounded and classified by status code; time budgets are `AbortSignal`s.
- A client disconnect cancels the work.
- Hybrid falls back in both directions.
- The MCP connection is shared across concurrent callers.
- A `route()` wrapper plus an error handler.
- A `chat_requests_total` counter.
- The frontend test suite was fixed.

**Verified live** (recorded in the commit message):
- After a client disconnect, Ollama's generation ended about 1.7 s into the request.
- Postgres outage: JSON 500s, and the server stayed up.
- Search failing: answered from the document.
- Chroma down: answered from the web.

### Step 3: README and Docker
**Commits:** `d4f0b38`; then `688c442` and `e2511b0` (demo document and dataset, §9)

**What changed:**
- README rewritten as an integration guide.
- `server/.dockerignore`, so secrets and uploads stay out of the image.
- `server/.npmrc` with `legacy-peer-deps=true`, needed because of an optional `@langchain/community` peer dependency that pins an old zod.
- The compose server container reaches the host's model server via `host.docker.internal` (`DOCKER_LLM_BASE_URL` overrides it).

**Verified:** the full Docker path answered a hybrid question, and the built image contains no `.env`.

**History rewrite:** on 2026-10-19 the user rewrote history to remove the HBS PDF. Every hash changed. [server/results/COMMIT_MAP.md](server/results/COMMIT_MAP.md) maps the hashes recorded in result files to current commits.

## 4. Runtime / model setup

**Model server:** Ollama 0.33.2 on a MacBook M3 Pro, 18 GB. Recorded in every results file's `runtime`.

| | Setting |
|---|---|
| Chat model | `qa-qwen3-8b-32k`: built from `qwen3:8b` (Q4_K_M, digest `365415f081c0…`) with `num_ctx 32768` via [server/models/qwen3-8b-32k.Modelfile](server/models/qwen3-8b-32k.Modelfile) |
| Embeddings | `qwen3-embedding:0.6b` (Q8_0, digest `ac6da0dfba84…`), 1024 dimensions, unit length. Queries get `EMBEDDING_QUERY_INSTRUCTION` (`Instruct: …\nQuery:`); documents don't |
| Request settings | `LLM_TEMPERATURE=0`, `LLM_SEED=1`, `LLM_MAX_OUTPUT_TOKENS=1024`, `LLM_CONTEXT_TOKENS=32768`, `EMBEDDING_BATCH_SIZE=32` |
| Thinking off | `LLM_RUNTIME=ollama` sends `reasoning_effort: "none"`. Ollama's OpenAI-compatible endpoint ignores `think: false`. `sglang`/`vllm` would send `chat_template_kwargs.enable_thinking=false`, which is **not yet verified** |

**Important constraints** (documented in code comments and the README):
- **Ollama silently truncates over-long prompts** to `num_ctx/2 + 2` tokens. The guard in [server/lib/guards.js](server/lib/guards.js) rules truncation out only by prompt length (a prompt can't fall below 1 character per token) or, for Ollama, by a reported count above `num_ctx/2`. Otherwise it fails closed. Don't replace it with a characters-per-token heuristic: raw SerpAPI JSON tokenized at 1.72 characters per token.
- **Ollama serves one request at a time here** (`OLLAMA_NUM_PARALLEL=1`), so simultaneous requests queue.
- **Ollama doesn't report prompt-cache tokens**, so `cached_input_tokens` is `null` (not reported). That is not a measured 0.
- **Ollama fails a 212-input embedding batch**; batches of 128 work. Hence a batch size of 32.
- **Node's server `requestTimeout`** (300 s by default) is raised via `SERVER_REQUEST_TIMEOUT_MS` (default 900 s), because local prefill can be slow.
- **[conversation-only] GPU host for the future SGLang work:** RTX 4070 Ti SUPER 16 GB, Ryzen 7 7800X3D, 32 GB RAM, OS unknown (SGLang needs Linux).
  - The planned model is `Qwen/Qwen3-8B-FP8` (weights 9.44 GB). BF16 weights are 16.38 GB and don't fit in 16 GB.
  - KV cache per token is about 144 KiB in BF16, so roughly 30k tokens of cache after the weights. Estimated; SGLang reports the real `max_total_num_tokens` at startup.

## 5. Ingestion and Chroma invariants

Code: [server/ingest.js](server/ingest.js), [server/lib/queue.js](server/lib/queue.js), [server/lib/vectors.js](server/lib/vectors.js), [server/lib/reconcile.js](server/lib/reconcile.js).

**What's stored:**
- One collection per document, named by its document ID.
- Each record: ID `"<documentId>:<chunkIndex>"`, a 1024-dimension embedding, the chunk text (newlines kept; LangChain removes them only for embedding), and metadata `{ page, source, pdf }`. `page` is lifted out separately because LangChain drops `loc`; `pdf` is PDF metadata as a string that nothing uses.

**Idempotent ingestion:**
- Delete the collection, forget the cached query handle, then `addDocuments` with deterministic IDs (LangChain uses `upsert`).
- The document is marked `ready` only if Chroma's count equals the chunk count.

**Retries:**
- Configured as `defaultJobOptions` **on the Queue**: 3 attempts, exponential backoff of 3 s then 6 s.
- Permanent provider errors become `UnrecoverableError`, so the document is marked `failed` immediately.
- While a document is `processing`, `/chat` returns 409, so a partially written collection is never queried.

**Persistence:**
- The Chroma volume is mounted at `/data`.
- On startup, reconciliation marks `ready` documents whose Chroma count doesn't match as `failed`, with a reason.
- A query that retrieves 0 chunks throws `VectorsMissingError` and marks the document failed. The LangChain wrapper's `getOrCreateCollection` would otherwise silently create an empty collection.

**Known limits:**
- All chunks go to Chroma in **one** upsert, and the client rejects anything over the server's maximum batch size. [conversation-only] That maximum was 5,461 records (`/api/v2/pre-flight-checks`), roughly a 1,000+ page document.
- Exactly-one ingestion at a time is guaranteed only within a single API process (worker concurrency 1). Two API processes on the same Redis means two workers.

## 6. Pipeline and search architecture

**Modes** ([server/pipeline/answer.js](server/pipeline/answer.js)):
- The frontend always sends `mode` (UI default `hybrid`). The backend defaults to `hybrid` if `mode` is missing.
- **There's no automatic routing or intent detection.** A user writing "answer only from this PDF" in hybrid mode still triggers a web search; the instruction is just part of the question text.

**Context** ([server/pipeline/context.js](server/pipeline/context.js)):
- `[D#] (page N)` plus chunk text; `[W#] title (date)`, URL, snippet. Each list keeps its own order.
- Duplicates removed: documents by SHA-1 of the whitespace-normalized text, web results by normalized URL.
- Answers are capped at four sentences by the instructions.
- `INSTRUCTIONS_sha1` appears in `/runtime` (`prompt.instructions_sha1`).

**Citations** ([server/pipeline/citations.js](server/pipeline/citations.js)): `{total, cited, invalid, uncited}`. The answer text is never rewritten.

**Search** ([server/search/](server/search/)):
- **Provider contract:** `{name, search(query, {num, signal})}` → normalized results ([provider.js](server/search/provider.js)). `SearchProviderError{status, retryable}`.
- **Adapters:** `serpapi.js` (fetch, status-classified errors, the API key never appears in errors) and `fake.js` (`ok|empty|error|transient|hang`).
- **Retries:** `retry.js` (bounded, full jitter, abortable).
- **Selection:** `index.js` reads `SEARCH_PROVIDER`, `SEARCH_TRANSPORT`, `SEARCH_NUM_RESULTS=5`, `SEARCH_TIMEOUT_MS=8000`, `SEARCH_ATTEMPT_TIMEOUT_MS=3000`, `SEARCH_RETRIES=2`.
- **MCP:** `mcp-client.js` shares one connection, published only after `connect()` and dropped only when the transport closes. `mcp-server.js` runs retries server-side, reports the attempt count in `structuredContent` or, on errors, `_meta`, and honours MCP cancellation.
- **Querit:** a new provider is one adapter file; see the README section "Integrating a different search API". No Querit adapter exists yet, because no API docs have been provided.

## 7. Cancellation, retries, timeouts, degradation, errors

**Cancellation:**
- `abortOnDisconnect(res)` fires on the response's `close` event before the response finishes. The request's `close` isn't used: for a GET it can fire as soon as the request has been read.
- The signal goes to the search (including through MCP cancellation into the provider's `fetch`) and to the LLM `invoke`/`stream`.
- **Not cancellable:**
  - **Query embedding and the Chroma search.** They take no signal and run to completion in the background. Embeddings have `EMBEDDING_TIMEOUT_MS`; Chroma has no timeout.
  - **A SerpAPI request already sent.** It is probably still counted against the quota.
  - **Ingestion jobs.** There's no cancel endpoint.
  - **The UI has no Stop button.**

**Search:** a 3 s timeout per attempt; up to 2 retries for 429 (throughput), 5xx, timeouts and network errors; never for 401, an exhausted quota or other 4xx. The 8 s overall budget actually aborts the search.

**LLM:** `timeout`, `maxRetries=2`, permanent errors fail immediately (`onFailedAttempt`).

**Degradation in hybrid mode:**

| Situation | Result |
|---|---|
| Search fails, times out or finds nothing | Answer from documents only; `web.status` says why |
| Retrieval fails | Answer from the web only; `retrieval.status` says why |
| Both fail | 503 |
| Vectors missing | 422, and the document is marked failed (never papered over) |

**Status codes:** 400 bad input · 404 unknown document · 409 still processing · 422 ingestion failed or prompt too large · 502 web-only search failed · 503 no sources · 500 other. Every route is wrapped by `route()`.

## 8. Benchmark results and how to read them

### Step 4: GPT-4 report dataset, human-graded (the numbers to quote)

**Method** (code in [server/eval/](server/eval/), also described in the README's Evaluation section):
- [capture-contexts.js](server/eval/capture-contexts.js) ran the production `prepareContext` once per question on 2026-10-21 (commit `4c9f804`): real retrieval, one real SerpAPI search (production budgets), raw SerpAPI metadata kept. It also built **oracle** contexts (gold evidence chunks replace the lowest-ranked chunks; a reviewed web excerpt replaces the lowest-ranked web result) and a no-sources control. Output: `server/eval/frozen/contexts-2026-10-21T10-03-05-839Z.json`, **git-ignored** (report text and snippets), SHA-256 `8b9409d9517cdcf466a8f9042afeb4031a9d064803ed39a9df7b97d1b5bd7107`. Retrieval reproduces exactly (35/35 identical to the 2026-10-20 runs).
- [replay-contexts.js](server/eval/replay-contexts.js) sent the frozen hybrid prompts to Qwen3-8B Q4_K_M (commit `29963b5`, results `3b3a4a8`). Every prompt matched its frozen SHA-1. 56 calls: 35 retrieved, 21 oracle; for the other 14 the oracle prompt is identical, so the retrieved answer is reused.
- The user graded all 56 answers blind: `correct` (correct/partial/incorrect/abstained) and `grounded` (every claim supported by the sources shown). Labels with notes: [server/eval/labels/replay-2026-10-21T10-55-01-709Z.labels.json](server/eval/labels/replay-2026-10-21T10-55-01-709Z.labels.json). Scores: [server/results/replay-score-2026-10-21T10-55-01-709Z.json](server/results/replay-score-2026-10-21T10-55-01-709Z.json) (`f8a0b43`).

**Results (hybrid mode):**

| Layer | Result |
|---|---|
| 1. End-to-end (retrieved evidence) | **20/35 grounded-correct** (21 correct, 4 partial, 6 incorrect, 4 abstained) |
| 2. Retrieval (gold evidence in context) | 18 sufficient, 1 partial, 16 missing; document evidence 17/30, web 4/10 |
| 3. Generator (gold evidence present) | **26/35 grounded-correct** (29 correct, 4 partial, 2 incorrect) |

| Category | End-to-end | With gold evidence |
|---|---|---|
| doc_prose (13) | 10 | 11 |
| doc_table (8) | 4 | 8 |
| doc_undisclosed (4) | 3 | 2 |
| web (5) | 1 | 2 |
| mixed (5) | 2 | 3 |

**Diagnosis per question** (grounded-correct on retrieved vs oracle): works 19; **retrieval 7** (P10, T03, T04, T05, T06, W04, M03); **generation-or-reference 8** (P01, P06, U01, W01, W02, W03, M04, M05); oracle-worse 1 (U03).

**How to read it:**
- **Retrieval is the larger bottleneck.** Every evidence quote is stored in Chroma (the oracle found all of them); the failures are ranking. Table questions: 4/8 → 8/8 with the right chunk.
- **Generation failures are mostly source conflicts**, from the user's notes: an unofficial web figure stated as fact despite the report's "not disclosed" sentence (U01); the wrong date picked among sources (W01 May 15 vs 13; W02 Nov 7 vs 6); a web figure attributed to the report (M05); unsupported extra claims or a wrong citation (W03, U03, P01); the like-for-like improvement wording the grading notes forbid (M04); an incomplete method description (P06).
- **Abstention:** with evidence missing, Qwen abstained correctly on P10, T03, T04, but used misleading numbers when the context had them (T05 "top 10%", T06 a leaderboard's "100%", W04 a 2023 date).
- **Latency (replay, generation only):** P50 5.9 s, P95 8.5 s on retrieved contexts, ~1.2k input tokens. Capture searches: P50 0.75 s when they succeeded; P06 and P12 timed out on all three 3 s attempts.

**Caveats:**
- The layer-2 check counts only the chunk holding the dataset's evidence quote. P02, U02, U04 and M01 are "missing" by that check but grounded-correct from other evidence, so usable evidence is closer to 22/35. U02 may be right for the wrong reason (no hardware mentioned ≈ "not disclosed").
- The oracle keeps the other retrieved sources, so layer 3 is "gold evidence among noise", not clean evidence.
- One grader, n = 35, one run; a few labels are judgement calls (W02's date, M04's wording rule, W03's extra claim).
- **No other model has been run on these contexts.** Nothing here says how much GPT-4o would help.

### Step 4: the 2026-10-20 live runs (judge-graded, superseded)

[server/scripts/eval.js](server/scripts/eval.js) on commit `c239d93`, results `56069a8`: judged pass docs 30/35, web 23/35, hybrid 29/35. **The judge (the same Qwen3-8B) is too lenient**: it passed 12 of 15 abstentions in docs mode and some wrong facts, so these pass rates are not quality numbers. Page-level retrieval from those runs (MRR 0.639, R@1 0.5, R@3 0.767, R@5 0.833) overstates evidence recall; see the chunk-level 17/30 above. In web mode, 7 of 31 completed searches returned pages matching only one word of the question (e.g. "does" → does.dc.gov) and 4 timed out; the one-word results didn't recur on 2026-10-21 except T01's, which SerpAPI's metadata shows Google ranked for the full question. The judge-calibration sheet from `b796421` was never labelled; the replay labels replace it as the calibration set.

### Earlier results (HBS document, before Step 4)

All runs: the Mac setup above, the **earlier HBS demo document** (Lean Startup note, 26 pages, 212 chunks), the 10 questions in [server/scripts/eval.js](server/scripts/eval.js), one run each. Grading used the same Qwen3-8B as an LLM judge, **not calibrated against human labels**. Files are in [server/results/](server/results/); commits are mapped in COMMIT_MAP.md.

| Run (file) | Completed | Judged correct | LLM calls per question | Input tokens | Warm median latency |
|---|---|---|---|---|---|
| Original two pipelines (`06-07-34`, `baseline-dual`) | 3/10 | 3/10 | 2 | ~29.5k (web) + ~0.6k (doc) | 263–332 s (n=3) |
| Original document path only (`06-14-01`) | 10/10 | 10/10 | 1 | 542–723 | 9.8 s |
| Step 1 `docs` (`07-16-11`) | 10/10 | 8/10 | 1 | 707–890 | 7.3 s |
| Step 1 `hybrid` (`07-18-49`) | 10/10 | 10/10 | 1 | 1,036–1,235 | 7.8 s |
| Step 2 `docs` regression check (`2026-10-19T04-34`) | 10/10 | 8/10 | 1 | — | — |

**Caveats, stated exactly:**
- **Original two pipelines:** 7 of 10 failed because the raw SerpAPI JSON (50.6k–74.1k characters) exceeded the 32k context. The truncation guard caught each one (Ollama had cut them to 16,386 tokens). Because Ollama serves one request at a time, the original "parallel" paths were serialized; the document path's latency there is mostly queueing.
- **`docs` 8/10 is not a regression.** The HBS note never mentions "innovation accounting" (Q5) or "vanity/actionable metrics" (Q6); the earlier passes came from the model's own knowledge.
- **The questions are too easy** (a ceiling effect); n=10, one run, self-judged. **These numbers are not claims about answer quality.** They only show the token and latency effect of the redesign in one local environment.
- **No retrieval metrics** (recall@k, MRR) exist yet. There is no concurrency or throughput measurement.
- [conversation-only] SerpAPI may serve cached results for repeated identical queries, so search latency on repeated queries may be optimistic.

## 9. Demo document and the Step 4 dataset

**Document:** "GPT-4 Technical Report", arXiv:2303.08774**v3**; 100 pages, 682 chunks, about 71k tokens.
- **Not committed:** arXiv's non-exclusive license doesn't extend to redistribution.
- Download and verify with [server/scripts/fetch-demo-doc.sh](server/scripts/fetch-demo-doc.sh), which pins SHA-256 `a4990dde…a0f5`.
- A copy saved from the arXiv submission preview differs only in the page-1 margin stamp, so page numbers are the same.
- It's the server's `DEFAULT_DOCUMENT`. The previous HBS note is no longer in the repo or its history.

**Dataset:** [server/eval/datasets/gpt4-report.v1.json](server/eval/datasets/gpt4-report.v1.json). Status `APPROVED` (2026-10-19). 35 questions:

| Category | Count | Notes |
|---|---|---|
| `doc_prose` | 13 | |
| `doc_table` | 8 | Table columns come out glued together, so GPT-3.5 values can be swapped with GPT-4's |
| `doc_undisclosed` | 4 | Correct answer is "the report doesn't say" |
| `web` | 5 | |
| `mixed` | 5 | |

- **Fields:** `gold_pages` (1-based PDF pages), `evidence` (verbatim quotes), `needs`, `grading` notes, and `web_sources` (verified on 2026-10-19).
- **Check:** `npm run eval:validate --prefix server` verifies the PDF checksum and that every evidence quote appears on a gold page. It has been shown to fail on a wrong page.
- **[conversation-only] The user was asked to look closely at M01** (bar-exam percentiles, which differ across paper versions) **and M04** (GPT-4o's HumanEval score depends on the snapshot).
- **Contamination risk:** Qwen3-8B has probably seen this report in training. Grading must reward page-grounded citations, exact table values, and "not disclosed" answers, not just correct-sounding text. The replay grading does this with the separate `grounded` label.
- **Web evidence for the oracle:** [server/eval/datasets/gpt4-report.v1.web-evidence.json](server/eval/datasets/gpt4-report.v1.web-evidence.json), one short excerpt per web/mixed question, approved by the user on 2026-10-21. Verbatim except M04, which is transcribed from OpenAI's GPT-4o chart. `review_note` fields record known weaknesses (e.g. W02's date comes only from the result date).
- **Dataset revision history:** `f25e5b9` revised M01, M04, M05, W03 and T01 after a source review, before any answers were seen; `81f829c` approved it.

## 10. Known issues found but intentionally not fixed

Each of these changes retrieval or answer behaviour, so it should be measured in Step 4 before and after.

- **Junk chunks and repeated headers/footers.** The GPT-4 PDF produces 1-character chunks (e.g. `"9"`; 2 chunks under 16 characters). The old HBS note repeated a licensing line on many pages. Both waste top-k slots. A fix (minimum chunk content, stripping headers and footers) changes chunk IDs, so it needs re-ingestion and re-baselining.
- **The raw question is used as the search query**, with no rewriting, entity anchoring or reranking. Measured: web evidence present for 4 of 10 web/mixed questions; T01's question returns ExamSoft/ExamFX/IMDb. Document-relative phrasing ("according to the report", "the authors", "in Table 1") means nothing to a search engine.
- **Document retrieval ranks the gold chunk too low** (17/30 in top 5). Candidate fixes, unmeasured: larger top-k, larger or table-aware chunks, junk-chunk filtering, keyword (BM25) retrieval for exact values.
- **The model trusts the wrong source when sources conflict** (see §8). Candidate fix, unmeasured: instructions that prefer the document for claims about the report and label unofficial estimates.
- **The search adapter discards SerpAPI's `related_questions`.** `ai_overview` arrives only as a `page_token` and would need a second paid request.
- **No automatic routing:** every `hybrid` request searches; instructions like "only from this PDF" aren't parsed.
- **No sequential document→web retrieval:** search runs in parallel with retrieval, so it can't use facts from the document (e.g. the author's name). There's only one round of gathering sources.
- **Citation validity is not faithfulness:** the checker confirms labels exist, not that the source supports the sentence. One answer cited page 5 for "actionable metrics", but the page discusses the metrics without that word.
- **Eval judge:** the same 8B model, shown to be too lenient (§8). The layered similarity thresholds (0.6/0.85) were tuned for ada-002 and are unused (`EVAL_GRADING=judge` is the default). The 56 human replay labels are the calibration set for any replacement judge.
- **Chroma upsert ceiling** and **multiple ingestion workers across processes:** see §5.
- **Smaller items:**
  - `multer` 1.x has published vulnerabilities;
  - `benchmark.js` measures end-to-end `/chat` latency only;
  - `regenerator-runtime` is used by the frontend tests but is only a transitive dependency;
  - the `pdf` metadata string is stored on every chunk.
- **[conversation-only] Local data, not in the repo:** Postgres still has rows and Chroma has collections for HBS-era documents (e.g. `6428a0e7…`, `ready`). They're harmless but stale.

## 11. Step 4 status and next steps

**Done:** dataset approved; `eval.js` runs it with page-level retrieval metrics and P50/P95 per stage; frozen capture with oracle and no-sources variants; Qwen replay; blind human grading of all 56 answers; three-layer scores (§8). The judge calibration planned here is superseded: the replay labels are the calibration set.

**Evaluation story** agreed with the user [conversation-only]: (1) how good is the QA agent end to end; (2) if it fails, is retrieval or generation responsible; (3) only then, would a stronger model help. Layer 4 (Qwen vs GPT-4o on the same frozen evidence) is deliberately deferred.

**Next, in order** (suggested to the user on 2026-10-22; the user approved step 1):
1. **Write up Step 4** in the README and this file. Done 2026-10-22.
2. **One retrieval round**, iterating on layer 2 first (no grading needed), then grading only the winning configuration end to end:
   - document: top-k 5 → 8/10 (no re-ingestion), then chunk size / table-aware chunks / junk filtering (re-ingest and re-baseline);
   - web: a query built from the question (strip document-relative phrases, add the entity), search timeouts, optionally `related_questions`;
   - to keep grading cheap, calibrate a stronger LLM judge against the 56 human labels and spot-check it.
   - A Querit adapter, compared with SerpAPI on the same questions, would be the most role-relevant result, but needs Querit's API docs or a key.
3. **Generator fix, optional:** a source-conflict instruction tested by replaying the oracle contexts only (needs a replay option for a different system prompt; the replay currently enforces the frozen one). GPT-4o (layer 4) only on the ~9 generation-failure questions plus controls (~12–15 calls), and only if the prompt change doesn't close the gap. Needs an OpenAI key; check that the API still serves a pinned `gpt-4o` snapshot first.
4. **SGLang** (§13), independent of 2–3.

Remaining baseline experiments from the original plan, not yet done: `SEARCH_TRANSPORT=mcp` vs `direct`; concurrency with the fake provider; cold vs warm runs. Each architecture change (§12) is only justified by a measured gap; results go in `server/results/` with their commit and runtime record.

## 12. Deferred ideas: benchmark first, don't build by default

- Query rewriting (an extra LLM call) for search quality.
- Reranking (a cross-encoder), if recall@k turns out to be the limit.
- BM25 / combined keyword + vector retrieval, especially for exact table values and names.
- Smart routing (when to search, honouring "PDF only").
- Agentic or sequential retrieval (document → web multi-hop, LLM-chosen MCP tool calls). This is why MCP was kept.
- Prompt-cache layout experiments (the stable prefix exists already).
- SGLang (§13).

## 13. Future SGLang experiment

[conversation-only plan, agreed with the user] Only after the QA Agent is measured (Step 4):
1. Save workload traces that keep **the actual prompt parts** (system message, sources, question, settings), not just token counts, so SGLang can re-tokenize and replay them. **Largely done:** the frozen capture (§8) stores the system message once and every question's user prompt per mode, with prompt hashes. Still missing: request arrival times, needed to replay them as a realistic workload. `replay-contexts.js` reaches the model through the app's model settings, so pointing it at SGLang should be configuration only (`LLM_BASE_URL`, `LLM_RUNTIME=sglang`).
2. Serve `Qwen/Qwen3-8B-FP8` with SGLang on the RTX 4070 Ti SUPER via `LLM_BASE_URL` / `LLM_RUNTIME=sglang`.
3. **First verify** thinking-off and how SGLang behaves on an over-long prompt (the guard currently fails closed for `sglang`).
4. Replay the same frozen prompts for a quality-parity check against Q4_K_M (grade only answers that differ, or use a judge calibrated on the human labels).
5. Study prefix-cache hit rate, time to first token and throughput against request rate, with SGLang's prefix (radix) cache on and off and different prompt layouts, plus API vs self-hosted cost. **Expectation:** the shared prefix is only the ~650-character system message against ~1.2k-token prompts, so the cache has little to reuse in today's layout; layout experiments are where it can matter.
6. **Open question for the user:** whether the GPU machine runs Linux (SGLang needs it; otherwise WSL2 or a dual boot first).

**Never compare Mac/Ollama/Q4_K_M numbers with GPU/SGLang/FP8 numbers as an "SGLang speedup".** Hardware, quantization, runtime and batching all differ at once. Re-run the baseline on SGLang; compare only within one environment.

## 14. DO NOT accidentally change

- **Frozen baselines:**
  - Tags `baseline-dual`, `step1-hybrid`, `step2-reliability` and the committed `server/results/*.json` files. Never edit or regenerate them; add new files instead.
  - `COMMIT_MAP.md` explains the rewritten hashes.
  - `main` is the original snapshot.
- **Eval integrity:**
  - Commit **before** a run, never amend afterwards (the eval records the commit and a `dirty` flag).
  - Keep the model, embedding model, context and judge the same within any comparison.
  - Changing `EMBEDDING_MODEL`, the chunking, or anything in `ingest.js` changes vectors and chunk IDs. Re-ingest and re-baseline.
  - Don't edit dataset references after seeing system answers without recording why.
  - Don't regenerate or edit the frozen capture, the replay results, or `eval/labels/*.labels.json` (the human labels). New captures and runs get new files. `make-replay-sheet.js` refuses to overwrite a sheet.
  - Never commit `server/eval/frozen/` (report text and third-party snippets); record its SHA-256 instead.
- **Guards:**
  - Don't weaken the truncation guard or `assertNoThinking`.
  - Don't change `cached_input_tokens: null` to 0.
  - Don't reintroduce raw provider JSON into prompts.
- **Secrets and licensing:**
  - Never commit `server/.env`, uploads, or the demo PDF.
  - Never put the SerpAPI URL (it contains the key) in errors or logs.
- **Claims to avoid:**
  - Any accuracy number from the 10-question HBS set presented as quality.
  - The judge-graded 2026-10-20 pass rates presented as quality.
  - Any claim that a stronger model would or wouldn't help (no other model has been measured on these contexts).
  - "Retries with backoff" for code before `69124af`.
  - The MCP race as an observed bug fix.
  - Any SGLang speedup across environments.
  - SGLang/vLLM support as "verified".
  - Querit support (no adapter exists).

## 15. Useful commands

```bash
sh server/scripts/fetch-demo-doc.sh
```
```bash
ollama create qa-qwen3-8b-32k -f server/models/qwen3-8b-32k.Modelfile
```
```bash
npm test --prefix server
```
```bash
npm run eval:validate --prefix server
```

Run the eval from `server/`, with the API running:

```bash
EVAL_MODE=hybrid node scripts/eval.js --documentId=<id>
```

Step 4 pipeline from `server/` (capture needs Chroma and the embedding model; replay needs the chat model):

```bash
node eval/capture-contexts.js --documentId=<id>
```
```bash
node eval/replay-contexts.js --frozen=eval/frozen/contexts-<ts>.json
```
```bash
node eval/make-replay-sheet.js --replay=results/replay-<ts>.json
```
```bash
node eval/score-replay.js --sheet=eval/frozen/labels/replay-<run>.csv
```

Fault testing from `server/`, with no search quota spent:

```bash
SEARCH_PROVIDER=fake FAKE_SEARCH_MODE=transient PORT=5002 node server.js
```
