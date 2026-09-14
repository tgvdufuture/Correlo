import { dotProduct } from "@/lib/cluster/kmeans";

/**
 * Sélection des preuves d'un thème (PRD v1.3, Phase 5A §2.1-2).
 *
 * Objectif : un jeu de preuves **cohérent ET divers**.
 *
 * La tension est réelle. Maximiser la diversité seule fait retenir les membres
 * les plus périphériques du cluster, or sur un thème fourre-tout ceux-ci sont des
 * **points aberrants** (frontispice, page de titre, sommaire) et non des membres
 * représentatifs : le modèle reçoit alors quatre textes sans rapport et ne peut
 * énoncer aucune synthèse. Symétriquement, prendre les plus proches du centroïde
 * reproduit le baseline trivial « top-k cosine » (quatre quasi-doublons).
 *
 * Quatre règles, toutes déterministes :
 *   1. **bande de cohérence** — les `outlierQuantile` membres les plus atypiques
 *      (les plus éloignés du centroïde) sont écartés avant la sélection. On
 *      diversifie donc *à l'intérieur* de la partie réellement cohérente du
 *      thème. Mesuré sur le corpus réel : la cosine minimale entre preuves passe
 *      de 0,56–0,67 à 0,69–0,75 sans perte de sources.
 *   2. **une seule preuve par source** (≥ 2 sources distinctes) — jamais un thème
 *      illustré deux fois par le même document ;
 *   3. **preuves prises aux extrémités du noyau** : on part du fragment le plus
 *      périphérique du noyau (jamais le plus « typique »), puis on ajoute à chaque
 *      fois le plus éloigné des preuves déjà retenues (farthest-point sampling) ;
 *   4. **garde-fou de redondance** : une preuve quasi identique à une preuve déjà
 *      retenue (cosine > `redundancyThreshold`) est écartée.
 */

export interface EvidenceFragment {
  id: string;
  sourceId: string;
  chunkIndex: number;
  /** Titre de section fourni par le chunker (`#FOOTNOTES`, `#NOTES`, `#TABLE DES MATIÈRES`…). */
  locator?: string;
  text: string;
  /** Embedding Float32 L2-normalisé (comme en base). */
  embedding: Float32Array;
}

export interface SelectEvidenceOptions<T extends EvidenceFragment = EvidenceFragment> {
  /** Fragments du thème (membres du cluster). */
  fragments: T[];
  /** Centroïde du thème ; recalculé sur les membres si absent. */
  centroid?: Float32Array;
  /** Preuves minimales (défaut 2) — en dessous, le thème est inexploitable. */
  minEvidence?: number;
  /** Preuves maximales (défaut 4). */
  maxEvidence?: number;
  /** Cosine au-delà de laquelle deux preuves sont considérées redondantes (défaut 0,97). */
  redundancyThreshold?: number;
  /**
   * Fraction des membres les plus atypiques écartée avant sélection (défaut 0,25 ;
   * 0 = désactivé). Sur un cluster serré la bande ne change presque rien ; sur un
   * cluster fourre-tout elle retire les points aberrants.
   */
  outlierQuantile?: number;
  /**
   * Garde-fou : le noyau garde toujours au moins ce nombre de candidats
   * (défaut `2 × maxEvidence`) — un petit thème n'est jamais vidé par la bande.
   */
  minCandidates?: number;
  /** Écarter les fragments de sommaire/index (défaut true). */
  excludeStructural?: boolean;
}

export interface EvidenceSelection<T extends EvidenceFragment = EvidenceFragment> {
  /** Preuves retenues, dans l'ordre de sélection (la 1ʳᵉ est la plus périphérique). */
  evidence: T[];
  distinctSources: number;
  /**
   * Cosine minimale entre deux preuves retenues : proche de 1 ⇒ jeu redondant,
   * proche de 0 ⇒ preuves très différentes. Mesure de diversité du thème.
   */
  minPairwiseCosine: number;
  /** Cosine maximale au centroïde : proche de 1 ⇒ preuves trop « centrales ». */
  maxCentroidCosine: number;
  /** Taille du noyau cohérent utilisé (≤ nombre de membres). */
  coreSize: number;
  /** Membres écartés avant sélection (bande de cohérence + filtre structurel). */
  dropped: number;
}

/** Cosine entre deux vecteurs L2-normalisés. */
export function cosine(a: Float32Array, b: Float32Array): number {
  return dotProduct(a, b, Math.min(a.length, b.length));
}

/** Centroïde d'un jeu de fragments : moyenne renormalisée L2 (direction moyenne). */
export function clusterCentroid(fragments: EvidenceFragment[]): Float32Array {
  if (fragments.length === 0) return new Float32Array(0);
  const dims = fragments[0].embedding.length;
  const sum = new Float64Array(dims);
  for (const f of fragments) {
    for (let d = 0; d < dims; d++) sum[d] += f.embedding[d];
  }
  let norm = 0;
  for (let d = 0; d < dims; d++) norm += sum[d] * sum[d];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(dims);
  for (let d = 0; d < dims; d++) out[d] = sum[d] / norm;
  return out;
}

/**
 * Un fragment d'**appareil** (sommaire, index, crédits d'édition, notes, bibliographie)
 * n'est pas une preuve exploitable : il ne porte aucun énoncé d'auteur. Ces fragments
 * sont sur-représentés dans les preuves parce qu'ils sont atypiques (donc choisis
 * comme « divers »).
 *
 * Constat réel (2026-09-13) : deux fragments de ce type (crédits « This Etext was
 * prepared by… » + table des matières de Claude Bernard, puis un bloc de notes en fin
 * de volume) ont produit une synthèse qui ne parlait que de la bibliographie du corpus
 * — « toutes deux citées dans des listes bibliographiques ». Le texte était vrai et
 * inutile : le défaut est dans la preuve, pas dans le prompt.
 *
 * Détection structurelle, sans LLM. Deux signaux, dans cet ordre :
 *   - le **locator** du fragment (`#FOOTNOTES`, `#NOTES`, `#TABLE DES MATIÈRES`) :
 *     mesuré, 67 fragments du corpus — c'est le signal le plus fiable ;
 *   - le **texte** : crédits d'édition, ligne d'appareil isolée, liste de titres ou
 *     bloc majoritairement fait de références. Sur les 3 706 fragments, 70 écartés
 *     au total (1,9 %) et la prose ordinaire reste intacte (une phrase qui parle d'un
 *     index, ou un paragraphe avec un appel de note isolé, sont conservés — testé).
 */
export function looksStructural(text: string, locator?: string): boolean {
  if (locator && APPARATUS_LOCATOR.test(locator)) return true;
  if (FRONT_MATTER.test(text)) return true;
  if (APPARATUS_HEADING.test(text)) return true;

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;

  // (1) liste de titres : numéros de page, numéros romains, points de conduite
  if (lines.length >= 6) {
    const listed = lines.filter((l) =>
      /(\d+\s*$)|(^[IVXLCDM]{1,7}[.)])|(\.\.\.)|(^Chapitre\s)|(^Livre\s+[IVXLCDM])/i.test(l)
    ).length;
    if (listed / lines.length >= 0.5) return true;
  }

  // (2) notes et bibliographie : majoritairement des références, pas des phrases
  const refs = lines.filter((l) => REFERENCE_LINE.test(l)).length;
  if (lines.length >= 4 && refs / lines.length >= 0.5) return true;
  if (lines.length >= 8 && refs / lines.length >= 0.3) return true;

  return false;
}

/** Crédits de production d'un e-book (Distributed Proofreaders, Ebooks libres et gratuits). */
const FRONT_MATTER =
  /This Etext was prepared by|Ebooks libres et gratuits|Distributed Proofreaders/i;
/**
 * Section d'appareil **dans le titre du fragment**. Signal bien plus fiable que le texte :
 * mesuré sur le corpus, 67 fragments portent un locator `#FOOTNOTES`, `#NOTES` ou
 * `#TABLE DES MATIÈRES` — ce sont exactement ceux qui produisaient des synthèses
 * commentant la bibliographie. La densité de citations dans le texte, elle, n'a donné
 * que 3 fragments dont 2 faux positifs (prose citant un verset) : elle n'est pas retenue.
 */
const APPARATUS_LOCATOR = /#[^;]*?\b(?:FOOTNOTES?|NOTES|TABLE DES MATI(?:ÈRES|ERES)|SOMMAIRE|INDEX)\b/i;
/** Ligne isolée d'appareil critique. Une phrase qui *parle* d'un index ne matche pas. */
const APPARATUS_HEADING = /^\s*(?:table des mati(?:è|e)res|sommaire|contents|index)\s*[:.]?\s*$/im;
/** Référence bibliographique ou appel de note. */
const REFERENCE_LINE = /\[\d+\]|\bVoy\.|\bCf\.|\bIbid\.|\bop\.\s?cit\.|§\s?\d+|,\s?p\.\s?\d+/;

/** Ordre canonique : garantit un résultat identique quelle que soit l'entrée. */
function compareFragments(a: EvidenceFragment, b: EvidenceFragment): number {
  return (
    a.sourceId.localeCompare(b.sourceId) ||
    a.chunkIndex - b.chunkIndex ||
    a.id.localeCompare(b.id)
  );
}

export function selectEvidence<T extends EvidenceFragment = EvidenceFragment>(
  opts: SelectEvidenceOptions<T>
): EvidenceSelection<T> {
  const minEvidence = opts.minEvidence ?? 2;
  const maxEvidence = opts.maxEvidence ?? 4;
  const redundancy = opts.redundancyThreshold ?? 0.97;
  const outlierQuantile = opts.outlierQuantile ?? 0.25;
  const excludeStructural = opts.excludeStructural ?? true;
  const sorted = [...opts.fragments].sort(compareFragments);
  const distinctSources = new Set(sorted.map((f) => f.sourceId)).size;

  const empty = (): EvidenceSelection<T> => ({
    evidence: [],
    distinctSources,
    minPairwiseCosine: 0,
    maxCentroidCosine: 0,
    coreSize: 0,
    dropped: sorted.length,
  });
  if (sorted.length === 0 || distinctSources < minEvidence) return empty();

  // 1) filtre structurel : un sommaire n'est pas une preuve
  const pool = excludeStructural
    ? sorted.filter((f) => !looksStructural(f.text, f.locator))
    : sorted;
  if (pool.length === 0 || new Set(pool.map((f) => f.sourceId)).size < minEvidence) {
    return empty();
  }

  const centroid = opts.centroid ?? clusterCentroid(pool);

  // 2) bande de cohérence : on retire les membres les plus atypiques du thème
  const centrality = new Map<string, number>();
  for (const f of pool) centrality.set(f.id, cosine(f.embedding, centroid));
  const minCandidates = opts.minCandidates ?? maxEvidence * 2;
  const coreSize = Math.min(
    pool.length,
    Math.max(minCandidates, Math.ceil(pool.length * (1 - outlierQuantile)))
  );
  const core = [...pool]
    .sort(
      (a, b) =>
        (centrality.get(b.id) as number) - (centrality.get(a.id) as number) ||
        compareFragments(a, b)
    )
    .slice(0, coreSize)
    .sort(compareFragments);

  // 3) la preuve la plus périphérique DU NOYAU (jamais la plus « typique ») ;
  //    à égalité stricte, `core` étant trié, c'est le premier de l'ordre canonique
  let first = core[0];
  let firstCosine = centrality.get(first.id) as number;
  for (const m of core.slice(1)) {
    const c = centrality.get(m.id) as number;
    if (c < firstCosine) {
      first = m;
      firstCosine = c;
    }
  }
  const evidence: T[] = [first];
  const usedSources = new Set([first.sourceId]);

  // 4) farthest-point sampling, une source par preuve, redondance écartée
  while (evidence.length < maxEvidence) {
    let best: { f: T; minSim: number } | null = null;
    for (const m of core) {
      if (usedSources.has(m.sourceId)) continue;
      let minSim = Infinity;
      for (const s of evidence) {
        const c = cosine(m.embedding, s.embedding);
        if (c < minSim) minSim = c;
      }
      if (minSim > redundancy) continue; // quasi identique à une preuve retenue
      if (!best || minSim < best.minSim) best = { f: m, minSim };
    }
    if (!best) break; // plus aucune source disponible, ou toutes redondantes
    evidence.push(best.f);
    usedSources.add(best.f.sourceId);
  }

  // un thème dont le contenu est redondant d'une source à l'autre n'est pas exploitable
  if (evidence.length < minEvidence) return { ...empty(), coreSize: core.length };

  let minPairwiseCosine = 1;
  for (let i = 0; i < evidence.length; i++) {
    for (let j = i + 1; j < evidence.length; j++) {
      minPairwiseCosine = Math.min(
        minPairwiseCosine,
        cosine(evidence[i].embedding, evidence[j].embedding)
      );
    }
  }
  return {
    evidence,
    distinctSources,
    minPairwiseCosine,
    maxCentroidCosine: Math.max(...evidence.map((e) => centrality.get(e.id) as number)),
    coreSize: core.length,
    dropped: sorted.length - core.length,
  };
}
