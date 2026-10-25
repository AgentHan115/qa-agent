// Latency benchmark — hits GET /chat 20 times and reports p50/p95/min/max.
//
// Usage:
//   node scripts/benchmark.js --documentId=<uuid>
//
// Optional:
//   SERVER_URL=http://localhost:5001  (default)
//   RUNS=20                           (default)
//   QUESTION="..."                    (default: P01 of the GPT-4 report dataset)

import dotenv from "dotenv";
dotenv.config();

const SERVER_URL = process.env.SERVER_URL || "http://localhost:5001";
const RUNS = parseInt(process.env.RUNS || "20", 10);
const QUESTION =
  process.env.QUESTION || "According to the report, when does most of GPT-4's pre-training data cut off?";

const arg = process.argv.find((a) => a.startsWith("--documentId="));
if (!arg) {
  console.error("Usage: node scripts/benchmark.js --documentId=<uuid>");
  process.exit(1);
}
const documentId = arg.split("=")[1];

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`\nBenchmark — ${RUNS} runs`);
console.log(`Question: "${QUESTION}"`);
console.log(`DocumentId: ${documentId}`);
console.log(`Server: ${SERVER_URL}\n`);
console.log("─".repeat(48));

const url = `${SERVER_URL}/chat?question=${encodeURIComponent(QUESTION)}&documentId=${documentId}`;
const latencies = [];
const errors = [];

for (let i = 1; i <= RUNS; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(url);
    const ms = Date.now() - t0;
    if (!res.ok) {
      errors.push({ run: i, status: res.status });
      console.log(`Run ${String(i).padStart(2)}: ERROR  HTTP ${res.status}`);
    } else {
      latencies.push(ms);
      console.log(`Run ${String(i).padStart(2)}: ${ms}ms`);
    }
  } catch (err) {
    const ms = Date.now() - t0;
    errors.push({ run: i, error: err.message });
    console.log(`Run ${String(i).padStart(2)}: ERROR  ${err.message}`);
  }
}

console.log("─".repeat(48));

if (latencies.length === 0) {
  console.log("All runs failed — no latency data.");
  process.exit(1);
}

const sorted = [...latencies].sort((a, b) => a - b);
const p50 = percentile(sorted, 50);
const p95 = percentile(sorted, 95);
const min = sorted[0];
const max = sorted[sorted.length - 1];
const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

console.log(`\nResults (${latencies.length} successful / ${RUNS} total):`);
console.log(`  min  : ${min}ms`);
console.log(`  p50  : ${p50}ms`);
console.log(`  p95  : ${p95}ms`);
console.log(`  max  : ${max}ms`);
console.log(`  avg  : ${avg}ms`);
if (errors.length > 0) {
  console.log(`  errors: ${errors.length}`);
}
console.log("─".repeat(48));
console.log(`\nResume line: "P95 query latency ${p95}ms on a [X]-page document."\n`);
