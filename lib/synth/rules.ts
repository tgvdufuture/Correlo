/**
 * Barrière déterministe de qualité des synthèses (PRD v1.3, Phase 5A §2.1-4).
 *
 * Un petit modèle produit régulièrement : une reformulation d'une preuve, une
 * formule vraie de n'importe quel corpus, du texte anglais, ou un paragraphe
 * fourre-tout. Ces règles rendent ces sorties invalides **côté serveur** — elles
 * ne peuvent pas atteindre la base, indépendamment du prompt.
 *
 * Propre à la synthèse : le contrôle de **paraphrase**. Une synthèse doit
 * énoncer ce qu'aucune preuve ne dit seule ; si tous ses termes significatifs
 * viennent d'UN SEUL fragment cité, elle ne fait que le recopier.
 */

import {
  rejectText,
  textTokens,
  type TextRejection,
} from "@/lib/quality/text-rules";

/** Version des règles de qualité des synthèses — tracée avec le run. */
export const SYNTHESIS_RULES_VERSION = "synth-rules-v1";

/**
 * Seuils du PRD v1.3 §2.1-4 : ≤ 60 mots, ≤ 2 phrases, au moins 2 sources.
 * `minWords` écarte les énoncés creux (« voir ci-dessus », « à préciser »).
 */
export const SYNTHESIS_MIN_WORDS = 6;
export const SYNTHESIS_MAX_WORDS = 60;
export const SYNTHESIS_MAX_SENTENCES = 2;

/** Raisons de rejet observables pour une synthèse (les mêmes que les claims, + paraphrase). */
export type SynthesisRejection = TextRejection;

/**
 * Contrôle de forme d'une synthèse. `evidenceTexts` = textes des fragments
 * réellement cités : sert au refus de paraphrase **et** au contrôle de langue.
 */
export function rejectSynthesis(
  text: string,
  evidenceTexts: string[]
): SynthesisRejection | null {
  return rejectText(text, {
    maxWords: SYNTHESIS_MAX_WORDS,
    maxSentences: SYNTHESIS_MAX_SENTENCES,
    emptyReason: "tooShort",
    minWords: SYNTHESIS_MIN_WORDS,
    evidenceTexts,
  });
}

/** Termes significatifs d'une synthèse (anti-quasi-doublon inter-synthèses). */
export function synthesisTokens(text: string): Set<string> {
  return textTokens(text);
}
