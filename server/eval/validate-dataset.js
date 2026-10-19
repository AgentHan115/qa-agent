// Checks an eval dataset against its source PDF:
//   - the PDF's SHA-256 matches the dataset (page numbers refer to that file)
//   - every evidence quote appears on at least one of the question's gold pages
//   - evidence that also appears on pages not listed as gold is reported
//     (possible missing gold pages, which would understate retrieval recall)
//   - ids are unique and fields are valid
//
//   node eval/validate-dataset.js eval/datasets/gpt4-report.v1.json uploads/gpt-4.pdf

import { readFileSync } from "fs";
import { createHash } from "crypto";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";

const [datasetPath, pdfPath] = process.argv.slice(2);
if (!datasetPath || !pdfPath) {
  console.error("Usage: node eval/validate-dataset.js <dataset.json> <document.pdf>");
  process.exit(1);
}

const CATEGORIES = ["doc_prose", "doc_table", "doc_undisclosed", "web", "mixed"];
const NEEDS = ["doc", "web", "both"];

// PDF text extraction is erratic about spaces (table columns are glued
// together), so compare with all whitespace removed.
const squash = (s) => s.toLowerCase().replace(/\s+/g, "");

const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const errors = [];
const warnings = [];

const sha = createHash("sha256").update(readFileSync(pdfPath)).digest("hex");
if (sha !== dataset.document.sha256) {
  errors.push(`PDF sha256 ${sha} doesn't match the dataset's ${dataset.document.sha256}`);
}

const pages = (await new PDFLoader(pdfPath).load()).map((d) => squash(d.pageContent));
const pagesContaining = (text) => pages.flatMap((p, i) => (p.includes(squash(text)) ? [i + 1] : []));

const seen = new Set();
for (const q of dataset.questions) {
  const where = `${q.id}:`;
  if (seen.has(q.id)) errors.push(`${where} duplicate id`);
  seen.add(q.id);
  if (!CATEGORIES.includes(q.category)) errors.push(`${where} unknown category ${q.category}`);
  if (!NEEDS.includes(q.needs)) errors.push(`${where} unknown needs ${q.needs}`);
  if (!q.question || !q.reference) errors.push(`${where} missing question or reference`);
  if (q.needs !== "web" && !q.gold_pages?.length) errors.push(`${where} needs the document but has no gold pages`);
  if (q.needs === "web" && q.gold_pages?.length) errors.push(`${where} web-only but lists gold pages`);
  if (q.needs !== "doc" && !q.web_sources?.length) warnings.push(`${where} needs the web but cites no web source`);

  for (const text of q.evidence ?? []) {
    const found = pagesContaining(text);
    if (!found.some((p) => q.gold_pages.includes(p))) {
      errors.push(`${where} evidence not found on gold pages ${JSON.stringify(q.gold_pages)} (found on ${JSON.stringify(found)}): "${text}"`);
    }
    const extra = found.filter((p) => !q.gold_pages.includes(p));
    if (extra.length) warnings.push(`${where} evidence also on non-gold pages ${JSON.stringify(extra)}: "${text}"`);
  }
  if (q.needs !== "web" && !q.evidence?.length) warnings.push(`${where} no evidence quote to verify its gold pages`);
}

const counts = dataset.questions.reduce((acc, q) => ((acc[q.category] = (acc[q.category] ?? 0) + 1), acc), {});
console.log(`${dataset.questions.length} questions`, counts);
for (const w of warnings) console.log(`warning ${w}`);
for (const e of errors) console.log(`ERROR   ${e}`);
console.log(errors.length ? `\n${errors.length} error(s)` : "\nAll gold pages verified against the PDF.");
process.exit(errors.length ? 1 : 0);
