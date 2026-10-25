# Grading labels

Human labels for the frozen-context replays: how to grade, and how the sheets are scored. Sheets that show source text are written to the git-ignored `eval/frozen/labels/`; only labels, keys and notes are committed here.

## Replay labels (end-to-end, retrieval and generator)

`eval/make-replay-sheet.js` writes one row per distinct answer from a frozen-context replay. The sheet itself is in `eval/frozen/labels/` (git-ignored), because each row shows the sources the model saw: report text and search snippets. Rows are shuffled across questions, and the sheet doesn't say whether a row's sources were what retrieval found or the oracle evidence.

Fill in two columns per row:

- **`correct`**: `correct`, `partial`, `incorrect` or `abstained`, judged against the reference and grading notes.
  - `partial` covers multi-part answers that get only some parts, and answers that are right but incomplete.
  - `abstained` means the answer says it doesn't know or that the sources don't say, without giving a wrong answer.
  - For "not disclosed" questions, stating that the report doesn't disclose it is an answer (usually `correct`), not an abstention.
- **`grounded`**: `yes` if every factual claim in the answer is supported by `sources_the_model_saw`. Otherwise `no`, even if the claim is true: a correct fact from the model's memory is `no`. A pure abstention is `yes`.

Use `notes` for anything else (e.g. "reference may be wrong", "cites the right source for the wrong claim").

### Rubric clarifications (added 2026-10-23)

The two grading sessions of 2026-10-21 and 2026-10-22 were done without these rules, and they resolved two cases differently (P07, P09, P04). From the side-by-side re-grade on, apply both:

- **How complete `correct` must be.** `correct` means every key fact in the reference is present, **including specific numbers the reference gives** (e.g. ECE 0.007 → 0.074). `partial` means the core answer is right but a key fact, number or required part is missing. Caveats or details the question didn't ask for don't count against an answer, unless the grading notes say they do.
- **What `grounded` is judged against.** Judge against **all** the sources shown, regardless of which label the answer cites. A claim supported by one source but cited to another is still grounded; record the wrong citation in `notes` (e.g. "claim from D5, cited D3").

## Side-by-side re-grade

`eval/make-regrade-sheet.js` puts the baseline ("before") and changed ("after") answers for the same questions in one row each, to apply one rubric to both versions at once. The sources both saw are shown once; the sources only one side saw (e.g. added BM25 chunks) get their own column. Fill in `correct_before`, `grounded_before`, `correct_after`, `grounded_after` (same values and rules as above) and `notes`. The two `first_grading_*` columns show the earlier labels for reference; hide them while grading if you'd rather not be anchored. The sheet isn't blind, and it's written to the git-ignored `eval/frozen/labels/` because it shows source text.

Don't open the key file (`eval/labels/replay-<run>.key.json`) until you're done. Then, from `server/`:

```bash
node eval/score-replay.js --sheet=eval/frozen/labels/replay-<run>.csv
```

It reports layer 1 (end-to-end, retrieved contexts), layer 2 (whether the gold evidence was in the retrieved context; needs no labels), layer 3 (generator, oracle contexts) and a per-question diagnosis. It also saves your labels, without the source text, to `eval/labels/replay-<run>.labels.json` so they can be committed.

A filled side-by-side sheet is saved the same way, into its own file next to the first labels, with `eval/save-regrade.js`.
