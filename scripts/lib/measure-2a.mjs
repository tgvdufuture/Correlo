/**
 * Mesure d'évaluation Phase 2A (protocole Q22), version 2.
 *
 * La mesure v1 appliquait littéralement le PRD : « non-évidente = introuvable par
 * recherche par mots-clés dans les deux sources », opérationnalisé par un unique
 * signal — les deux fragments partagent au moins un terme rare du corpus
 * (fréquence documentaire ≤ 2 %). Le run de validation du 2026-09-14 a montré que
 * ce signal unique se laisse exploiter sur deux axes :
 *
 *  1. **Ancrage lexical fabriqué.** Le modèle peut fabriquer lui-même le mot-clé
 *     qui relie les deux textes (« recommandation », « ridicule ») sans que ce mot
 *     soit partagé à l'identique par les fragments. La connexion reste trouvable
 *     par recherche par mots-clés, donc évidente au sens du PRD — la v1 ne la
 *     voyait pas.
 *  2. **Redondance de couples de sources.** Compter les suggestions une à une
 *     récompense la répétition : un sampler qui produit huit variantes du même
 *     couple (Bernard × Descartes) bat un sampler qui produit une connexion sur
 *     douze couples différents. Or le PRD parle de « connexions non évidentes » et
 *     compare les samplers sur ce qu'ils font *découvrir* ; un couple déjà relié ne
 *     l'est pas une seconde fois.
 *
 * La règle d'ancrage vit dans `lib/quality/lexical-anchor.ts` — la **même** que la
 * barrière serveur (`lib/discover/claim-rules.ts`) : sinon la barrière ne filtrerait
 * pas ce que la mesure compte. Ce fichier n'ajoute que la logique d'évaluation
 * (jugement, plafond de découverte) et la réexporte pour l'évaluateur et ses tests.
 *
 * Module pur (aucun accès base/IO) : les seuils sont figés dans le module partagé
 * pour que le run soit rejouable à l'identique.
 */
import {
  ANCHOR_RARE_DF_RATIO,
  ANCHOR_STEM_LENGTH,
  ANCHOR_STOPWORDS,
  claimAnchors,
  contentWords,
  documentFrequency,
  hasLexicalAnchor,
  isRare,
  normalizeText,
  rareThreshold,
  sharedRareTerms,
  stemOf,
} from "../../lib/quality/lexical-anchor.ts";

export {
  ANCHOR_RARE_DF_RATIO as RARE_DF_RATIO,
  ANCHOR_STEM_LENGTH as STEM_LENGTH,
  ANCHOR_STOPWORDS as STOPWORDS,
  claimAnchors,
  contentWords,
  documentFrequency,
  hasLexicalAnchor,
  isRare,
  normalizeText,
  rareThreshold,
  sharedRareTerms,
  stemOf,
};

/** Identifiant de la mesure — consigné dans le rapport, à incrémenter si les règles changent. */
export const MEASURE_VERSION = "measure-2a-v2";

/**
 * Juge une suggestion : évidente (trouvable par mots-clés) ou non évidente.
 * @param {{ claim: string, textA: string, textB: string }} s
 * @param {{ df: Map<string, number>, threshold: number }} ctx
 * @returns {{ grade: "non_evidente" | "correcte_evidente", sharedRareTerms: string[], claimAnchors: string[] }}
 */
export function judgeSuggestion(s, ctx) {
  const shared = sharedRareTerms(s.textA, s.textB, ctx.df, ctx.threshold);
  const anchors = claimAnchors(s.claim, s.textA, s.textB, ctx.df, ctx.threshold);
  const evident = shared.length > 0 || anchors.length > 0;
  return {
    grade: evident ? "correcte_evidente" : "non_evidente",
    sharedRareTerms: shared,
    claimAnchors: anchors,
  };
}

/**
 * Clé de couple de sources : non ordonnée (a×b et b×a sont la même connexion).
 * @param {string} sourceA
 * @param {string} sourceB
 * @returns {string}
 */
export function sourcePairKey(sourceA, sourceB) {
  return [sourceA, sourceB].sort().join("|");
}

/**
 * Pénalité de redondance : parmi les suggestions non évidentes d'un même run, une
 * seule — la première dans l'ordre du run — porte le crédit de découverte pour un
 * couple de sources donné. Les suivantes sont rapportées comme redondantes.
 *
 * @param {{ runId: string, pairKey: string, nonEvidente: boolean }[]} entries ordre stable du run
 * @returns {boolean[]} crédit de découverte, aligné sur `entries`
 */
export function discoveryCredits(entries) {
  const credited = new Set();
  return entries.map((e) => {
    if (!e.nonEvidente) return false;
    const key = `${e.runId}::${e.pairKey}`;
    if (credited.has(key)) return false;
    credited.add(key);
    return true;
  });
}
