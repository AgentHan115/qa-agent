// CSV parsing and judge-agreement statistics for eval/judge-agreement.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agreementStats, parseCsv, parseLabel } from "../eval/agreement.js";

test("parseCsv handles quotes, embedded commas and newlines, CRLF and a BOM", () => {
  const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,,3\n';
  assert.deepEqual(parseCsv(text), [
    ["a", "b", "c"],
    ["x, y", 'say "hi"', "line1\nline2"],
    ["1", "", "3"],
  ]);
});

test("parseCsv keeps a final row without a trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("parseLabel accepts common spellings and rejects others", () => {
  assert.equal(parseLabel(" PASS "), true);
  assert.equal(parseLabel("f"), false);
  assert.equal(parseLabel("y"), true);
  assert.equal(parseLabel("0"), false);
  assert.equal(parseLabel("maybe"), null);
});

test("agreementStats computes agreement, error directions and kappa", () => {
  const r = (judge_passed, human_passed) => ({ judge_passed, human_passed });
  // Judge passes everything; human passes half: observed 0.5, expected 0.5, kappa 0.
  const s = agreementStats([r(true, true), r(true, false), r(true, true), r(true, false)]);
  assert.deepEqual(s, { n: 4, agree: 2, judgePassHumanFail: 2, judgeFailHumanPass: 0, kappa: 0 });
  // Perfect agreement with both labels present: kappa 1.
  assert.equal(agreementStats([r(true, true), r(false, false)]).kappa, 1);
  // Everyone says pass: kappa undefined.
  assert.equal(agreementStats([r(true, true), r(true, true)]).kappa, null);
  assert.equal(agreementStats([]).n, 0);
});
