// Extracts [D#]/[W#] citations from an answer and checks them against the
// sources that were actually in the prompt. The answer text is not rewritten
// (streamed tokens are already on the client); invalid labels are reported so
// the UI can flag them and the eval can measure citation validity.

// Matches [D1], [W2], and grouped forms like [D1, W2] or [D1; D3].
const CITATION_GROUP = /\[\s*([DW]\d+(?:\s*[,;]\s*[DW]\d+)*)\s*\]/g;

export const parseCitations = (answer, sources) => {
  const known = new Set(sources.map((s) => s.id));
  const found = [];
  for (const match of answer.matchAll(CITATION_GROUP)) {
    for (const id of match[1].split(/[,;]/)) found.push(id.trim());
  }
  const unique = [...new Set(found)];
  return {
    total: found.length, // citation markers, counting repeats
    cited: unique.filter((id) => known.has(id)),
    invalid: unique.filter((id) => !known.has(id)),
    uncited: sources.map((s) => s.id).filter((id) => !unique.includes(id)),
  };
};
