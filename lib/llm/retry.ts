import { LlmRateLimitError, LlmTransientError } from "@/lib/llm/errors";

/**
 * Politique de réessai **au niveau de l'appel** (et non du job) — partagée par les
 * pipelines qui font des appels LLM en série (découverte 2A, synthèses 5A).
 *
 * Le PRD borne les *jobs* à 5 tentatives (§3.4). Il ne dit pas qu'un incident passager
 * du provider doit en consommer une — et c'est pourtant ce qui se produisait : seul le
 * `429` était réessayé dans le batch, alors qu'un `503 Service temporarily overloaded`
 * ou un timeout remontait au worker, qui relançait le job. Mesuré en réel
 * (2026-09-14, NVIDIA NIM) : **2 des 5 tentatives consommées en 4 batchs** sur un run
 * qui en compte 12 — le run ne pouvait pas finir, non par défaut de code mais par
 * épuisement d'un compteur prévu pour les *vrais* échecs.
 *
 * Les réessais d'appel restent bornés (`MAX_PROVIDER_ATTEMPTS`) et espacés (backoff
 * exponentiel + jitter, `Retry-After` respecté et plafonné) : le worker conserve donc
 * sa borne de 5 tentatives pour les échecs réels (schéma invalide, modèle inconnu…).
 */

/** Nombre d'essais d'un même appel avant de remonter l'erreur au worker. */
export const MAX_PROVIDER_ATTEMPTS = 5;

/** Plafond du `Retry-After` respecté : un délai énorme ne doit pas figer le worker. */
const RETRY_AFTER_CEILING_S = 120;

/** Base du backoff exponentiel d'un incident passager (2 s, 4 s, 8 s, 16 s, plafond 30 s). */
export const TRANSIENT_BACKOFF_BASE_MS = 2_000;
const TRANSIENT_BACKOFF_CEILING_MS = 30_000;

/**
 * Délai (ms) à observer avant de rejouer l'appel, ou `null` si l'erreur n'est **pas**
 * un incident passager (elle doit alors remonter immédiatement au worker).
 *
 * @param attempt index de la tentative qui vient d'échouer (0 = première)
 */
export function providerRetryDelayMs(e: unknown, attempt: number): number | null {
  if (e instanceof LlmRateLimitError) {
    // Retry-After respecté (PRD §3.4), mais plafonné : sans plafond, un provider qui
    // annonce 1 500 s laisse le lease expirer et le job `running` à vie.
    return (Math.min(e.retryAfterSeconds, RETRY_AFTER_CEILING_S) + 5) * 1000;
  }
  if (e instanceof LlmTransientError) {
    // backoff exponentiel + jitter (±20 %) : deux appels concurrents ne retapent pas
    // le provider au même instant, ce qui aggrave la surcharge qui a causé le 503
    const base = Math.min(TRANSIENT_BACKOFF_BASE_MS * 2 ** attempt, TRANSIENT_BACKOFF_CEILING_MS);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    return Math.round(base + jitter);
  }
  return null;
}
