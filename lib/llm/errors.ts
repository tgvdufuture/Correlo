/** Erreurs LLM typées pour routage worker (backoff, retry, statuts visibles). */
export class LlmError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

/** Sortie LLM invalide (JSON ou schéma) après le retry de correction. */
export class LlmOutputError extends LlmError {
  constructor(message: string) {
    super("llm_output_invalid", message);
    this.name = "LlmOutputError";
  }
}

/** Rate limit (429) — le worker respecte Retry-After. */
export class LlmRateLimitError extends LlmError {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("rate_limited", `Rate limit LLM (Retry-After: ${retryAfterSeconds}s)`);
    this.name = "LlmRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Erreur réseau / serveur LLM injoignable. */
export class LlmNetworkError extends LlmError {
  constructor(message: string) {
    super("llm_network", message);
    this.name = "LlmNetworkError";
  }
}

/** Erreur d'authentification (clé invalide). */
export class LlmAuthError extends LlmError {
  constructor(message: string) {
    super("llm_auth", message);
    this.name = "LlmAuthError";
  }
}