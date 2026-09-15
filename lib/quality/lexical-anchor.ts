/**
 * Détection d'**ancrage lexical** (Phase 2A) — règle unique, partagée.
 *
 * Un claim est « ancré lexicalement » quand la connexion qu'il énonce ne tient qu'à
 * un mot présent des deux côtés : le modèle fabrique le mot-clé qui relie les deux
 * textes (« l'élève recommandé ↔ des lettres de recommandation », « l'agent qui
 * guérit ↔ le sourire comme remède »). La connexion est alors *trouvable par
 * recherche par mots-clés*, donc **évidente au sens du protocole Q22** — ce n'est
 * pas une découverte, c'est un mot partagé.
 *
 * Deux différences avec un simple « mot en commun » :
 *  1. la **rareté** est exigée (fréquence documentaire ≤ 2 % du corpus). Un terme
 *     banal des deux côtés (« corps », « existence ») ramène des centaines de
 *     fragments : il ne relie rien et ne doit pas disqualifier une connexion ;
 *  2. la comparaison se fait **à la racine près** (préfixe de 5 lettres), car le
 *     mot partagé change souvent de forme — flexion (« recommandé » / « recommandation »),
 *     voire traduction anglaise d'un côté (*Madame Bovary* est ingéré en anglais) —
 *     et le claim peut nommer une forme absente de l'un des fragments.
 *
 * **Ce module est la source unique** : la barrière serveur
 * (`lib/discover/claim-rules.ts`, branchée dans `discovery-service`) et
 * l'évaluateur (`scripts/lib/measure-2a.mjs`, protocole Q22) appellent les mêmes
 * fonctions — sinon la barrière ne filtrerait pas ce que la mesure compte. Il est
 * volontairement **sans import** : le script d'évaluation est du JavaScript nu
 * exécuté par Node (pas de bundler, pas d'alias `@/`), il ne peut charger que ce
 * module tel quel.
 */

/** Longueur du préfixe servant de racine approximative (« recommandation »/« recommande »). */
export const ANCHOR_STEM_LENGTH = 5;

/** Fenêtre de rareté : un terme est rare si sa fréquence documentaire ≤ 2 % du corpus. */
export const ANCHOR_RARE_DF_RATIO = 0.02;

/**
 * Mots outils français + termes trop fréquents pour servir de signature.
 * Liste **figée** : la modifier change la mesure et invalide la comparabilité des
 * runs 2A déjà évalués.
 */
export const ANCHOR_STOPWORDS: ReadonlySet<string> = new Set(
  `alors autre aussi avaient avons avoir avec ceci cette comme dans depuis des deux doit donc dont elle elles encore entre etaient etait etant etre faire fait font leurs mais meme mes moins nous parce plus pour quand que quel quelle quelles quels qui sans ses seulement sous sont sur tous tout toute toutes une vers votre vous ainsi avoir etre fait dire plus tres bien peut peuvent doit doivent celui celle ceux celles chaque lorsqu apres avant entre selon toutefois cependant cependant notamment notamment environ toujours jamais jamais souvent parfois surtout presque passe present futur exemple sens partie point forme homme hommes chose choses temps monde raison nature etat fait force loi lois science sciences livre page texte edition oeuvre auteur ecrit ecrire dit selon selon grande grand petit petite premier premiere dernier derniere trois quatre cinq six sept huit neuf`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Normalisation : minuscules, accents retirés, ponctuation transformée en espaces.
 * Identique à `normalizeText` de `lib/quality/text-rules.ts` du point de vue des
 * ensembles de termes (seule la compression des espaces diffère, sans effet sur la
 * tokenisation) — laissée telle quelle ici pour ne pas déplacer la mesure.
 */
export function normalizeText(text: string): string {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
}

/** Termes de contenu d'un texte (≥ 5 lettres, hors mots outils, hors nombres). */
export function contentWords(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !ANCHOR_STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Racine approximative d'un terme : son préfixe. Suffit pour rattacher les
 * flexions sans racinisateur, donc sans dépendance ni irrégularité entre plateformes.
 */
export function stemOf(word: string): string {
  return word.slice(0, ANCHOR_STEM_LENGTH);
}

/** Fréquence documentaire des termes de contenu d'un corpus. */
export function documentFrequency(fragmentTexts: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const text of fragmentTexts) {
    for (const w of new Set(contentWords(text ?? ""))) df.set(w, (df.get(w) ?? 0) + 1);
  }
  return df;
}

/** Seuil de rareté (fréquence documentaire maximale) pour un corpus de `fragmentCount` fragments. */
export function rareThreshold(fragmentCount: number): number {
  return Math.max(1, Math.round(fragmentCount * ANCHOR_RARE_DF_RATIO));
}

/** Vrai si le terme est rare dans le corpus (donc sélectif comme mot-clé). */
export function isRare(word: string, df: ReadonlyMap<string, number>, threshold: number): boolean {
  return (df.get(word) ?? 0) <= threshold;
}

/** Termes rares partagés *littéralement* par les deux fragments (signal « mots-clés » direct). */
export function sharedRareTerms(
  textA: string,
  textB: string,
  df: ReadonlyMap<string, number>,
  threshold: number
): string[] {
  const a = new Set(contentWords(textA));
  const b = new Set(contentWords(textB));
  return [...a].filter((w) => b.has(w) && isRare(w, df, threshold));
}

/** Vrai si un terme du claim a un homologue de même racine, rare, dans `words`. */
function hasRareStemMate(
  word: string,
  words: string[],
  df: ReadonlyMap<string, number>,
  threshold: number
): boolean {
  return words.some(
    (x) => stemOf(x) === stemOf(word) && (isRare(word, df, threshold) || isRare(x, df, threshold))
  );
}

/**
 * **Ancres lexicales du claim** : termes distinctifs employés pour relier les deux
 * textes, dont la racine est présente des deux côtés. Liste vide = connexion qui ne
 * tient pas à un mot partagé.
 */
export function claimAnchors(
  claim: string,
  textA: string,
  textB: string,
  df: ReadonlyMap<string, number>,
  threshold: number
): string[] {
  const sideA = contentWords(textA);
  const sideB = contentWords(textB);
  return [...new Set(contentWords(claim))].filter(
    (w) => hasRareStemMate(w, sideA, df, threshold) && hasRareStemMate(w, sideB, df, threshold)
  );
}

/** Vrai si le claim est ancré lexicalement (au moins une ancre). */
export function hasLexicalAnchor(
  claim: string,
  textA: string,
  textB: string,
  df: ReadonlyMap<string, number>,
  threshold: number
): boolean {
  return claimAnchors(claim, textA, textB, df, threshold).length > 0;
}
