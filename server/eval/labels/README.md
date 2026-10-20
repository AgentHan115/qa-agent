# Judge calibration labels

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
