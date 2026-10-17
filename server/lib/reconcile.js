// Postgres records a document as "ready", but the vectors live in Chroma. The two
// can drift (e.g. Chroma's volume was lost), leaving "ready" documents whose
// queries silently retrieve nothing. reconcileReadyDocuments detects that on
// startup and marks those documents failed with an explicit reason, instead of
// re-embedding everything automatically (re-ingestion costs embedding calls,
// so it is triggered deliberately — see POST /documents/:id/reingest).
//
// Dependencies are injected so the logic is testable without the real services.

export const vectorsMissingReason = (expected, stored) =>
  `Vectors missing in Chroma (expected ${expected ?? "?"}, found ${stored}); re-ingestion required`;

export const reconcileReadyDocuments = async ({
  listDocumentsByStatus,
  countVectors,
  markFailed,
  log = console,
}) => {
  const ready = await listDocumentsByStatus("ready");
  const drifted = [];

  for (const doc of ready) {
    const stored = await countVectors(doc.id);
    if (stored === doc.chunk_count) continue;

    const reason = vectorsMissingReason(doc.chunk_count, stored);
    log.warn(`[reconcile] ${doc.filename} (${doc.id}): ${reason}`);
    await markFailed(doc.id, reason);
    drifted.push(doc.id);
  }

  return { checked: ready.length, drifted };
};
