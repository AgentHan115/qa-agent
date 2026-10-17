// Classifying provider errors as permanent (retrying can't help) vs transient.
//
// OpenAI reports an empty credit balance as 429 with
// { type: "insufficient_quota", code: "credit_balance_exhausted" }. LangChain's
// default retry handler only recognises code === "insufficient_quota", so it
// treats this as a rate limit and retries 6 times with backoff (~90s observed)
// before giving up. We catch it ourselves.

const PERMANENT_STATUSES = new Set([400, 401, 402, 403, 404, 405, 406, 407, 409, 422]);
const QUOTA_MARKERS = new Set(["insufficient_quota", "credit_balance_exhausted"]);

export const isPermanentProviderError = (err) => {
  if (!err || typeof err !== "object") return false;
  if (PERMANENT_STATUSES.has(err.status)) return true;
  return [err.type, err.code, err.error?.type, err.error?.code].some((v) => QUOTA_MARKERS.has(v));
};

const isAbort = (err) =>
  err?.name === "AbortError" || (typeof err?.message === "string" && err.message.startsWith("Cancel"));

// Pass as `onFailedAttempt` to LangChain models/embeddings: throwing stops the
// retry loop; returning lets it retry (429 rate limits, 5xx, network errors).
export const failFastOnPermanentErrors = (err) => {
  if (isAbort(err) || isPermanentProviderError(err)) throw err;
};
