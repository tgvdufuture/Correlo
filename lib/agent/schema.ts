import { z } from "zod";
import { MAX_ANSWER_CHARS } from "@/lib/agent/types";

/**
 * Sortie LLM d'**une étape** d'investigation : une seule action à la fois.
 *
 * Le schéma valide la **forme**, pas les bornes du catalogue. La différence est
 * délibérée : un indice hors catalogue (le modèle cite un fragment qu'il n'a jamais
 * vu) n'est pas une erreur de forme — le retry de correction du provider ne peut pas
 * la réparer, puisque l'indice *est* bien un entier. Le service l'enregistre donc
 * comme une étape `failed` (AC2 : « citation invalide ⇒ étape marquée failed, jamais
 * affichée comme preuve ») au lieu de brûler une tentative et de tout perdre. Ce qui
 * est refusé ici, en revanche, est réparable : une action inconnue, une `query`
 * manquante pour `search`, une conclusion sans énoncé ou sans citation.
 */
export const INVESTIGATION_ACTION_SCHEMA = z
  .object({
    action: z.enum(["search", "expand", "conclude"]),
    /** Requis par `search`. */
    query: z.string().trim().min(2).max(300).optional(),
    /** Requis par `expand` : indice d'une entrée du catalogue. */
    fragment: z.number().int().min(0).optional(),
    /** Requis par `conclude`. */
    answer: z.string().trim().min(1).max(MAX_ANSWER_CHARS).optional(),
    /** Requis par `conclude` : au moins une preuve, au plus 6. */
    citations: z.array(z.number().int().min(0)).min(1).max(6).optional(),
    /** Champ libre toléré (raisonnement) : jamais lu, jamais persisté. */
    reasoning: z.string().max(4_000).optional(),
  })
  .superRefine((val, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (val.action === "search") {
      if (!val.query) issue("action search : query requis");
      if (val.fragment !== undefined) issue("action search : fragment interdit");
    }
    if (val.action === "expand") {
      if (val.fragment === undefined) issue("action expand : fragment requis");
      if (val.query !== undefined) issue("action expand : query interdite");
    }
    if (val.action === "conclude") {
      if (!val.answer) issue("action conclude : answer requis");
      if (!val.citations || val.citations.length === 0) {
        issue("action conclude : citations requises (au moins 1)");
      }
      const unique = new Set(val.citations ?? []);
      if (unique.size !== (val.citations ?? []).length) {
        issue("action conclude : citations dupliquées");
      }
      if (val.query !== undefined || val.fragment !== undefined) {
        issue("action conclude : query et fragment interdits");
      }
    }
    // Une réponse n'accompagne qu'une conclusion : ailleurs, elle est ignorée par
    // le service — mais une réponse sur une action d'outil signale un malentendu
    // de protocole, donc elle est refusée.
    if (val.action !== "conclude" && val.answer !== undefined) {
      issue(`action ${val.action} : answer interdite`);
    }
  });

export type InvestigationActionOutput = z.infer<typeof INVESTIGATION_ACTION_SCHEMA>;
