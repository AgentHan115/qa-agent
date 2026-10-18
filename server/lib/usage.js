// Token usage helpers. LangChain puts provider usage on `usage_metadata`;
// for streams it arrives on the final chunk (streamUsage is on by default).

export const usageFrom = (message) => {
  const u = message?.usage_metadata;
  if (!u) return null;
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    // Prompt tokens served from the provider's prefix cache. null = the server
    // doesn't report it (e.g. Ollama) — not the same as a measured 0.
    cached_input_tokens: u.input_token_details?.cache_read ?? null,
  };
};
