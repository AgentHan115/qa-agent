// Bounded retries with exponential backoff and full jitter.
//
// Retries only errors marked retryable (rate limits, 5xx, timeouts, network
// errors), never starts an attempt or a backoff sleep that would end after the
// caller's signal fires, and stops immediately when the signal aborts.

const abortError = (signal) =>
  signal.reason instanceof Error ? signal.reason : Object.assign(new Error("Aborted"), { name: "AbortError" });

// Resolves after ms, or rejects as soon as the signal aborts.
export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Full jitter: uniform in [0, min(maxDelay, base * 2^attempt)].
export const backoffDelay = (attempt, { baseDelayMs, maxDelayMs, random = Math.random }) =>
  Math.floor(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));

// fn(attempt) is called up to retries + 1 times. `attempts` on the thrown
// error (and on onRetry calls) says how many were made.
export const withRetries = async (
  fn,
  { retries = 2, baseDelayMs = 250, maxDelayMs = 2000, signal, isRetryable = (err) => err?.retryable === true, onRetry, random } = {}
) => {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    try {
      return await fn(attempt);
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      if (attempt >= retries || !isRetryable(err)) {
        err.attempts = attempt + 1;
        throw err;
      }
      const delay = backoffDelay(attempt, { baseDelayMs, maxDelayMs, random });
      onRetry?.(err, { attempt: attempt + 1, delay });
      await sleep(delay, signal);
    }
  }
};
