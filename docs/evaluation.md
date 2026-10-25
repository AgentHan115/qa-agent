# Evaluation

How the QA agent is measured, and every result so far. The README has the summary.

**Dataset:** [server/eval/datasets/gpt4-report.v1.json](../server/eval/datasets/gpt4-report.v1.json), 35 questions about the GPT-4 Technical Report, reviewed and approved by hand. Each document question has gold pages and a verbatim evidence quote; `npm run eval:validate --prefix server` checks every quote against the PDF.

| Category | Questions | Where the answer is |
|---|---|---|
| `doc_prose` | 13 | the report's text |
| `doc_table` | 8 | a table in the report (columns come out glued together) |
| `doc_undisclosed` | 4 | the report says it withholds this (model size, hardware, compute, data) |
| `web` | 5 | only on the web (after March 2023) |
| `mixed` | 5 | one part in the report, one part on the web |

## Three questions, measured separately

1. **End-to-end:** with the evidence the system actually retrieves, does the answer match the reference?
2. **Retrieval:** was the gold evidence in that context at all?
3. **Generator:** with the gold evidence guaranteed present, does the model answer correctly?

How it's measured, from `server/`:

1. **Capture** every question's prompts once ([eval/capture-contexts.js](../server/eval/capture-contexts.js)). This runs the production `prepareContext` with real retrieval and one real search, then builds an **oracle** variant: chunks containing each evidence quote replace the lowest-ranked retrieved chunks, and a reviewed excerpt ([web-evidence file](../server/eval/datasets/gpt4-report.v1.web-evidence.json)) replaces the lowest-ranked web result. Raw SerpAPI metadata is kept; the output is git-ignored because it contains report text.
2. **Replay** the frozen prompts to the model ([eval/replay-contexts.js](../server/eval/replay-contexts.js)). Each prompt must match its recorded SHA-1, and nothing is retrieved or searched again.
3. **Grade blind** by hand ([eval/make-replay-sheet.js](../server/eval/make-replay-sheet.js)): `correct` (correct / partial / incorrect / abstained) and `grounded` (every claim supported by the sources shown; a true fact from the model's memory counts as ungrounded).
4. **Score** ([eval/score-replay.js](../server/eval/score-replay.js)). The headline metric is **grounded-correct**: correct and grounded.

```bash
node eval/capture-contexts.js --documentId=<id>
```
```bash
node eval/replay-contexts.js --frozen=eval/frozen/contexts-<ts>.json
```
```bash
node eval/score-replay.js --sheet=eval/frozen/labels/replay-<run>.csv
```

## Results (2026-10-21, hybrid mode)

Qwen3-8B Q4_K_M on Ollama 0.33.2 (MacBook M3 Pro 18 GB), Qwen3-Embedding-0.6B, top-5 chunks, 500-character chunks. One capture, one run, 56 answers graded by one person. Results: [replay](../server/results/replay-2026-10-21T10-55-01-709Z.json), [scores](../server/results/replay-score-2026-10-21T10-55-01-709Z.json), [labels](../server/eval/labels/replay-2026-10-21T10-55-01-709Z.labels.json).

| Layer | Result |
|---|---|
| **1. End-to-end** (retrieved evidence) | **20/35 grounded-correct** (21/35 correct) |
| **2. Retrieval** (gold evidence in the retrieved context) | 18/35 sufficient, 1 partial, 16 missing; document evidence 17/30, web evidence 4/10 |
| **3. Generator** (gold evidence present) | **26/35 grounded-correct** (29/35 correct) |

| Category | End-to-end | With gold evidence |
|---|---|---|
| `doc_prose` (13) | 10 | 11 |
| `doc_table` (8) | 4 | **8** |
| `doc_undisclosed` (4) | 3 | 2 |
| `web` (5) | 1 | 2 |
| `mixed` (5) | 2 | 3 |

**Per question:** 19 work end to end. **7 fail because of retrieval** (P10, T03, T04, T05, T06, W04, M03): wrong with the retrieved evidence, grounded-correct with the gold evidence. **8 fail even with the gold evidence** (P01, P06, U01, W01, W02, W03, M04, M05), and in 1 the extra evidence made the answer worse (U03).

What this shows:
- **Retrieval is the larger bottleneck.** Every evidence quote is stored in Chroma; the failures are ranking (the right chunk isn't in the top 5), not ingestion. Table questions go from 4/8 to 8/8 with the right chunk.
- **The model's failures are mostly source conflicts:** stating an unofficial web figure as fact even with the report's "not disclosed" sentence in context (U01), picking the wrong date when sources disagree (W01, W02), attributing a web figure to the report (M05), or adding unsupported claims (W03, U03).
- **With evidence missing, Qwen abstained correctly on P10, T03 and T04**, but used misleading numbers instead of abstaining when the context offered them (T05, T06, W04).
- **Latency:** generation P50 5.9 s, P95 8.5 s on retrieved contexts; about 1.2k input tokens per question. Searches that succeeded took P50 0.75 s; 2 of 35 timed out against the 3 s per-attempt limit.

Caveats:
- **The layer-2 check is strict:** it only counts the chunk holding the dataset's evidence quote. Four questions it calls "missing" were answered correctly and grounded from other chunks (P02, U02, U04, M01), so usable evidence is closer to 22/35.
- **The oracle adds the gold evidence but leaves the other sources in place**, so layer 3 measures the model with gold evidence among noise.
- **One grader, n = 35, one run.** A few labels are judgement calls (noted per answer in the labels file).
- **No other model has been measured on these contexts**, so these results don't say how much a stronger model would help.
- **The rubric was clarified afterwards** ([labels README](../server/eval/labels/README.md), `e9cfa7e`): a missing number makes an answer partial. Re-graded under it, the same 35 answers score **16/35** grounded-correct ([labels](../server/eval/labels/regrade-2026-10-21T10-55-01-709Z-vs-2026-10-22T23-23-42-097Z.labels.json)); the first labels are kept unchanged. Compare later runs with 16, not 20.

## Retrieval round (2026-10-22)

Layer 2 first, with no grading needed: share of the 30 document questions whose evidence chunk is in the context ([sweep](../server/results/retrieval-sweep-2026-10-22T10-05-24-622Z.json), [eval/retrieval-sweep.js](../server/eval/retrieval-sweep.js)):

| Retriever | k = 5 | k = 8 |
|---|---|---|
| Vector (production) | 17 | 20 (flat up to k = 20) |
| BM25 | 20 | 21 |
| Reciprocal rank fusion | 19 | 20 |
| Interleave vector + BM25 | 21 | 24 |
| **Vector top-5 + BM25 top-3** (the candidate) | | **23** |

The candidate keeps the production chunks and adds BM25's best three. It was captured and replayed end to end ([replay](../server/results/replay-2026-10-22T23-23-42-097Z.json), [comparison](../server/results/compare-2026-10-21-vs-2026-10-22-vector5-bm25-3.txt)). A determinism check re-ran 5 baseline prompts and reproduced all 5 answers exactly.

The decision rule, set before the run: adopt only with net ≥ +2 grounded-correct and ≤ 1 regression.
- **First grading:** 20 → 19, net −1, not adopted.
- **Independent re-grade of both sides under the clarified rubric:** 16 → **19**, gaining P10, T03, U04 and M01 and losing U03. Net +3, so the rule is met.
- **Still not shipped:** on T04 the baseline abstained, but the candidate's extra chunk (p. 28, Table 8: base vs post-RLHF model on multiple-choice questions) led it to report 66.7% and 57.8% as AP Calculus results. A fabrication is worse than an abstention, so the change waits for a precision fix (table-aware chunks or a reranker).
- **Five questions miss with every retriever** (P06, T04, T06, U01, U03).

## SGLang on a consumer GPU (2026-10-24)

Same frozen prompts, served by SGLang 0.5.21 with `Qwen/Qwen3-8B-FP8` (revision `220b46e`) on an RTX 4070 Ti SUPER 16 GB under WSL2. The app stays on the Mac and reaches the GPU through an SSH tunnel; the round trip is about 7–9 ms.

**Quality parity:** the 35 retrieved prompts of the 2026-10-21 capture were replayed and graded blind under the clarified rubric ([replay](../server/results/replay-2026-10-24T08-59-50-394Z.json), [scores](../server/results/replay-score-2026-10-24T08-59-50-394Z.json)). The result is **15/35 grounded-correct**, against 16/35 for the Mac's Q4_K_M answers re-graded under the same rubric.
- **34 of 35 questions get the same outcome.** P13 is the exception: the FP8 model added a web claim its cited snippet doesn't support.
- **Only 4 of 35 answers are word-for-word identical**, so the two quantizations write differently but are right or wrong on the same questions.

**Load test** ([eval/bench-runtime.js](../server/eval/bench-runtime.js), results with the radix cache [on](../server/results/bench-sglang-radix-on-2026-10-24T09-40-43-086Z.json) and [off](../server/results/bench-sglang-radix-off-2026-10-24T09-45-33-936Z.json)):
- **Workload:** the 35 retrieved prompts, about 1.2k tokens each, `max_tokens` 1,024, answers about 70 tokens at the median.
- **Method:** a closed loop of c clients, 2 passes per level, with the prefix cache flushed before each pass. 700 requests, 0 errors.

| Concurrency | TTFT p50 / p95 | TPOT p50 | Requests/s | Output tokens/s |
|---|---|---|---|---|
| 1 | 139 / 198 ms | 17 ms | 0.69 | 52 |
| 2 | 166 / 236 ms | 18 ms | 1.33 | 99 |
| 4 | 176 / 543 ms | 21 ms | 2.27 | 166 |
| 8 | 221 / 856 ms | 28 ms | 3.24 | 241 |
| 16 | 2,069 / 3,837 ms | 29 ms | 3.43 | 262 |

(Radix cache on. TTFT is time to first token; TPOT is time per output token after the first.)

What this shows:
- **Throughput saturates at about 8 concurrent requests.** From c = 8 to 16, throughput grows 6% while TTFT grows almost 10×.
  - The server never ran more than 9 requests at once, and KV use peaked at 69%. SGLang reserves decode room for each request's `max_tokens` (1,024) before admitting it, so the rest queue.
  - **Lowering the cap to 256 tokens** (no answer here is longer than 140) let the server run 12–14 requests at once, with KV use peaking at 90% ([results](../server/results/bench-sglang-radix-on-max256-2026-10-25T05-22-55-828Z.json)).
    - At c = 16: TTFT p50 2,069 → 925 ms, p95 3,837 → 2,754 ms, requests/s 3.43 → 4.02.
    - The cost is TPOT 29 → 35 ms, because batches are bigger.
    - At c ≤ 8 nothing changed, because nothing queued.
    - The production cap stays at 1,024. A lower one would need a measured answer-length distribution and a policy for cut-off answers.
- **The radix cache helps a little, because little is shared.** Only the system message is common to all prompts: 16.6% of prompt tokens came from the cache.
  - TTFT p50 drops 8–24% (c = 1: 164 → 139 ms; c = 8: 292 → 221 ms; c = 16: 2,587 → 2,069 ms).
  - Requests/s rise 3–8% (c = 16: 3.17 → 3.43).
- **Greedy output is not batch-invariant.** At c = 1 every answer repeated exactly across passes (35/35); at c = 8–16, only 19–27 of 35 did.
  - Prefix-cache state and the server's own configuration also change outputs, so the graded SGLang answers are one sample.
  - SGLang has an `--enable-deterministic-inference` mode; its cost hasn't been measured.

Server workarounds needed on this setup:
- **FlashInfer's kernels fail to compile** (the CUDA headers bundled with PyTorch's CUDA 13 wheels don't match), so the runs use `--attention-backend triton --sampling-backend pytorch`.
- **`CUDA_HOME` must point at the pip-installed CUDA** (`site-packages/nvidia/cu13`), with the venv's `bin` on `PATH`, plus `lib64` and `libcudart.so` symlinks there.
- **Tunnel to `127.0.0.1`, not `localhost`.** On Windows, `localhost` resolves to `::1` and misses WSL's port forwarding.
- **Don't use `/health` to measure latency:** it runs a test generation and takes about 1 s.

These numbers come from one GPU, one model and one run per setting: treat them as directional. Don't compare them with the Mac/Ollama latencies above, because hardware, quantization, runtime and batching all differ.

## Earlier results

[scripts/eval.js](../server/scripts/eval.js) runs the dataset live through `/chat` and grades with an LLM judge. Its 2026-10-20 runs ([docs](../server/results/eval-2026-10-20T00-56-34-170Z.json), [web](../server/results/eval-2026-10-20T01-07-20-397Z.json), [hybrid](../server/results/eval-2026-10-20T01-20-53-949Z.json)) used the same Qwen3-8B as judge, which turned out **too lenient to trust**: it passed most "I don't know" answers and some wrong facts. Their judged pass rates (30/35, 23/35, 29/35) are not quality numbers. The retrieval metrics and latencies in those files are still valid.

The first runs used the **earlier demo document** (an HBS teaching note on the Lean Startup, removed because its license didn't allow redistribution) and 10 easy questions. They show the effect of the redesign on prompt size and latency, not answer quality:

| Run | Requests completed | LLM calls per question | Input tokens per question | Median latency (warm) |
|---|---|---|---|---|
| Original design: two pipelines, two answers ([`baseline-dual`](../server/results/eval-2026-10-18T06-07-34-126Z.json)) | 3/10 | 2 | ~29.5k (web) + ~0.6k (doc) | 263–332 s (all 3) |
| `hybrid` mode after the redesign ([results](../server/results/eval-2026-10-18T07-18-49-182Z.json)) | 10/10 | 1 | 1,036–1,235 | 7.8 s |

The original design sent SerpAPI's raw JSON to the model, 50–74k characters per question, which exceeded the 32k context for 7 of 10 questions; the truncation guard caught each one.

These numbers come from one local machine. Don't compare them with measurements from a different model server or GPU.
