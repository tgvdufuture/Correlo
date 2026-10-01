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
 * Les outils web et la lecture de fichier sont déclarés **ici comme les autres**, même quand
 * ils ne sont pas exposés : le schéma dit ce qui a une forme valide, le **service** dit ce qui
 * est permis (`outil_web_indisponible`, `outil_workspace_indisponible`, `budget_web_epuise`…).
 * Mélanger les deux ferait dépendre la
 * surface d'outils du modèle de la construction d'un schéma par tour — c'est-à-dire d'un
 * endroit où une divergence entre prompt et garde ne se verrait pas.
 */
const claimSchema = z.object({
  text: z.string().trim().min(1).max(MAX_CLAIM_CHARS),
  /** Indices de catalogue appuyant cette affirmation. Vide = affirmation non sourcée. */
  citations: z.array(z.number().int().min(0)).max(MAX_CITATIONS_PER_CLAIM).optional(),
  /** Indices de **résultats web lus** appuyant cette affirmation (`W0`, `W1`…). */
  web: z.array(z.number().int().min(0)).max(MAX_CITATIONS_PER_CLAIM).optional(),
  /** Indices de **lectures de fichier réussies** dans ce tour (`F0`, `F1`…). */
  files: z.array(z.number().int().min(0)).max(MAX_CITATIONS_PER_CLAIM).optional(),
});

/**
 * Sortie `answer` — révision « prose » (2026-10-01, **forme plate**) : le modèle rend
 * **un texte continu** (`prose`) et la liste des sources qu'il utilise, pas des
 * affirmations pré-découpées. Le serveur découpe la prose en phrases et rattache chaque
 * source par recouvrement lexical (la Phase 4 a mesuré ce que valait la devinette
 * laissée au modèle : 0,27 de recouvrement sur une clause pourtant correcte — donc le
 * serveur rattache, le modèle ne fait que déclarer).
 *
 * Défaut mesuré en production le jour même : la première mouture imbriquait ces champs
 * sous une clé `answer`, alors que le prompt montre le format **à plat** — le modèle a
 * suivi le prompt (à juste titre) et le schéma a rejeté la bonne réponse
 * (`sortie_invalide`). La forme plate EST le contrat ; la forme imbriquée est
 * normalisée par le `preprocess` ci-dessous pour ne pas casser les tours persistés.
 */
export const CONVERSATION_ACTION_SCHEMA = z
  .preprocess(
    (raw) => {
      // `{"action":"answer","answer":{...}}` (forme imbriquée éphémère) → champs à plat.
      if (raw && typeof raw === "object" && !Array.isArray(raw) && "answer" in raw) {
        const { answer, ...rest } = raw as Record<string, unknown>;
        if (answer && typeof answer === "object" && !Array.isArray(answer)) {
          return { ...(answer as Record<string, unknown>), ...rest };
        }
      }
      return raw;
    },
    z.object({
      action: z.enum([
        "search",
        "expand",
        "ask_web",
        "answer",
        "search_web",
        "read_page",
        "read_file",
      ]),
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
       * Requis par `read_file` : chemin **dans la racine du workspace** (relatif ou absolu
       * *dans* la racine — le confinement est appliqué par le serveur après résolution, jamais
       * par la forme du chemin). Borné : c'est une entrée affichée dans la trace du tour.
       */
      path: z.string().trim().min(1).max(400).optional(),
      /** `read_file` : première ligne lue (1-based). Défaut : 1. */
      from: z.number().int().min(1).optional(),
      /** `read_file` : dernière ligne lue (incluse). Défaut : fenêtre de 200 lignes. */
      to: z.number().int().min(1).optional(),
      /**
       * Ancienne sortie `claims`, acceptée comme repli (rattrapage d'un modèle qui
       * suivrait l'ancien contrat, et tours persistés).
       */
      claims: z.array(claimSchema).min(1).max(MAX_CLAIMS).optional(),
      /** La réponse, telle qu'elle sera lue : un texte continu, pas une liste. */
      prose: z.string().trim().min(1).max(6_000).optional(),
      /** Indices de catalogue utilisés par la réponse (le serveur les rattache aux phrases). */
      citations: z.array(z.number().int().min(0)).max(MAX_CITATIONS_PER_CLAIM).optional(),
      /** Indices de **résultats web lus** utilisés par la réponse. */
      web: z.array(z.number().int().min(0)).max(MAX_CITATIONS_PER_CLAIM).optional(),
      /** Indices de **lectures de fichier réussies** dans ce tour. */
      files: z.array(z.number().int().min(0)).max(MAX_CITATIONS_PER_CLAIM).optional(),
      /**
       * La réponse apporte-t-elle du contenu **propre au modèle** (connaissance externe,
       * mise en relation) ? Affiché, jamais présenté comme un fait.
       */
      own_knowledge: z.boolean().optional(),
      /**
       * Champ libre toléré (raisonnement) : jamais lu, jamais persisté. Un dépassement
       * est **ignoré** (`.catch`), pas rejeté : mesuré sur le tour réel du 2026-10-01,
       * un modèle qui raisonne longuement dépassait le plafond et faisait tomber TOUTE
       * l'action en `sortie_invalide` — alors que le champ n'a aucun effet sur le tour.
       */
      reasoning: z
        .string()
        .max(4_000)
        .optional()
        .catch(undefined),
    })
  )
  .superRefine((val, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const searchLike = val.action === "search" || val.action === "search_web";
    if (searchLike) {
      if (!val.query) issue(`action ${val.action} : query requis`);
      if (val.fragment !== undefined) issue(`action ${val.action} : fragment interdit`);
      if (val.result !== undefined) issue(`action ${val.action} : result interdit`);
      if (val.path !== undefined) issue(`action ${val.action} : path interdit`);
      if (val.claims !== undefined) issue(`action ${val.action} : claims interdites`);
    }
    if (val.action === "expand") {
      if (val.fragment === undefined) issue("action expand : fragment requis");
      if (val.query !== undefined) issue("action expand : query interdite");
      if (val.result !== undefined) issue("action expand : result interdit");
      if (val.path !== undefined) issue("action expand : path interdit");
      if (val.claims !== undefined) issue("action expand : claims interdites");
    }
    if (val.action === "ask_web") {
      if (!val.reason) issue("action ask_web : reason requis (pourquoi le corpus ne suffit pas)");
      if (val.query !== undefined) issue("action ask_web : query interdite");
      if (val.fragment !== undefined) issue("action ask_web : fragment interdit");
      if (val.result !== undefined) issue("action ask_web : result interdit");
      if (val.path !== undefined) issue("action ask_web : path interdit");
      if (val.claims !== undefined) issue("action ask_web : claims interdites");
    }
    if (val.action === "read_page") {
      if (val.result === undefined) issue("action read_page : result requis");
      if (val.query !== undefined) issue("action read_page : query interdite");
      if (val.fragment !== undefined) issue("action read_page : fragment interdit");
      if (val.path !== undefined) issue("action read_page : path interdit");
      if (val.claims !== undefined) issue("action read_page : claims interdites");
    }
    if (val.action === "read_file") {
      if (!val.path) issue("action read_file : path requis (fichier à lire, dans la racine)");
      if (val.query !== undefined) issue("action read_file : query interdite");
      if (val.fragment !== undefined) issue("action read_file : fragment interdit");
      if (val.result !== undefined) issue("action read_file : result interdit");
      if (val.claims !== undefined) issue("action read_file : claims interdites");
      if (val.from !== undefined && val.to !== undefined && val.to < val.from) {
        issue("action read_file : plage incohérente (to < from)");
      }
    }
    if (val.action === "answer") {
      if (!val.prose && !(val.claims && val.claims.length > 0)) {
        issue("action answer : prose (ou claims) requis");
      }
      if (val.prose && val.claims) {
        issue("action answer : prose et claims sont exclusifs l'un de l'autre");
      }
      if (
        val.query !== undefined ||
        val.fragment !== undefined ||
        val.result !== undefined ||
        val.path !== undefined
      ) {
        issue("action answer : query, fragment, result et path interdits");
      }
      if (val.prose) {
        const citations = val.citations ?? [];
        if (new Set(citations).size !== citations.length) {
          issue("action answer : citations dupliquées");
        }
        const web = val.web ?? [];
        if (new Set(web).size !== web.length) {
          issue("action answer : résultats web dupliqués");
        }
        const files = val.files ?? [];
        if (new Set(files).size !== files.length) {
          issue("action answer : lectures de fichier dupliquées");
        }
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
        const files = claim.files ?? [];
        if (new Set(files).size !== files.length) {
          issue("action answer : lectures de fichier dupliquées dans une affirmation");
        }
      }
    }
  });

export type ConversationActionOutput = z.infer<typeof CONVERSATION_ACTION_SCHEMA>;
