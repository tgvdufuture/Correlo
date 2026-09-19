import { idempotencyKey } from "@/lib/repositories/jobs";
import { getChatSignature } from "@/lib/llm/llm";
import { INVESTIGATION_PROMPT_VERSION } from "@/lib/agent/prompts";
import { INVESTIGATION_STEP_BUDGET } from "@/lib/agent/types";

/**
 * Identité d'une investigation dans la file de jobs — **écrite une seule fois**,
 * parce que deux appelants doivent la calculer à l'identique : la route qui enfile
 * (`POST`) et celle qui lit l'état de la file (`GET`). Une divergence entre les deux
 * ferait répondre « jamais lancée » à un écran qui regarde une enquête en cours.
 *
 * La clé porte la **version de prompt** et la **signature du chat** (modèle, effort
 * de raisonnement, budget de sortie) : relancer la même question sur le même réglage
 * reprend le même job — donc la même investigation, rejouée depuis le cache de
 * prompt — tandis que changer de prompt ou de modèle est une nouvelle enquête. Même
 * convention que le run de découverte automatique déclenché par un dépôt.
 */
export function investigationJobKey(suggestionId: string): string {
  return idempotencyKey([
    "investigation",
    suggestionId,
    INVESTIGATION_PROMPT_VERSION,
    getChatSignature(),
  ]);
}

/** Payload du job : la question, et les bornes du run (celles du service par défaut). */
export function investigationJobPayload(suggestionId: string): {
  suggestion_id: string;
  max_steps: number;
} {
  return { suggestion_id: suggestionId, max_steps: INVESTIGATION_STEP_BUDGET };
}
