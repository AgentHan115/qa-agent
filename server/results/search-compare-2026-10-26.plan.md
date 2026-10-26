# Search API comparison: plan and decision rules (written before grading)

Written 2026-10-26, after the captures and the search-only numbers
([search-compare-2026-10-26.json](search-compare-2026-10-26.json)) and before any answer was generated or graded.

## Arms

All three use the same 35 questions, document retrieval (vector top-5, byte-identical document prompts), system prompt and model. They differ only in the web results.

| Arm | Frozen capture | Web results |
|---|---|---|
| `serpapi@500` | `contexts-2026-10-26-serpapi.json` | SerpAPI (Google), live, snippets capped at 500 chars (production default) |
| `querit@500` | `contexts-2026-10-26-querit.json` | Querit, live, same cap; captured within the same hour |
| `querit@1500` | `contexts-2026-10-26-querit-1500.json` | the same Querit responses re-mapped from the recorded raw bodies at a 1,500-char cap (`--rebuild-web`); rebuilding at 500 reproduces `querit@500` exactly (35/35) |

## Procedure

1. Replay the 35 `retrieved` hybrid prompts of each arm (105 calls) to Qwen3-8B-FP8 on SGLang (same server settings as the 2026-10-24 runs), with every prompt's SHA-1 checked.
2. One blind sheet of all 105 answers, shuffled across arms and questions. The sheet doesn't say which arm a row came from; a separate key does.
3. One person grades with the replay rubric in `eval/labels/README.md`, including the 2026-10-23 clarifications: `correct` (correct / partial / incorrect / abstained) and `grounded` (every claim supported by the sources shown).
4. Primary metric: **grounded-correct** (correct and grounded), per arm, out of 35.

## Decision rules

The same rule as the retrieval round: a change wins only with **net ≥ +2 grounded-correct and ≤ 1 regression** (a question grounded-correct before and not after).

- **Provider:** `querit@500` vs `serpapi@500`. If the rule is met, Querit is the better default for this workload. If neither direction meets it, the result is "no measurable quality difference at n = 35", and the choice rests on the search-only measures (cost, latency, source mix, failures).
- **Snippet cap:** `querit@1500` vs `querit@500`. If the rule is met, 1,500 is the better Querit setting, reported together with its prompt-token and generation-time cost. Otherwise 500 stays.

Also reported, without changing the decisions:
- the web and mixed subset (10 questions) separately: directional only at this size;
- median input tokens and generation time per arm (generation time on SGLang only, never compared with the Mac);
- per-question gains and losses with the grader's notes.

## Known limits

- n = 35 (10 that need the web), one capture day, one grader, one run per arm.
- Search results change from day to day (e.g. SerpAPI's web evidence was 4/10 on 2026-10-21 and 5/10 on 2026-10-26).
- Querit's `page_age` is passed through as the result date; it can be a last-modified time, and many values are 16:00Z (midnight UTC+8), so a UTC date can be a day early.
