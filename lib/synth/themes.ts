import { kMeansVectors, mulberry32 } from "@/lib/cluster/kmeans";

/**
 * Thèmes déduits du corpus (PRD v1.3, Phase 5A §2.1).
 *
 * Aucun domaine n'est codé en dur et aucun appel réseau n'est fait : les thèmes
 * sont des clusters d'embeddings LOCAUX, et leur libellé est calculé par TF-IDF
 * (pas de LLM) — donc gratuit, reproductible et agnostique au sujet du corpus.
 * Un même (fragments, seed) produit toujours exactement les mêmes thèmes.
 */

/** Version de l'algorithme de thèmes — à incrémenter si la sélection change. */
export const THEME_SAMPLER_VERSION = "themes-v1";

/** Un thème pour ~25 fragments, borné : petit corpus → 4 thèmes, gros → 24. */
export const FRAGMENTS_PER_THEME = 25;
export const THEME_COUNT_MIN = 4;
export const THEME_COUNT_MAX = 24;

export interface ThemeFragment {
  id: string;
  sourceId: string;
  chunkIndex: number;
  text: string;
  /** Embedding Float32 L2-normalisé (comme en base). */
  embedding: Float32Array;
}

export interface Theme {
  /** Index dans le tableau `themes` renvoyé. */
  index: number;
  /** Libellé TF-IDF (ex. « brutalisme · béton · façade »), jamais vide. */
  label: string;
  size: number;
  centroid: Float32Array;
  fragmentIds: string[];
}

export interface BuildThemesOptions {
  fragments: ThemeFragment[];
  /** SHA-256(corpus_hash | run_id) — même seed ⇒ mêmes thèmes, fragment pour fragment. */
  seedHex: string;
  /** Défaut : themeCountFor(nbFragments). */
  k?: number;
  iterations?: number;
  labelTerms?: number;
  /** Un thème doit pouvoir porter une synthèse : ≥ 2 fragments de ≥ 2 sources. */
  minClusterSize?: number;
  minClusterSources?: number;
}

export interface BuildThemesResult {
  themes: Theme[];
  /** Thème de chaque fragment de l'ENTRÉE (parallèle à `fragments`) ; -1 = écarté. */
  assignment: number[];
  k: number;
}

/** Nombre de thèmes visé : clamp(round(n / 25), 4, 24) ; 0 pour un corpus vide. */
export function themeCountFor(fragmentCount: number): number {
  if (fragmentCount <= 0) return 0;
  const raw = Math.round(fragmentCount / FRAGMENTS_PER_THEME);
  return Math.max(THEME_COUNT_MIN, Math.min(THEME_COUNT_MAX, raw));
}

/**
 * Clusters de fragments → thèmes. Les clusters trop petits ou mono-source sont
 * écartés (un thème mono-source ne peut pas produire de synthèse multi-sources).
 */
export function buildThemes(opts: BuildThemesOptions): BuildThemesResult {
  const minSize = opts.minClusterSize ?? 2;
  const minSources = opts.minClusterSources ?? 2;
  const labelTerms = opts.labelTerms ?? 4;
  const n = opts.fragments.length;
  if (n === 0) return { themes: [], assignment: [], k: 0 };

  // ordre d'itération déterministe, avec l'index d'entrée conservé pour le remappage
  const indexed = opts.fragments.map((f, inputIndex) => ({ f, inputIndex }));
  indexed.sort(
    (x, y) =>
      x.f.sourceId.localeCompare(y.f.sourceId) ||
      x.f.chunkIndex - y.f.chunkIndex ||
      x.f.id.localeCompare(y.f.id)
  );
  const ordered = indexed.map((x) => x.f);

  const k = opts.k ?? themeCountFor(n);
  const rng = mulberry32(parseInt(opts.seedHex.slice(0, 8), 16) || 1);
  const { assignment: rawAssignment, centroids } = kMeansVectors(
    ordered.map((f) => f.embedding),
    k,
    rng,
    { iterations: opts.iterations ?? 8 }
  );

  // fréquence documentaire globale (1 « document » = 1 fragment) pour le TF-IDF
  const df = new Map<string, number>();
  for (const f of ordered) {
    for (const term of new Set(tokenize(f.text))) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const groups = new Map<number, number[]>();
  rawAssignment.forEach((cluster, i) => {
    const members = groups.get(cluster);
    if (members) members.push(i);
    else groups.set(cluster, [i]);
  });

  const themes: Theme[] = [];
  const clusterToTheme = new Map<number, number>();
  for (const cluster of [...groups.keys()].sort((a, b) => a - b)) {
    const members = groups.get(cluster) as number[];
    const sources = new Set(members.map((i) => ordered[i].sourceId));
    if (members.length < minSize || sources.size < minSources) continue;
    const index = themes.length;
    clusterToTheme.set(cluster, index);
    themes.push({
      index,
      label: labelCluster(
        members.map((i) => ordered[i].text),
        df,
        n,
        labelTerms,
        index
      ),
      size: members.length,
      centroid: centroids[cluster],
      fragmentIds: members.map((i) => ordered[i].id),
    });
  }

  const assignment = new Array<number>(n).fill(-1);
  indexed.forEach((x, orderedIndex) => {
    const theme = clusterToTheme.get(rawAssignment[orderedIndex]);
    if (theme !== undefined) assignment[x.inputIndex] = theme;
  });
  return { themes, assignment, k };
}

/**
 * Libellé d'un cluster : termes les plus DISCRIMINANTS (TF-IDF), pas les plus
 * fréquents du corpus. `tf` = nombre de fragments du cluster contenant le terme.
 */
export function labelCluster(
  texts: string[],
  df: Map<string, number>,
  corpusSize: number,
  terms = 4,
  themeIndex = 0
): string {
  const tf = new Map<string, number>();
  for (const text of texts) {
    // présence par fragment (pas le comptage brut) : évite le biais des fragments longs
    for (const term of new Set(tokenize(text))) tf.set(term, (tf.get(term) ?? 0) + 1);
  }
  const scored = [...tf.entries()]
    .map(([term, count]) => ({
      term,
      score: (count / Math.max(1, texts.length)) * Math.log((corpusSize + 1) / ((df.get(term) ?? 0) + 1)),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const picked = scored.slice(0, terms).map((s) => s.term);
  return picked.length > 0 ? picked.join(" · ") : `Thème ${themeIndex + 1}`;
}

/** Termes significatifs d'un texte pour les libellés (minuscules, sans accents). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    // longueur ≥ 5 : écarte les résidus de césure/OCR (« é-tait » → « tait ») qui
    // polluaient les libellés du corpus réel sans rien dire du thème
    .filter((w) => w.length >= 5 && !/^\d+$/.test(w) && !LABEL_STOPWORDS.has(w));
}

/**
 * Mots vides pour les LIBELLÉS : mots-outils français + vocabulaire générique du
 * document (texte, auteur, chapitre…) qui ne dit rien du sujet du thème.
 */
export const LABEL_STOPWORDS = new Set(
  `avait avaient aura aurait auraient soit soient fut furent sera serait seront
   tait taient etait etaient ete etre avoir ayant eu
   alors apres aussi autre autres avant avec avoir bien car cas ce cet cette ces chaque chez
   comme comment dans depuis des deux doit doivent donc dont elle elles encore entre est etait etaient ete etre
   eux fait faire faites fois font hors ici il ils jamais je jusqu leur leurs lorsque mais meme mes moins
   mon ne nos notre nous on ont ou oui par parce pas peut peuvent plus plusieurs pour pourquoi
   quand que quel quelle quelles quels qui quoi sans se ses si son sont sous souvent sur ta tandis tant te tes
   toi toujours ton tres trop tu un une vers vos votre vous y a au aux du de la le les
   ainsi cependant donc enfin ensuite etc exemple partie point sujet propos egard travers
   texte textes extrait extraits passage passages fragment fragments auteur auteurs oeuvre oeuvres
   livre livres page pages chapitre chapitres edition editions tome volume note notes
   citation citations paragraphe paragraphes ligne lignes mot mots phrase phrases
   premier premiere premiers premieres dernier derniere derniers dernieres
   apres avant depuis toutefois neanmoins pourtant cependant notamment surtout
   doit doit-on peut-on faut-il s agit s'agit`
    .split(/\s+/)
    .filter(Boolean)
);
