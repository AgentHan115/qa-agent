// CSV parsing for the grading sheets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../eval/csv.js";

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
