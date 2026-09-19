/**
 * Barrière déterministe des **conclusions d'investigation** (Phase 4, US-09).
 *
 * Une enquête doit *ajouter* ce que la connexion proposée ne disait pas. Le prompt le
 * demande ; mesuré sur le run réel du 2026-09-18, le modèle a produit exactement le
 * contraire : une **juxtaposition reformulée** — deux attributions côte à côte, reliées
 * par « tandis que », sans qu'aucune relation ne soit énoncée — et, dans une première
 * version, une simple reprise de la question. La règle reconnaît cette faute par sa
 * **structure** (deux verbes de report coordonnés par un connecteur de bipartition), pas
 * par son vocabulaire : une version attributive, mesurée sur la même sortie, était
 * aveugle (voir `isProseJuxtaposition`). Ces règles rendent ces sorties invalides **côté
 * serveur**, comme les barrières des phases 2A et 5A.
 *
 * **Branchée** : le service (`InvestigationService.applyAction`) lui délègue ses règles de
 * texte et n'en réimplémente aucune (le motif rendu est celui du module) ; seules les
 * règles qui lisent la **trace** du run restent côté service.
 *
 * Elles sont volontairement **conservatrices** : une conclusion refusée n'est pas
 * perdue, elle consomme une étape et le modèle peut se reprendre dans le budget
 * restant (voir `RETRYABLE_CONCLUSION_FAILURES` dans le service).
 *
 * Module **pur** : il ne connaît ni la base ni le LLM, donc il est partageable entre la
 * barrière serveur, le validateur (`scripts/validate-phase-4.mjs`) et les tests — sans
 * quoi l'évaluateur ne jugerait pas ce que la barrière filtre.
 *
 * Import **relatif** (comme `juxtaposition.ts` et `text-rules.ts`) : le validateur est un
 * script Node, pas un module compilé par Next, donc il ne connaît pas l'alias `@/`.
 */

import {
  lexicalContainment,
  rejectText,
  textTokens,
  type TextRuleProfile,
} from "./text-rules.ts";import { isProseJuxtaposition, PROSE_JUXTAPOSITION_RULE_VERSION } from "./juxtaposition.ts";



/**
 * Version des règles de conclusion — persistée dans le document d'enquête.
 *
 * `conclusion-v2` (2026-09-18) : le prong de juxtaposition est devenu **structurel**
 * (deux verbes de report + connecteur de bipartition, `jux-prose-v1`). En `v1`, il
 * reposait sur l'attribution lexicale de chaque clause à un fragment cité et laissait
 * passer la juxtaposition reformulée du run réel — la faute même qu'il devait couper.
 * Les verdicts antérieurs restent lisibles sous leur propre version.
 */
export const CONCLUSION_RULE_VERSION = "conclusion-v2";

/** Version de la règle de juxtaposition appliquée ici (traçabilité). */
export const CONCLUSION_JUX_RULE_VERSION = PROSE_JUXTAPOSITION_RULE_VERSION;

/**
 * Seuil de « la conclusion ne fait que redire la question ».
 *
 * Propre à l'enquête, distinct du seuil partagé de paraphrase (`PARAPHRASE_THRESHOLD`,
 * 0,85 — « un énoncé qui recopie une preuve »), calibré pour un autre problème :
 * mesuré sur la sortie réelle du 2026-09-18, l'énoncé qui restituait la suggestion mot
 * pour mot atteint **0,846**, soit un cran sous ce seuil.
 */
export const QUESTION_ECHO_THRESHOLD = 0.8;

/** Raisons de refus d'une conclusion (stockées dans l'étape). */
export type ConclusionRejection =
  | "conclusion_recopie_la_question"
  | "conclusion_juxtaposition"
  | "conclusion_generique"
  | "conclusion_langue"
  | "conclusion_hors_format";

export type ConclusionVerdict =
  | { ok: true }
  | { ok: false; reason: ConclusionRejection; detail: string };

/**
 * Profil de forme d'une conclusion.
 *
 * `minWords` est **bas** (12) à dessein : le prompt autorise une conclusion négative
 * (« le corpus ne permet pas d'aller plus loin »), qui est courte par nature et
 * parfaitement honnête. `maxWords`/`maxSentences` coupent le fourre-tout (le prompt
 * demande 40–120 mots).
 *
 * `extraGenericMarkers` reprend la famille des formules holistiques, celles qui sont
 * vraies de n'importe quelle paire : c'est par « tous deux » que la juxtaposition
 * réelle du 2026-09-18 commençait.
 */
export const CONCLUSION_TEXT_PROFILE: TextRuleProfile = {
  minWords: 12,
  maxWords: 160,
  maxSentences: 4,
  emptyReason: "tooShort",
  englishStopwordMin: 3,
  extraGenericMarkers: [
    "tous les deux",
    "les deux documents",
    "chez l un comme chez l autre",
    "dans les deux cas",
    "de part et d autre",
    "se repondent",
    "se rejoignent",
    "se font echo",
    "montrent tous",
    "affirment tous",
    "soulignent tous",
    "considerent tous",
    "partagent tous",
    "de la meme exigence",
  ],
};

/**
 * Juge une conclusion : **juxtaposition en prose**, puis forme et langue, puis reprise
 * de la question.
 *
 * La juxtaposition passe **avant** les marqueurs génériques : la sortie réelle du
 * 2026-09-18 déclenchait les deux (elle commençait par « considèrent tous deux »), et
 * c'est la juxtaposition qui décrit le défaut et indique quoi corriger — « formule
 * holistique » inviterait à retirer trois mots au lieu de changer la structure.
 *
 * Pas de `evidenceTexts` : la règle de juxtaposition est **structurelle** (deux reports
 * coordonnés sans relation énoncée) et non attributive — mesurée sur la sortie réelle,
 * l'attribution lexicale d'une clause à son fragment plafonne à 0,27 pour une clause
 * qui le résume pourtant correctement (voir `isProseJuxtaposition`). Un paramètre
 * qu'aucune règle ne lit n'a rien à faire ici.
 */
export function judgeConclusion(input: {
  answer: string;
  /** L'énoncé de la suggestion — la question posée à l'agent. */
  claim: string;
}): ConclusionVerdict {
  const answer = input.answer.trim();
  if (!answer) return { ok: false, reason: "conclusion_hors_format", detail: "énoncé vide" };

  // Juxtaposition : deux reports coordonnés, aucune relation énoncée. C'est le défaut de
  // fond de la 2A, retrouvé au niveau de l'enquête — sur une réponse, il ne se voit pas
  // d'un marqueur : il se mesure sur la structure (deux verbes de report + un connecteur).
  if (isProseJuxtaposition(answer)) {
    return {
      ok: false,
      reason: "conclusion_juxtaposition",
      detail: "reports juxtaposés (connecteur de bipartition, aucune relation énoncée)",
    };
  }

  const shape = rejectText(answer, CONCLUSION_TEXT_PROFILE);
  if (shape === "generic") {
    return {
      ok: false,
      reason: "conclusion_generique",
      detail: "formule holistique (vraie de n'importe quelle paire de textes)",
    };
  }
  if (shape === "english") {
    return { ok: false, reason: "conclusion_langue", detail: "énoncé non francophone" };
  }
  if (shape) {
    return { ok: false, reason: "conclusion_hors_format", detail: `forme refusée (${shape})` };
  }

  const answerTerms = textTokens(answer);
  const claimTerms = textTokens(input.claim);
  if (answerTerms.size >= 3 && claimTerms.size >= 3) {
    const overlap = lexicalContainment(answerTerms, claimTerms);
    if (overlap >= QUESTION_ECHO_THRESHOLD) {
      return {
        ok: false,
        reason: "conclusion_recopie_la_question",
        detail: `recouvrement ${overlap.toFixed(2)} avec la question`,
      };
    }
  }
  return { ok: true };
}
