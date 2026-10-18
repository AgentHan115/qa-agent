import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, normalizeUrl, INSTRUCTIONS } from "../pipeline/context.js";
import { parseCitations } from "../pipeline/citations.js";

const docs = [
  { text: "An MVP is the smallest product that tests a hypothesis.", page: 4 },
  { text: "Validated learning comes from experiments.", page: 7 },
  { text: "An MVP is the smallest   product that tests a hypothesis.", page: 4 }, // duplicate modulo whitespace
];
const web = [
  { title: "MVP - Wikipedia", url: "https://en.wikipedia.org/wiki/MVP", snippet: "Minimum viable product.", date: null },
  { title: "MVP (dup)", url: "https://www.en.wikipedia.org/wiki/MVP/?utm_source=x#top", snippet: "same page", date: null },
  { title: "Lean Startup", url: "https://example.com/lean", snippet: "Build-measure-learn.", date: "2026-01-02" },
];

test("labels document and web sources separately and deduplicates each", () => {
  const { sources } = buildContext({ question: "What is an MVP?", docs, web });
  assert.deepEqual(
    sources.map((s) => [s.id, s.type]),
    [
      ["D1", "document"],
      ["D2", "document"],
      ["W1", "web"],
      ["W2", "web"],
    ]
  );
  assert.equal(sources[0].page, 4);
  assert.equal(sources[3].url, "https://example.com/lean");
});

test("prompt has fixed instructions first, then sources, then the question", () => {
  const ctx = buildContext({ question: "What is an MVP?", docs, web });
  assert.equal(ctx.system, INSTRUCTIONS);
  assert.ok(ctx.promptText.startsWith(INSTRUCTIONS));
  assert.match(ctx.user, /^Document sources:\n\[D1\] \(page 4\)/);
  assert.match(ctx.user, /\[W2\] Lean Startup \(2026-01-02\)\nhttps:\/\/example.com\/lean/);
  assert.ok(ctx.user.endsWith("Question: What is an MVP?"));
});

test("instructions are identical regardless of mode (stable prefix)", () => {
  const docsOnly = buildContext({ question: "q", docs, web: [] });
  const webOnly = buildContext({ question: "q", docs: [], web });
  assert.equal(docsOnly.system, webOnly.system);
  assert.match(docsOnly.user, /Web sources:\n\(none\)/);
  assert.match(webOnly.user, /Document sources:\n\(none\)/);
});

test("normalizeUrl ignores tracking params, fragments, www and trailing slash", () => {
  assert.equal(normalizeUrl("https://www.Example.com/a/?utm_medium=x&id=3#frag"), "https://example.com/a/?id=3");
  assert.equal(normalizeUrl("https://example.com/a/"), "https://example.com/a");
  assert.equal(normalizeUrl("not a url"), "not a url");
});

test("citation parser handles single, adjacent and grouped labels", () => {
  const sources = [{ id: "D1" }, { id: "D2" }, { id: "W1" }];
  const c = parseCitations("MVPs test ideas [D1]. They are small [D1][W1]. See also [D2, W3].", sources);
  assert.equal(c.total, 5);
  assert.deepEqual(c.cited, ["D1", "W1", "D2"]);
  assert.deepEqual(c.invalid, ["W3"]);
  assert.deepEqual(c.uncited, []);
});

test("citation parser reports uncited sources and answers without citations", () => {
  const c = parseCitations("I don't know.", [{ id: "D1" }]);
  assert.equal(c.total, 0);
  assert.deepEqual(c.uncited, ["D1"]);
});
