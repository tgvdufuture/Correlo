/**
 * Barrière déterministe de qualité des claims (Phase 2A).
 *
 * Adaptateur de `lib/quality/text-rules.ts` (module partagé 2A/5A) avec le profil
 * de seuils des claims. Le comportement est **inchangé** depuis la barrière livrée
 * le 2026-09-11 : les runs 2A déjà mesurés restent comparables. Les noms exportés
 * ici sont ceux utilisés par le service de découverte et les tests.
 */

import {
  CLAIM_TEXT_PROFILE,
  isNearDuplicateTokens,
  lexicalContainment,
  normalizeText,
  rejectText,
  textTokens,
  NEAR_DUPLICATE_THRESHOLD,
  type TextRejection,
} from "@/lib/quality/text-rules";
import { claimAnchors } from "@/lib/quality/lexical-anchor";
import { isJuxtapositionClaim } from "@/lib/quality/juxtaposition";

export { NEAR_DUPLICATE_THRESHOLD };

/**
 * Erreurs qui disqualifient un claim.
 *
 * `anchoring` et `juxtaposition` ne sont pas des erreurs de *forme* (d'où leur
 * absence de `TextRejection`) : `anchoring` dépend de la paire de fragments (voir
 * `claimAnchorTerms`), `juxtaposition` de la **structure** de l'énoncé (voir
 * `isJuxtaposition`).
 */
export type ClaimRejection = Extract<
  TextRejection,
  "placeholder" | "generic" | "english" | "tooLong"
> | "anchoring" | "juxtaposition";

/** @see normalizeText */
export const normalizeClaimText = normalizeText;

/** Termes significatifs d'un claim (signature de quasi-doublon). */
export function claimTokens(claim: string): Set<string> {
  return textTokens(claim);
}

/** @see lexicalContainment */
export const claimContainment = lexicalContainment;

/** Vrai si `a` et `b` reformulent la même idée. */
export function isNearDuplicateClaim(a: Set<string>, b: Set<string>): boolean {
  return isNearDuplicateTokens(a, b);
}

/**
 * Contrôle de forme d'un claim avant insertion. Renvoie la raison du rejet,
 * ou null si le claim est acceptable.
 */
export function rejectClaim(claim: string): ClaimRejection | null {
  return rejectText(claim, CLAIM_TEXT_PROFILE) as ClaimRejection | null;
}

/** Contexte d'ancrage : les deux fragments de la paire + la rareté du corpus. */
export interface ClaimAnchorContext {
  textA: string;
  textB: string;
  /** Fréquence documentaire des termes de contenu du corpus (calculée une fois par run). */
  df: ReadonlyMap<string, number>;
  /** Seuil de rareté (`rareThreshold(nbFragments)`). */
  threshold: number;
}

/**
 * Contrôle **d'ancrage lexical** d'un claim, une fois la paire connue : renvoie les
 * termes qui portent la connexion (vide si le claim ne tient pas à un mot partagé).
 *
 * Un claim qui relie les deux fragments par un mot rare présent des deux côtés
 * énonce une connexion *trouvable par recherche par mots-clés* : au sens du
 * protocole Q22 (PRD §4) ce n'est pas une découverte. La règle est celle de
 * l'évaluateur — `lib/quality/lexical-anchor.ts`, source unique.
 */
export function claimAnchorTerms(claim: string, ctx: ClaimAnchorContext): string[] {
  return claimAnchors(claim, ctx.textA, ctx.textB, ctx.df, ctx.threshold);
}

/**
 * Contrôle de **structure** d'un claim : une coordination vide (« X dit A, tandis
 * que Y dit B ») n'énonce aucune relation, donc elle n'apporte rien — c'est le
 * défaut 1 mesuré sur `discovery-v4`, que le prompt seul n'a pas suffi à éteindre.
 *
 * Détecteur déterministe, sans dépendance aux fragments :
 * `lib/quality/juxtaposition.ts` — source unique.
 */
export function isJuxtaposition(claim: string): boolean {
  return isJuxtapositionClaim(claim);
}
