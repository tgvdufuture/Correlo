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

/**
 * Le provider a **refusé** la génération en mode JSON (`response_format: json_object`).
 *
 * Constaté en réel (2026-09-13) : un modèle de raisonnement peut épuiser son budget
 * en raisonnement et rendre une génération vide ; Groq répond alors `HTTP 400`
 * `json_validate_failed` avec `failed_generation: ""` — un `finish_reason` n'est
 * jamais renvoyé, donc le réessai sur troncature ne peut pas s'en saisir. Comme la
 * sortie est déterministe à température 0, les 5 tentatives du job échouaient sur le
 * même prompt (4 graines traitées, puis job `failed`).
 *
 * Erreur distincte pour permettre le repli : rejouer **sans** `response_format`, le
 * JSON restant alors extrait du texte par `chatWithJsonCorrection`.
 */
export class LlmJsonModeError extends LlmError {
  constructor(message: string) {
    super("llm_json_mode_refused", message);
    this.name = "LlmJsonModeError";
  }
}

/** Erreur d'authentification (clé invalide). */
export class LlmAuthError extends LlmError {
  constructor(message: string) {
    super("llm_auth", message);
    this.name = "LlmAuthError";
  }
}