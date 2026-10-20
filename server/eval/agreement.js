// Helpers for eval/judge-agreement.js, kept separate so they can be tested.

// RFC 4180 CSV: quoted fields may contain commas, quotes ("") and newlines.
// Accepts \n or \r\n line endings and a leading UTF-8 BOM.
export const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

export const parseLabel = (raw) => {
  const v = raw.trim().toLowerCase();
  if (["pass", "p", "y", "yes", "1", "true"].includes(v)) return true;
  if (["fail", "f", "n", "no", "0", "false"].includes(v)) return false;
  return null;
};

// Raw agreement and Cohen's kappa between judge_passed and human_passed.
export const agreementStats = (rows) => {
  const n = rows.length;
  const agree = rows.filter((r) => r.judge_passed === r.human_passed).length;
  const judgePassHumanFail = rows.filter((r) => r.judge_passed && !r.human_passed).length;
  const judgeFailHumanPass = rows.filter((r) => !r.judge_passed && r.human_passed).length;
  if (!n) return { n, agree, judgePassHumanFail, judgeFailHumanPass, kappa: null };
  const pj = rows.filter((r) => r.judge_passed).length / n;
  const ph = rows.filter((r) => r.human_passed).length / n;
  const expected = pj * ph + (1 - pj) * (1 - ph);
  const observed = agree / n;
  // Undefined when both raters give one label to everything.
  const kappa = expected === 1 ? null : Math.round(((observed - expected) / (1 - expected)) * 1000) / 1000;
  return { n, agree, judgePassHumanFail, judgeFailHumanPass, kappa };
};
