// Builds the single grounded prompt from document chunks and web results.
//
// Sources get stable labels: [D1..Dk] for document chunks (with page numbers)
// and [W1..Wn] for web results (with title and URL). The two lists are not
// merged into one ranking: a Chroma distance and a search-engine position are
// not comparable scores, so each source type keeps its own order.
//
// Prompt layout: fixed instructions (system message, identical for every
// request and mode, so it forms a reusable prefix), then sources, then the
// question. The pieces are returned separately so they can be logged/replayed.

import { createHash } from "crypto";

export const INSTRUCTIONS = `You answer questions using only the numbered sources provided.
- Document sources are labelled [D1], [D2], ... and come from the user's uploaded document.
- Web sources are labelled [W1], [W2], ... and come from a live web search.

Rules:
1. Base every statement on the sources. Do not add outside knowledge.
2. After each sentence, cite the sources that support it using their labels in square brackets, for example [D2] or [W1][D3]. Only use labels that appear below.
3. If document and web sources disagree, say so and cite both.
4. If the sources do not contain the answer, say that you don't know.
5. Keep the answer concise: at most four sentences.`;

const textKey = (text) => createHash("sha1").update(text.replace(/\s+/g, " ").trim()).digest("hex");

// Same page under trivially different URLs (tracking params, fragment, trailing slash).
export const normalizeUrl = (url) => {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$)/i.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
};

const dedupeBy = (items, keyFn) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const buildContext = ({ question, docs = [], web = [] }) => {
  const docSources = dedupeBy(docs, (d) => textKey(d.text)).map((d, i) => ({
    id: `D${i + 1}`,
    type: "document",
    page: d.page,
    text: d.text,
  }));
  const webSources = dedupeBy(web, (w) => normalizeUrl(w.url)).map((w, i) => ({
    id: `W${i + 1}`,
    type: "web",
    title: w.title,
    url: w.url,
    snippet: w.snippet,
    date: w.date ?? null,
  }));

  const docBlock = docSources.length
    ? docSources.map((s) => `[${s.id}] (page ${s.page ?? "?"})\n${s.text}`).join("\n\n")
    : "(none)";
  const webBlock = webSources.length
    ? webSources
        .map((s) => `[${s.id}] ${s.title}${s.date ? ` (${s.date})` : ""}\n${s.url}\n${s.snippet}`)
        .join("\n\n")
    : "(none)";

  const user = `Document sources:\n${docBlock}\n\nWeb sources:\n${webBlock}\n\nQuestion: ${question}`;

  return {
    system: INSTRUCTIONS,
    user,
    sources: [...docSources, ...webSources],
    // What the model actually reads, for size checks.
    promptText: `${INSTRUCTIONS}\n\n${user}`,
  };
};
