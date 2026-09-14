import { samplePairs } from "@/lib/discover/sampler";
import { looksStructural } from "@/lib/synth/select";
import { labelCluster, tokenize } from "@/lib/synth/labels";

/**
 * Graines de synthèse (décision de direction du 2026-09-13).
 *
 * **Pourquoi plus de clustering.** Le moteur de la 5A regroupait les fragments par
 * k-means d'embeddings, puis demandait une synthèse par groupe. Mesuré sur le corpus
 * réel (12 œuvres) : dans cet espace, deux fragments du même **document** se
 * ressemblent plus que deux fragments du même **sujet** pris dans deux documents. Le
 * k-means retrouvait donc les documents ; le débruitage de la composante document
 * (`themes-v2`) ne gardait que ce qui *s'écarte* d'un document, c'est-à-dire les
 * fragments atypiques — 20 libellés sur 24 sont devenus du bruit lexical
 * (`hommes · homme · their · rodolphe`). Le clustering lexical (TF-IDF) a été mesuré
 * et écarté aussi : il retrouve les documents (Bovary 100 %, Renan 99 %, Bernard 97 %).
 *
 * **Ce qui remplace.** Le niveau preuve de la Phase 2A : le sampler déterministe
 * (`samplePairs`, déjà mesuré sur ce corpus — 15 suggestions non-évidentes cross-domain)
 * fournit des paires **cross-document** qui partagent un voisinage sémantique. Une
 * graine est cette paire : deux fragments de deux documents différents, jamais un
 * regroupement à interpréter. La synthèse est donc ancrée dans une **preuve
 * sélectionnée**, pas dans la moyenne d'un cluster.
 *
 * La graine est persistée dans `themes` (label + centroïde + taille) : la table sert
 * d'**ancrage** à la synthèse (clé étrangère, CASCADE au nettoyage), sans changement
 * de schéma. `size` vaut le nombre de fragments de la graine.
 */

/** Version de l'algorithme de graines — à incrémenter si la sélection change. */
export const SEED_VERSION = "seeds-v1";

/** Cosinus au-delà duquel deux fragments sont quasi identiques : rien à ajouter. */
export const SEED_MAX_COSINE = 0.95;

export interface SeedFragment {
  id: string;
  sourceId: string;
  chunkIndex: number;
  text: string;
  embedding: Float32Array;
  /** Utilisé quand l'appelant dispose du locator (filtre d'appareil en amont). */
  locator?: string;
}

export interface SynthesisSeed {
  /** Index dans le tableau `seeds` renvoyé. */
  index: number;
  /** Termes partagés par les fragments de la graine (repli : titres des documents). */
  label: string;
  fragmentIds: string[];
  sourceIds: string[];
  /** Centroïde des fragments de la graine (espace des fragments, L2-normalisé). */
  centroid: Float32Array;
  /** Cosinus minimal entre les fragments : diversité interne réelle. */
  minCosine: number;
}

export interface BuildSeedsOptions {
  fragments: SeedFragment[];
  /** SHA-256(corpus_hash | run_id) — même seed ⇒ mêmes graines, fragment pour fragment. */
  seedHex: string;
  /** Nombre de graines visé (1 appel LLM par graine). Défaut : 12. */
  maxSeeds?: number;
  /** Plafond de graines portant sur un même document (équilibre du corpus). Défaut : 3. */
  maxSeedsPerSource?: number;
  /** Titres par source, pour un libellé lisible quand aucun terme n'est partagé. */
  sourceTitles?: Map<string, string | null>;
}

export function buildSeeds(opts: BuildSeedsOptions): SynthesisSeed[] {
  const maxSeeds = opts.maxSeeds ?? 12;
  const maxPerSource = opts.maxSeedsPerSource ?? 3;
  if (opts.fragments.length < 2) return [];

  // Un fragment d'appareil (sommaire, notes, frontispice) n'est pas une preuve : il est
  // écarté **avant** l'échantillonnage, sinon une graine peut n'être faite que de ça.
  const pool = opts.fragments.filter(
    (f) => !looksStructural(f.text, f.locator) && f.text.trim().length > 0
  );
  if (pool.length < 2) return [];

  // Candidate générés par le sampler 2A (top-3 voisins cross-document + 2 fragments de
  // clusters distincts + 1 lointain). On garde les associations les plus proches — une
  // synthèse a besoin de deux documents qui se **rencontrent** — en refusant les
  // quasi-doublons (cosinus > 0.95 : le second n'ajoute rien au premier).
  const candidates = samplePairs({
    fragments: pool.map((f) => ({
      id: f.id,
      sourceId: f.sourceId,
      chunkIndex: f.chunkIndex,
      embedding: f.embedding,
    })),
    seedHex: opts.seedHex,
    sampler: "diversified",
    maxPairs: maxSeeds * 8,
    maxPairsPerSource: maxPerSource * 2,
    topK: 3,
    clusterCount: 8,
  })
    .filter((p) => p.cosine <= SEED_MAX_COSINE)
    .sort((a, b) => b.cosine - a.cosine || a.aId.localeCompare(b.aId));

  const byId = new Map(pool.map((f) => [f.id, f]));
  const perSource = new Map<string, number>();
  const df = corpusDocumentFrequency(pool);
  const seeds: SynthesisSeed[] = [];

  for (const candidate of candidates) {
    if (seeds.length >= maxSeeds) break;
    const a = byId.get(candidate.aId);
    const b = byId.get(candidate.bId);
    if (!a || !b || a.sourceId === b.sourceId) continue;
    // l'équilibre par document vaut pour les DEUX côtés : sinon un document dominant
    // (494 fragments anglais contre ~30 pour d'autres) accapare toutes les graines
    if ((perSource.get(a.sourceId) ?? 0) >= maxPerSource) continue;
    if ((perSource.get(b.sourceId) ?? 0) >= maxPerSource) continue;

    perSource.set(a.sourceId, (perSource.get(a.sourceId) ?? 0) + 1);
    perSource.set(b.sourceId, (perSource.get(b.sourceId) ?? 0) + 1);
    seeds.push({
      index: seeds.length,
      label: seedLabel([a, b], df, pool.length, opts.sourceTitles),
      fragmentIds: [a.id, b.id],
      sourceIds: [a.sourceId, b.sourceId],
      centroid: centroidOf([a.embedding, b.embedding]),
      minCosine: candidate.cosine,
    });
  }
  return seeds;
}

/** Nombre de fragments du corpus contenant chaque terme (idf des libellés). */
function corpusDocumentFrequency(fragments: SeedFragment[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const f of fragments) {
    for (const term of new Set(tokenize(f.text))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return df;
}

/**
 * Libellé d'une graine : les termes que ses deux fragments partagent réellement, les
 * plus discriminants d'abord. Un libellé vide de sens était le symptôme du clustering ;
 * ici, l'absence de terme partagé est une information (repli explicite sur les titres).
 */
function seedLabel(
  fragments: SeedFragment[],
  df: Map<string, number>,
  corpusSize: number,
  sourceTitles?: Map<string, string | null>
): string {
  const shared = sharedTerms(fragments);
  if (shared.length > 0) return labelCluster(fragments.map((f) => f.text), df, corpusSize);
  const titles = fragments.map(
    (f) => (sourceTitles?.get(f.sourceId) ?? f.sourceId).slice(0, 28) || f.sourceId.slice(0, 8)
  );
  return titles.join(" × ");
}

/** Termes présents dans **au moins deux** fragments de la graine (recouvrement réel). */
export function sharedTerms(fragments: SeedFragment[]): string[] {
  const counts = new Map<string, number>();
  for (const f of fragments) {
    for (const term of new Set(tokenize(f.text))) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([term]) => term)
    .sort((a, b) => a.localeCompare(b));
}

/** Moyenne des vecteurs, L2-normalisée (centroïde persité sur la graine). */
function centroidOf(vectors: Float32Array[]): Float32Array {
  const dims = vectors[0].length;
  const out = new Float32Array(dims);
  for (const v of vectors) for (let d = 0; d < dims; d += 1) out[d] += v[d];
  let norm = 0;
  for (let d = 0; d < dims; d += 1) {
    out[d] /= vectors.length;
    norm += out[d] * out[d];
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dims; d += 1) out[d] /= norm;
  return out;
}
