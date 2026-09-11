/**
 * Barrière déterministe de qualité des claims (Phase 2A).
 *
 * Le prompt demande au modèle d'éviter 4 défauts observés sur le corpus réel
 * (claims génériques, ancrage lexical, quasi-doublons, claims non francophones).
 * Un petit modèle les ignore régulièrement : ces règles rendent la sortie
 * invalide *côté serveur*, donc les défauts ne peuvent pas atteindre la base.
 * Elles sont volontairement conservatrices : mieux vaut perdre un claim douteux
 * (PRD : « il vaut mieux skip qu'un claim faible ») qu'insérer du bruit.
 */

/** Erreurs de forme qui disqualifient un claim. */
export type ClaimRejection =
  | "placeholder" // repère technique du prompt (« A soutient que… », « fragment B »)
  | "generic" // formule vraie de n'importe quelle paire de textes
  | "english" // claim rédigé en anglais sur un corpus français
  | "tooLong"; // claim fourre-tout (plusieurs phrases / > 40 mots)

/** Marqueurs de généralité (normalisés : sans accent, minuscules, ponctuation en espaces). */
const GENERIC_MARKERS = [
  "les deux auteurs",
  "les deux textes",
  "les deux fragments",
  "les deux oeuvres",
  "tous deux",
  "l un et l autre",
  "les deux ecrivains",
  "partagent un",
  "partagent la meme",
  "partagent une",
  "accordent une importance",
  "soulignent que",
  "soulignent tous",
  "mettent en avant",
  "mettent tous",
  "insistent sur le fait",
  "s inspirent de",
  "s inspire de",
  "influence reciproque",
  "figure d autorite",
  "relation maitre",
  "rapport maitre",
  "maitre et eleve",
  "maitre et apprenti",
  "maitre et son eleve",
  "maitre de classe",
  "illustrent un meme",
  "partagent une vision",
  "de la meme maniere",
  "de maniere similaire",
  "traite de la meme",
  "est un theme commun",
];

/** Repères techniques du prompt : un claim autonome ne cite jamais « A » ou « fragment A ». */
const PLACEHOLDER_PATTERNS = [
  /\bfragments?\s+[ab]\b/i,
  /\btextes?\s+[ab12]\b/i,
  /\bpassages?\s+[ab12]\b/i,
  /\b(?:premier|second|deuxieme|deuxième)\s+(?:fragment|texte|passage)\b/i,
  /(^|[\s(:«"])[ab](?=[\s,;:)»"]|$)\s*(?:soutient|affirme|declare|déclare|montre|explique|propose|juge|defend|défend|contredit|enonce|énonce|decrit|décrit)\b/i,
];

const EN_STOPWORDS = new Set(
  `the of and is are that with which this both between from as its their was were has have not for but they these those when where while more than also such can may would could should about into over under
   he she his her him them we you your our it's don't`
    .split(/\s+/)
    .filter(Boolean)
);

/** Mots outils français + termes trop fréquents pour servir de signature (quasi-doublons). */
const FR_STOPWORDS = new Set(
  `le la les un une des du de d au aux a et ou mais or donc car ni que qui quoi dont ou quand comme si
   ce cet cette ces celui celle ceux celles il elle ils elles on nous vous je tu se sa son ses leur leurs
   mon ma mes ton ta tes notre nos votre vos est sont etait etaient ete etre avoir a ont avait avaient aura
   peut peuvent doit doivent fait font dire dit selon ainsi alors aussi autre autres meme memes tout tous toute toutes
   plus moins tres bien tres dans sur sous entre vers chez pour par avec sans apres avant depuis pendant
   pas ne non oui deja encore toujours jamais souvent parfois surtout presque ici la-bas
   fragment texte texte1 texte2 extrait passage auteur oeuvre livre page the and of is are that with which`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Normalisation identique à celle de l'évaluateur (scripts/evaluate-phase-2a.mjs) :
 * minuscules, accents retirés, ponctuation transformée en espaces.
 */
export function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Termes significatifs d'un claim (signature de quasi-doublon). */
export function claimTokens(claim: string): Set<string> {
  return new Set(
    normalizeClaimText(claim)
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !FR_STOPWORDS.has(w) && !/^\d+$/.test(w))
  );
}

/**
 * Recouvrement lexical (0–1) : part des termes du plus court ensemble présents
 * dans l'autre. 0,6 attrape « même idée reformulée » sans fusionner des claims
 * qui ne partagent qu'un mot.
 */
export function claimContainment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

export const NEAR_DUPLICATE_THRESHOLD = 0.6;

/** Vrai si `a` et `b` reformulent la même idée (signatures suffisamment proches). */
export function isNearDuplicateClaim(a: Set<string>, b: Set<string>): boolean {
  if (Math.min(a.size, b.size) < 3) return false;
  return claimContainment(a, b) >= NEAR_DUPLICATE_THRESHOLD;
}

/**
 * Contrôle de forme d'un claim avant insertion. Renvoie la raison du rejet,
 * ou null si le claim est acceptable.
 */
export function rejectClaim(claim: string): ClaimRejection | null {
  const trimmed = claim.trim();
  if (!trimmed) return "generic";
  // fourre-tout : plusieurs phrases ou plus de 40 mots (le claim doit être bref)
  const sentences = trimmed.split(/[.!?…]+\s+/).filter((s) => s.trim().length > 0);
  if (sentences.length > 2 || trimmed.split(/\s+/).length > 40) return "tooLong";

  const norm = normalizeClaimText(trimmed);
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed))) return "placeholder";
  if (GENERIC_MARKERS.some((m) => norm.includes(m))) return "generic";

  const tokens = norm.split(/\s+/);
  if (tokens.filter((w) => EN_STOPWORDS.has(w)).length >= 3) return "english";
  return null;
}
