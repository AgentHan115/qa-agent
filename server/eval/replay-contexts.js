// Replays frozen hybrid contexts (eval/capture-contexts.js) to the configured
// chat model: no retrieval, no search, only the model call. Each prompt is
// rebuilt from the frozen system and user messages and its SHA-1 must match
// the frozen prompt_sha1, or the call is refused.
//
// Conditions: retrieved (what the RAG system actually found) and oracle (gold
// evidence guaranteed present). Where the oracle didn't change the context,
// the retrieved answer is reused instead of calling twice.
//
//   node eval/replay-contexts.js --frozen=eval/frozen/contexts-<ts>.json
//
// Options:
//   --ids=P01,T05   only these questions
//   --stub          don't call a model; answer with a fixed string (dry runs)
//   --out=<path>    default results/replay-<timestamp>.json
//
// Uses the app's model settings (LLM_* in .env) and the same guards as /chat.
// Writes results/replay-<timestamp>.json.

import dotenv from "dotenv";
dotenv.config();

import { createHash } from "crypto";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

import { createChatModel, invokeGuarded, llmConfig } from "../lib/llm.js";
import { usageFrom } from "../lib/usage.js";
import { describeRuntime } from "../lib/runtime-info.js";
import { parseCitations } from "../pipeline/citations.js";
import { planCalls, promptText, sha1 } from "./replay.js";

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const stub = process.argv.includes("--stub");

const frozenPath = argValue("frozen");
if (!frozenPath) {
  console.error("Usage: node eval/replay-contexts.js --frozen=eval/frozen/contexts-<ts>.json [--ids=P01,T05] [--stub]");
  process.exit(1);
}
const frozenText = readFileSync(frozenPath, "utf8");
const frozen = JSON.parse(frozenText);
if (sha1(frozen.system) !== frozen.system_sha1) {
  console.error("Frozen system message doesn't match its recorded SHA-1.");
  process.exit(1);
}

const ids = argValue("ids")?.split(",");
const calls = planCalls(frozen, ids);
const model = stub ? null : createChatModel();
const config = llmConfig();

console.log(`Replaying ${calls.length} prompts from ${frozenPath} to ${stub ? "a stub" : config.model}`);
const answers = [];
for (const call of calls) {
  const { system } = frozen;
  const { user, sources, prompt_sha1 } = call.context;
  const text = promptText(system, user);
  if (sha1(text) !== prompt_sha1) {
    console.error(`${call.id} ${call.condition}: rebuilt prompt doesn't match the frozen prompt_sha1; refusing to call.`);
    process.exit(1);
  }

  const record = { id: call.id, condition: call.condition, prompt_sha1 };
  const t = Date.now();
  try {
    if (stub) {
      record.answer = `Stub answer for ${call.id} (${call.condition}) [D1].`;
    } else {
      const { message, check } = await invokeGuarded(model, [new SystemMessage(system), new HumanMessage(user)], text);
      record.answer = typeof message.content === "string" ? message.content : "";
      record.usage = usageFrom(message);
      record.check = check;
      record.response_model = message.response_metadata?.model_name ?? message.response_metadata?.model ?? null;
    }
    record.citations = parseCitations(record.answer, sources);
  } catch (err) {
    record.error = `${err.name}: ${err.message}`;
  }
  record.ms = Date.now() - t;
  answers.push(record);
  console.log(`${call.id.padEnd(4)} ${call.condition.padEnd(9)} ${record.error ? `ERROR ${record.error}` : `${record.ms}ms ${record.answer.replace(/\s+/g, " ").slice(0, 90)}`}`);
}

const git = (() => {
  try {
    return {
      commit: execSync("git rev-parse HEAD").toString().trim(),
      dirty: execSync("git status --porcelain --untracked-files=no").toString().trim().length > 0,
    };
  } catch {
    return null;
  }
})();

const runAt = new Date().toISOString();
const out = {
  runAt,
  git,
  stub,
  frozen: { path: frozenPath, sha256: createHash("sha256").update(frozenText).digest("hex"), created: frozen.created },
  model: stub ? null : config,
  runtime: stub ? null : await describeRuntime().catch((err) => ({ error: err.message })),
  reused: frozen.questions
    .filter((q) => !ids || ids.includes(q.id))
    .filter((q) => !calls.some((c) => c.id === q.id && c.condition === "oracle"))
    .map((q) => q.id),
  answers,
};
mkdirSync("results", { recursive: true });
const outPath = argValue("out") || `results/replay-${stub ? "stub-" : ""}${runAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
const errors = answers.filter((a) => a.error).length;
console.log(`\n${answers.length} answers (${errors} errors), oracle reuses the retrieved answer for ${out.reused.length} questions. Wrote ${outPath}`);
