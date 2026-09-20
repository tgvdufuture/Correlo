import { z } from "zod";
import {
  MAX_CITATIONS_PER_CLAIM,
  MAX_CLAIM_CHARS,
  MAX_CLAIMS,
  MAX_WEB_QUERY_CHARS,
} from "@/lib/agent/conversation-types";

/**
 * Sortie LLM d'**une étape** de conversation : une seule action à la fois.
 *
 * Comme en Phase 4, le schéma valide la **forme**, pas les bornes du catalogue : citer
 * un indice que le catalogue ne contient pas est bien un entier, donc le retry de
 * correction du provider ne peut pas le réparer. Le service l'enregistre comme une
 * réponse **refusée** (`reponse_hors_catalogue`) que le modèle peut corriger dans le
 * budget restant — un refus lisible vaut mieux qu'une tentative brûlée.
 *
 * Une affirmation **sans citation est acceptée par le schéma** : l'AC1 prévoit qu'une
 * affirmation non sourcée existe et soit affichée comme telle. La garde n'est pas au
 * niveau de la forme mais au niveau du tour (`reponse_sans_aucune_preuve`) : une
 * réponse dont **aucune** affirmation n'est appuyée n'est pas une réponse sourcée, et
 * laisser passer reviendrait à accepter l'échange sans corpus.
 *
 * Les outils web sont déclarés **ici comme les autres**, même quand ils ne sont pas
 * exposés : le schéma dit ce qui a une forme valide, le **service** dit ce qui est permis
 * (`outil_web_indisponible`, `budget_web_epuise`…). Mélanger les deux ferait dépendre la
 * surface d'outils du modèle de la construction d'un schéma par tour — c'est-à-dire d'un
 * endroit où une divergence entre prompt et garde ne se verrait pas.
 */
const claimSchema = z.object({
  text: z.string().trim().min(1).max(MAX_CLAIM_CHARS),
  /** Indices de catalogue appuyant cette affirmation. Vide = affirmation non sourcée. */
  citations: z.array(z.number().int().min(0)).max(MAX_CITATIONS_PER_CLAIM).optional(),
  /** Indices de **résultats web lus** appuyant cette affirmation (`W0`, `W1`…). */
  web: z.array(z.number().int().min(0)).max(MAX_CITATIONS_PER_CLAIM).optional(),
});

export const CONVERSATION_ACTION_SCHEMA = z
  .object({
    action: z.enum(["search", "expand", "ask_web", "answer", "search_web", "read_page"]),
    /** Requis par `search` et `search_web`. */
    query: z.string().trim().min(2).max(MAX_WEB_QUERY_CHARS).optional(),
    /**
     * Requis par `ask_web` : **pourquoi** le corpus ne suffit pas. Affiché comme entrée de
     * l'étape, donc borné — c'est un motif, pas un raisonnement (celui-ci vit dans
     * `reasoning`, qui n'est jamais persisté).
     */
    reason: z.string().trim().min(3).max(MAX_WEB_QUERY_CHARS).optional(),
    /** Requis par `expand` : indice d'une entrée du catalogue. */
    fragment: z.number().int().min(0).optional(),
    /** Requis par `read_page` : indice d'un résultat de la recherche web du tour. */
    result: z.number().int().min(0).optional(),
    /**
     * Requis par `answer`. **Le serveur assemble** `messages.text` à partir de ces
     * affirmations : le modèle ne fournit pas de prose à côté, sinon la provenance
     * d'une phrase devrait être devinée (mesure Phase 4, §11.3).
     */
    claims: z.array(claimSchema).min(1).max(MAX_CLAIMS).optional(),
    /** Champ libre toléré (raisonnement) : jamais lu, jamais persisté. */
    reasoning: z.string().max(4_000).optional(),
  })
  .superRefine((val, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const searchLike = val.action === "search" || val.action === "search_web";
    if (searchLike) {
      if (!val.query) issue(`action ${val.action} : query requis`);
      if (val.fragment !== undefined) issue(`action ${val.action} : fragment interdit`);
      if (val.result !== undefined) issue(`action ${val.action} : result interdit`);
      if (val.claims !== undefined) issue(`action ${val.action} : claims interdites`);
    }
    if (val.action === "expand") {
      if (val.fragment === undefined) issue("action expand : fragment requis");
      if (val.query !== undefined) issue("action expand : query interdite");
      if (val.result !== undefined) issue("action expand : result interdit");
      if (val.claims !== undefined) issue("action expand : claims interdites");
    }
    if (val.action === "ask_web") {
      if (!val.reason) issue("action ask_web : reason requis (pourquoi le corpus ne suffit pas)");
      if (val.query !== undefined) issue("action ask_web : query interdite");
      if (val.fragment !== undefined) issue("action ask_web : fragment interdit");
      if (val.result !== undefined) issue("action ask_web : result interdit");
      if (val.claims !== undefined) issue("action ask_web : claims interdites");
    }
    if (val.action === "read_page") {
      if (val.result === undefined) issue("action read_page : result requis");
      if (val.query !== undefined) issue("action read_page : query interdite");
      if (val.fragment !== undefined) issue("action read_page : fragment interdit");
      if (val.claims !== undefined) issue("action read_page : claims interdites");
    }
    if (val.action === "answer") {
      if (!val.claims || val.claims.length === 0) {
        issue("action answer : claims requises (au moins 1 affirmation)");
      }
      if (val.query !== undefined || val.fragment !== undefined || val.result !== undefined) {
        issue("action answer : query, fragment et result interdits");
      }
      for (const claim of val.claims ?? []) {
        const citations = claim.citations ?? [];
        if (new Set(citations).size !== citations.length) {
          issue("action answer : citations dupliquées dans une affirmation");
        }
        const web = claim.web ?? [];
        if (new Set(web).size !== web.length) {
          issue("action answer : résultats web dupliqués dans une affirmation");
        }
      }
    }
  });

export type ConversationActionOutput = z.infer<typeof CONVERSATION_ACTION_SCHEMA>;
