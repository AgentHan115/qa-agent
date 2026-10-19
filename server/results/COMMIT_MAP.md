# Commit hashes in these results

On 2026-10-19 git history was rewritten to remove a previously committed PDF
(`server/uploads/hbs-lean-startup.pdf`, a licensed HBS teaching note). Every
commit hash changed. The `git.commit` field in the result files records the
hash **at the time of the run**. Map it to the current history like this:

| Result file | Recorded commit | Current commit | Tag |
|---|---|---|---|
| eval-2026-10-18T06-07-34-126Z.json | 68f02f6 | 2e48de6 | `baseline-dual` |
| eval-2026-10-18T06-14-01-156Z.json | a990933 | cc1a2f4 | |
| eval-2026-10-18T07-16-11-627Z.json | e61bff4 | 0fe88b0 | (`step1-hybrid` = 09be944, results commit on top) |
| eval-2026-10-18T07-18-49-182Z.json | e61bff4 | 0fe88b0 | |
| eval-2026-10-19T04-34-55-261Z.json | 2dbdb33 | 7c72e6b | `step2-reliability` |

`2dbdb33` was a temporary WIP commit that was amended before it entered
history. Its code tree was identical to `7c72e6b`'s apart from this results
file, which was checked at the time.

Full mapping (old → new):

```
525fa8f -> 525fa8f   216510c -> e1a9a25   f3252e8 -> 43e5bfe   223c4b2 -> ec6d985
9c39e12 -> 34663ed   28bf142 -> f5079b3   4c69c4f -> 69124af   68f02f6 -> 2e48de6
a990933 -> cc1a2f4   e471d6a -> 5538d1e   e61bff4 -> 0fe88b0   16d284f -> 09be944
329f27a -> 7c72e6b   3290631 -> d4f0b38
```
