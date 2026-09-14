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

export { NEAR_DUPLICATE_THRESHOLD };

/** Erreurs de forme qui disqualifient un claim. */
export type ClaimRejection = Extract<
  TextRejection,
  "placeholder" | "generic" | "english" | "tooLong"
>;

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
