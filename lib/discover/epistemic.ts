import { sha256Hex } from "@/lib/hash";

/** Rangs épistémiques (PRD §3.2) : FACT > INFERENCE > HYPOTHESIS > SPECULATION. */
export const EPISTEMIC_RANK = {
  FACT: 3,
  INFERENCE: 2,
  HYPOTHESIS: 1,
  SPECULATION: 0,
} as const;

export type EpistemicStatus = keyof typeof EPISTEMIC_RANK;

/**
 * Canonicalisation d'un claim (PRD §3.3 content_sig) :
 * NFKC → minuscules → espaces compactés → ponctuation finale supprimée.
 */
export function canonicalizeClaim(claim: string): string {
  let s = claim.normalize("NFKC").toLowerCase();
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.,;:!?…]+$/g, "");
  return s;
}

/** Signature de contenu d'un claim : SHA256(canonical). */
export function contentSig(claim: string): string {
  return sha256Hex(canonicalizeClaim(claim));
}

/**
 * Normalisation du statut à la création (§3.2) : FACT est rétrogradé en
 * INFERENCE si le claim (match normalisé) n'est pas présent textuellement
 * dans l'un des deux fragments cités. Les autres statuts sont conservés.
 */
export function normalizeEpistemicStatus(
  proposed: EpistemicStatus,
  claim: string,
  fragmentAText: string,
  fragmentBText: string
): EpistemicStatus {
  if (proposed !== "FACT") return proposed;
  const c = canonicalizeClaim(claim);
  if (!c) return "INFERENCE";
  const inA = canonicalizeClaim(fragmentAText).includes(c);
  const inB = canonicalizeClaim(fragmentBText).includes(c);
  return inA || inB ? "FACT" : "INFERENCE";
}

/**
 * pair_key (§3.3) : analogy/contradiction = ids triés ; cause = cause_id:effect_id
 * ordonné (causeSide = position du fragment cause dans la paire, fournie par le modèle).
 */
export function pairKeyFor(
  relationType: "analogy" | "contradiction" | "cause",
  aId: string,
  bId: string,
  causeSide: "a" | "b" | null
): string {
  if (relationType === "cause") {
    const causeId = causeSide === "b" ? bId : aId;
    const effectId = causeSide === "b" ? aId : bId;
    return `${causeId}:${effectId}`;
  }
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}