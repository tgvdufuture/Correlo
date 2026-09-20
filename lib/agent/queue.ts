import { idempotencyKey } from "@/lib/repositories/jobs";
import { getChatSignature } from "@/lib/llm/llm";
import { INVESTIGATION_PROMPT_VERSION } from "@/lib/agent/prompts";
import { INVESTIGATION_STEP_BUDGET } from "@/lib/agent/types";
import { CONVERSATION_PROMPT_VERSION } from "@/lib/agent/conversation-prompts";
import { CONVERSATION_STEP_BUDGET } from "@/lib/agent/conversation-types";

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

/**
 * Identité d'un **tour de conversation** dans la file de jobs (Phase 6).
 *
 * La clé porte l'id du **message de l'utilisateur**, pas le texte de la question. La
 * différence est le comportement voulu : rejouer la même demande (double clic, reprise
 * après une coupure) retombe sur le même tour, alors que **reposer** la même question
 * crée un message neuf — donc un tour neuf, avec l'historique du moment. Une clé sur le
 * texte rendrait la seconde question identique impossible à distinguer d'un rejeu, et
 * l'utilisateur recevrait l'ancienne réponse.
 *
 * Comme pour l'enquête, la version de prompt et la signature du chat en font partie :
 * changer de modèle ou de prompt est un nouveau tour, pas un cache détourné.
 */
export function conversationTurnJobKey(conversationId: string, questionMessageId: string): string {
  return idempotencyKey([
    "conversation",
    conversationId,
    questionMessageId,
    CONVERSATION_PROMPT_VERSION,
    getChatSignature(),
  ]);
}

/**
 * Payload du job : la question et sa provenance de conversation, plus les bornes du tour.
 * `question_message_id` est ce qui délimite l'historique du prompt : il doit désigner le
 * message de l'utilisateur qui a déclenché **ce** tour.
 */
export function conversationTurnJobPayload(input: {
  conversationId: string;
  questionMessageId: string;
  question: string;
  maxSteps?: number;
}): {
  conversation_id: string;
  question_message_id: string;
  question: string;
  max_steps: number;
} {
  return {
    conversation_id: input.conversationId,
    question_message_id: input.questionMessageId,
    question: input.question,
    max_steps: input.maxSteps ?? CONVERSATION_STEP_BUDGET,
  };
}
