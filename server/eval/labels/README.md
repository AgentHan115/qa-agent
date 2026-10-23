# Judge calibration labels (superseded)

This sheet was never labelled. The human replay labels below replaced it as the calibration set for any LLM judge.

`judge-calibration-v1.csv` holds 22 answers from the 2026-10-20 runs (docs, web and hybrid), in shuffled order. Fill in `human_label` with `pass` or `fail` for each row, and use `notes` for anything worth recording.

**Criterion.** Use the same question the judge was given: does the answer convey the reference's key facts without contradicting it, and does it satisfy the grading notes? Different wording is fine. Grade the answer itself, not how hard the question was in that mode. A "the sources don't say" answer to a question whose reference contains a fact is a `fail`, even in a mode that couldn't reach that fact. (Whether abstaining was the *right behaviour* in that mode is a separate question for later.) `mode` and `cited_sources` are there for context only.

**Don't open `judge-calibration-v1.key.json` until you're done.** It contains the judge's verdicts and the reason each row was picked.

Then, from `server/`:

```bash
node eval/judge-agreement.js
```

The sample has two strata, and the script reports them separately:

- **`suspected`** (12): answers picked by hand as likely judge errors. They show whether those suspicions hold up, not how accurate the judge is overall.
- **`random`** (10): a seeded draw of two per category, spread across modes. This is the estimate of judge agreement, at n=10.

The judge failed only 2 of the 22 rows, so this sample says little about how often the judge fails a good answer.

# Replay labels (end-to-end, retrieval and generator)

`eval/make-replay-sheet.js` writes one row per distinct answer from a frozen-context replay. The sheet itself is in `eval/frozen/labels/` (git-ignored), because each row shows the sources the model saw: report text and search snippets. Rows are shuffled across questions, and the sheet doesn't say whether a row's sources were what retrieval found or the oracle evidence.

Fill in two columns per row:

- **`correct`**: `correct`, `partial`, `incorrect` or `abstained`, judged against the reference and grading notes.
  - `partial` covers multi-part answers that get only some parts, and answers that are right but incomplete.
  - `abstained` means the answer says it doesn't know or that the sources don't say, without giving a wrong answer.
  - For "not disclosed" questions, stating that the report doesn't disclose it is an answer (usually `correct`), not an abstention.
- **`grounded`**: `yes` if every factual claim in the answer is supported by `sources_the_model_saw`. Otherwise `no`, even if the claim is true: a correct fact from the model's memory is `no`. A pure abstention is `yes`.

Use `notes` for anything else (e.g. "reference may be wrong", "cites the right source for the wrong claim").

## Rubric clarifications (added 2026-10-23)

The two grading sessions of 2026-10-21 and 2026-10-22 were done without these rules, and they resolved two cases differently (P07, P09, P04). From the side-by-side re-grade on, apply both:

- **How complete `correct` must be.** `correct` means every key fact in the reference is present, **including specific numbers the reference gives** (e.g. ECE 0.007 → 0.074). `partial` means the core answer is right but a key fact, number or required part is missing. Caveats or details the question didn't ask for don't count against an answer, unless the grading notes say they do.
- **What `grounded` is judged against.** Judge against **all** the sources shown, regardless of which label the answer cites. A claim supported by one source but cited to another is still grounded; record the wrong citation in `notes` (e.g. "claim from D5, cited D3").

# Side-by-side re-grade

`eval/make-regrade-sheet.js` puts the baseline ("before") and changed ("after") answers for the same questions in one row each, to apply one rubric to both versions at once. The sources both saw are shown once; the sources only one side saw (e.g. added BM25 chunks) get their own column. Fill in `correct_before`, `grounded_before`, `correct_after`, `grounded_after` (same values and rules as above) and `notes`. The two `first_grading_*` columns show the earlier labels for reference; hide them while grading if you'd rather not be anchored. The sheet isn't blind, and it's written to the git-ignored `eval/frozen/labels/` because it shows source text.

Don't open the key file (`eval/labels/replay-<run>.key.json`) until you're done. Then, from `server/`:

```bash
node eval/score-replay.js --sheet=eval/frozen/labels/replay-<run>.csv
```

It reports layer 1 (end-to-end, retrieved contexts), layer 2 (whether the gold evidence was in the retrieved context; needs no labels), layer 3 (generator, oracle contexts) and a per-question diagnosis. It also saves your labels, without the source text, to `eval/labels/replay-<run>.labels.json` so they can be committed.
