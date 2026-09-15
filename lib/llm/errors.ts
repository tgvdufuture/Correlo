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
 * Incident **passager** du provider : `503 Service temporarily overloaded`, `408`,
 * timeout, connexion coupée. Distinct de `LlmNetworkError` (qui couvre aussi les
 * erreurs définitives : `404` modèle inconnu, hôte inexistant, clé refusée) parce que
 * les deux ne méritent pas le même traitement.
 *
 * Constaté en réel (2026-09-14) sur NVIDIA NIM : un run de validation de 12 batchs a
 * consommé **2 des 5 tentatives du job en 4 batchs** (1 × 503, 1 × timeout 300 s).
 * Seul le `429` était réessayé dans le batch ; un incident passager remontait donc au
 * worker, qui relançait le job — jusqu'à l'échec définitif d'un run que le provider
 * pouvait encore servir. Le PRD borne les *jobs* à 5 tentatives (§3.4) ; un incident
 * passager du provider ne devrait pas en consommer une (même principe que le 429).
 */
export class LlmTransientError extends LlmNetworkError {
  constructor(message: string) {
    super(message);
    this.code = "llm_transient";
    this.name = "LlmTransientError";
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