/**
 * Barrière qualité déterministe, partagée entre les claims (Phase 2A) et les
 * synthèses (Phase 5A, amendement v1.3 §2.1-4).
 *
 * Le prompt demande au modèle d'éviter un certain nombre de défauts mesurés sur
 * le corpus réel (claims génériques, ancrage lexical/placeholders, quasi-doublons,
 * texte non francophone, paraphrase d'une preuve). Un petit modèle les ignore
 * régulièrement : ces règles rendent la sortie invalide *côté serveur*, donc les
 * défauts ne peuvent pas atteindre la base. Elles sont volontairement
 * conservatrices : mieux vaut perdre un énoncé douteux (PRD : « il vaut mieux
 * skip qu'un claim faible ») qu'insérer du bruit.
 *
 * Le module ne connaît ni les claims ni les synthèses : il applique un *profil*
 * de règles (`TextRuleProfile`) à un texte. Les profils vivent près de leur phase
 * (`CLAIM_TEXT_PROFILE` ici car 2A est le profil historique, `SYNTHESIS_TEXT_PROFILE`
 * dans `lib/synth/rules.ts`).
 *
 * Il expose en plus `mentionsProtocolReference`, la famille **indexée** des repères de
 * protocole (« le fragment [0] affirme que… »), née avec la conversation de la Phase 6.
 */

/** Raisons pour lesquelles un texte est disqualifié. */
export type TextRejection =
  | "placeholder" // repère technique du prompt (« A soutient que… », « Texte 1 »)
  | "generic" // formule vraie de n'importe quel jeu de textes
  | "english" // rédigé en anglais sur un corpus français
  | "tooLong" // fourre-tout (plusieurs phrases / au-delà du budget de mots)
  | "tooShort" // n'énonce rien (« voir ci-dessus »)
  | "paraphrase"; // recopie une preuve au lieu d'ajouter quelque chose

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

/** Repères techniques du prompt : un énoncé autonome ne cite jamais « A » ou « fragment A ». */
const PLACEHOLDER_PATTERNS = [
  /\bfragments?\s+[ab]\b/i,
  /\btextes?\s+[ab12]\b/i,
  /\bpassages?\s+[ab12]\b/i,
  /\b(?:premier|second|deuxieme|deuxième)\s+(?:fragment|texte|passage)\b/i,
  /(^|[\s(:«"])[ab](?=[\s,;:)»"]|$)\s*(?:soutient|affirme|declare|déclare|montre|explique|propose|juge|defend|défend|contredit|enonce|énonce|decrit|décrit)\b/i,
];

/**
 * Repères de **protocole** dans la prose d'une réponse conversationnelle (Phase 6).
 *
 * Mesuré sur le premier tour réel de la Phase 6 (2026-09-19, base jetable, `qwen3.8-27b`) :
 * la réponse affichée commençait par « **Le fragment [0] affirme que** la vérité ne peut
 * être anéantie… Le fragment [1] indique que… ». Or `messages.text` **est** l'union des
 * affirmations : l'indice de catalogue est un protocole serveur (le modèle ne voit jamais
 * d'identifiant de fragment), il n'a rien à faire dans ce qui est lu par un humain. Les
 * `PLACEHOLDER_PATTERNS` historiques ne l'attrapaient pas : ils visent « fragment A »,
 * « Texte 1 »… pas la famille **indexée** `[0]`, qui n'existe qu'en Phase 6.
 *
 * Volontairement **hors** des profils partagés (`rejectText`) : y ajouter un motif
 * disqualifierait rétroactivement des claims 2A et des synthèses 5A déjà mesurés et
 * rendrait leurs runs non comparables. Cette famille est donc appliquée par la
 * conversation seule, via `mentionsProtocolReference`.
 */
const CATALOGUE_REFERENCE_PATTERNS = [
  /\[\s*\d+\s*\]/, // « le fragment [0] affirme que… », « voir [12] »
  /\b(?:fragments?|extraits?|passages?|documents?)\s+(?:n[°o]\s*)?\d+\b/i, // « le fragment 2 », « document n°3 »
];

/**
 * Vrai si le texte parle du **protocole** au lieu du sujet : indice de catalogue, repère
 * générique (« Texte 1 », « A soutient que »). C'est le refus `reponse_avec_repere_technique`
 * de la conversation (recoverable : le modèle réécrit ce qu'il voulait dire).
 */
export function mentionsProtocolReference(text: string): boolean {
  return [...PLACEHOLDER_PATTERNS, ...CATALOGUE_REFERENCE_PATTERNS].some((re) => re.test(text));
}

const EN_STOPWORDS = new Set(
  `the of and is are that with which this both between from as its their was were has have not for but they these those when where while more than also such can may would could should about into over under
   he she his her him them we you your our it's don't`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Mots outils français + termes trop fréquents pour servir de signature
 * (quasi-doublons).
 *
 * Les **déterminants quantifieurs** (`aucune`, `plusieurs`, `quelques`…) y figurent
 * explicitement : longs d'au moins 5 lettres, ils passaient la longueur minimale et
 * étaient traités comme des termes de contenu. Conséquence mesurée sur le run
 * `jux-v2` : `…les corps n'a aucune spontanéité; …le corps ne montre aucune force…`
 * était considéré comme partageant un concept (« aucune »), donc épargné par la
 * règle de juxtaposition — un mot grammatical sauvait une coordination vide.
 */
const FR_STOPWORDS = new Set(
  `le la les un une des du de d au aux a et ou mais or donc car ni que qui quoi dont ou quand comme si
   ce cet cette ces celui celle ceux celles il elle ils elles on nous vous je tu se sa son ses leur leurs
   mon ma mes ton ta tes notre nos votre vos est sont etait etaient ete etre avoir a ont avait avaient aura
   peut peuvent doit doivent fait font dire dit selon ainsi alors aussi autre autres meme memes tout tous toute toutes
   plus moins tres bien tres dans sur sous entre vers chez pour par avec sans apres avant depuis pendant
   pas ne non oui deja encore toujours jamais souvent parfois surtout presque ici la-bas
   aucun aucune aucuns aucunes plusieurs quelque quelques certains certaines chaque
   fragment texte texte1 texte2 extrait passage auteur oeuvre livre page the and of is are that with which`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Normalisation partagée avec l'évaluateur (scripts/evaluate-phase-2a.mjs) :
 * minuscules, accents retirés, ponctuation transformée en espaces.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Termes significatifs d'un texte (signature de quasi-doublon et de paraphrase).
 * `minLength` 5 écarte les résidus de césure/OCR (« é-tait » → « tait »).
 */
export function textTokens(
  text: string,
  opts?: { minLength?: number; stopwords?: Set<string> }
): Set<string> {
  const minLength = opts?.minLength ?? 5;
  const stopwords = opts?.stopwords ?? FR_STOPWORDS;
  return new Set(
    normalizeText(text)
      .split(/\s+/)
      .filter((w) => w.length >= minLength && !stopwords.has(w) && !/^\d+$/.test(w))
  );
}

/**
 * Recouvrement lexical (0–1) : part des termes du plus court ensemble présents
 * dans l'autre. 0,6 attrape « même idée reformulée » sans fusionner des textes
 * qui ne partagent qu'un mot.
 */
export function lexicalContainment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

export const NEAR_DUPLICATE_THRESHOLD = 0.6;

/**
 * Seuil de paraphrase : au-delà, l'énoncé ne fait que redire une preuve (tous ses
 * termes significatifs viennent d'un seul fragment). Plus permissif que le
 * quasi-doublon, car une synthèse légitime réutilise le vocabulaire de ses preuves.
 */
export const PARAPHRASE_THRESHOLD = 0.85;

/** Vrai si `a` et `b` reformulent la même idée (signatures suffisamment proches). */
export function isNearDuplicateTokens(a: Set<string>, b: Set<string>): boolean {
  if (Math.min(a.size, b.size) < 3) return false;
  return lexicalContainment(a, b) >= NEAR_DUPLICATE_THRESHOLD;
}

/** Un énoncé qui recopie une seule preuve n'ajoute rien. */
export function isParaphraseOf(terms: Set<string>, evidenceTexts: string[]): boolean {
  if (terms.size < 3) return false;
  return evidenceTexts.some((t) => {
    const ev = textTokens(t);
    if (ev.size < 3) return false;
    return lexicalContainment(terms, ev) >= PARAPHRASE_THRESHOLD;
  });
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Phrases d'un texte (« une phrase. » = 1 ; la ponctuation seule ne compte pas). */
export function countSentences(text: string): number {
  return text
    .trim()
    .split(/[.!?…]+\s+/)
    .filter((s) => s.trim().length > 0).length;
}

/** Un texte majoritairement composé de mots outils anglais est en anglais. */
export function looksEnglish(text: string, minStopwords = 3): boolean {
  const tokens = normalizeText(text).split(/\s+/);
  return tokens.filter((w) => EN_STOPWORDS.has(w)).length >= minStopwords;
}

/** Profil de règles appliqué à un texte : les seuils dépendent de la phase. */
export interface TextRuleProfile {
  /** Au-delà → « tooLong ». */
  maxWords: number;
  maxSentences: number;
  /** Raison renvoyée pour un texte vide (les claims répondent « generic », pas « tooShort »). */
  emptyReason: "generic" | "tooShort";
  /** En dessous → « tooShort » (un énoncé doit porter une proposition). */
  minWords?: number;
  /** Nombre de mots outils anglais déclenchant « english ». */
  englishStopwordMin?: number;
  /**
   * Marqueurs de généralité **supplémentaires**, ajoutés au socle
   * `GENERIC_MARKERS` pour ce profil seul — permet à une phase d'interdire des
   * formules qu'une autre doit tolérer (les claims et les synthèses ne partagent
   * pas les mêmes).
   */
  extraGenericMarkers?: string[];

  /**
   * Si fourni, un recouvrement lexical ≥ `PARAPHRASE_THRESHOLD` avec l'une des
   * preuves → « paraphrase ». Absent pour les claims (une paire n'est pas censée
   * paraphraser un fragment : c'est justement le défaut d'ancrage lexical qui est
   * traité par les marqueurs génériques et le prompt).
   */
  evidenceTexts?: string[];
}

/**
 * Contrôle de forme d'un texte avant insertion. Renvoie la raison du rejet,
 * ou null si le texte est acceptable.
 */
export function rejectText(text: string, profile: TextRuleProfile): TextRejection | null {
  const trimmed = text.trim();
  if (!trimmed) return profile.emptyReason;

  const words = countWords(trimmed);
  if (profile.minWords !== undefined && words < profile.minWords) return "tooShort";
  if (countSentences(trimmed) > profile.maxSentences || words > profile.maxWords) return "tooLong";

  if (PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed))) return "placeholder";
  const norm = normalizeText(trimmed);
  const markers = profile.extraGenericMarkers
    ? [...GENERIC_MARKERS, ...profile.extraGenericMarkers]
    : GENERIC_MARKERS;
  if (markers.some((m) => norm.includes(m))) return "generic";
  if (looksEnglish(trimmed, profile.englishStopwordMin)) return "english";

  if (profile.evidenceTexts && profile.evidenceTexts.length > 0) {
    if (isParaphraseOf(textTokens(trimmed), profile.evidenceTexts)) return "paraphrase";
  }
  return null;
}

/**
 * Profil des claims (Phase 2A) — seuils numériques inchangés depuis la barrière
 * livrée le 2026-09-11 : les modifier invaliderait la comparabilité des runs déjà
 * mesurés.
 *
 * `extraGenericMarkers` (2026-09-15) ajoute la famille des **formules de
 * comparaison** : « montrant deux modèles d'autorité », « même logique »… Ce sont
 * des formules vraies de n'importe quelle paire de textes, exactement comme « les
 * deux auteurs » — et elles étaient mesurées comme telles dans le run jux-v1 (le
 * claim `Monsieur Roger…; …montrant deux modèles d'autorité.` a survécu à la
 * barrière). Elles sont volontairement **propres aux claims** et non ajoutées au
 * socle `GENERIC_MARKERS` : celui-ci est partagé avec les synthèses (5A), dont les
 * runs validés restent comparables.
 */
export const CLAIM_TEXT_PROFILE: TextRuleProfile = {
  maxWords: 40,
  maxSentences: 2,
  emptyReason: "generic",
  extraGenericMarkers: [
    "montrant deux",
    "deux modeles",
    "deux conceptions",
    "deux approches",
    "deux visions",
    "deux formes de",
    "meme logique",
    "meme mecanisme",
    "meme fonction",
    "meme principe",
    "de la meme facon",
  ],
};
