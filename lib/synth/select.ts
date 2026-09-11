import { dotProduct } from "@/lib/cluster/kmeans";

/**
 * Sélection des preuves d'un thème (PRD v1.3, Phase 5A §2.1-2).
 *
 * Objectif : un jeu de preuves **divers**, pas les fragments les plus proches.
 * Trois règles, toutes déterministes :
 *   1. une seule preuve par source (≥ 2 sources distinctes) — jamais un thème
 *      illustré deux fois par le même document ;
 *   2. les preuves sont prises aux **extrémités** du thème : on part du fragment le
 *      plus éloigné du centroïde (jamais le plus « typique »), puis on ajoute à chaque
 *      fois le fragment le plus éloigné des preuves déjà retenues (farthest-point
 *      sampling). C'est ce qui évite de retomber sur le baseline « top-6 cosine ».
 *   3. garde-fou de redondance : une preuve quasi identique à une preuve déjà retenue
 *      (cosine > `redundancyThreshold`) est écartée — deux textes identiques ne
 *      permettent pas d'énoncer quoi que ce soit de plus.
 */

export interface EvidenceFragment {
  id: string;
  sourceId: string;
  chunkIndex: number;
  text: string;
  /** Embedding Float32 L2-normalisé (comme en base). */
  embedding: Float32Array;
}

export interface SelectEvidenceOptions {
  /** Fragments du thème (membres du cluster). */
  fragments: EvidenceFragment[];
  /** Centroïde du thème ; recalculé sur les membres si absent. */
  centroid?: Float32Array;
  /** Preuves minimales (défaut 2) — en dessous, le thème est inexploitable. */
  minEvidence?: number;
  /** Preuves maximales (défaut 4). */
  maxEvidence?: number;
  /** Cosine au-delà de laquelle deux preuves sont considérées redondantes (défaut 0,97). */
  redundancyThreshold?: number;
}

export interface EvidenceSelection {
  /** Preuves retenues, dans l'ordre de sélection (la 1ʳᵉ est la plus périphérique). */
  evidence: EvidenceFragment[];
  distinctSources: number;
  /**
   * Cosine minimale entre deux preuves retenues : proche de 1 ⇒ jeu redondant,
   * proche de 0 ⇒ preuves très différentes. Mesure de diversité du thème.
   */
  minPairwiseCosine: number;
  /** Cosine maximale au centroïde : proche de 1 ⇒ preuves trop « centrales ». */
  maxCentroidCosine: number;
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

/** Ordre canonique : garantit un résultat identique quelle que soit l'entrée. */
function compareFragments(a: EvidenceFragment, b: EvidenceFragment): number {
  return (
    a.sourceId.localeCompare(b.sourceId) ||
    a.chunkIndex - b.chunkIndex ||
    a.id.localeCompare(b.id)
  );
}

export function selectEvidence(opts: SelectEvidenceOptions): EvidenceSelection {
  const minEvidence = opts.minEvidence ?? 2;
  const maxEvidence = opts.maxEvidence ?? 4;
  const redundancy = opts.redundancyThreshold ?? 0.97;
  const members = [...opts.fragments].sort(compareFragments);
  const distinctSources = new Set(members.map((f) => f.sourceId)).size;

  const empty = (): EvidenceSelection => ({
    evidence: [],
    distinctSources,
    minPairwiseCosine: 0,
    maxCentroidCosine: 0,
  });
  if (members.length === 0 || distinctSources < minEvidence) return empty();

  const centroid = opts.centroid ?? clusterCentroid(members);
  // 1) la preuve la plus périphérique du thème (la plus loin du centroïde) ;
  //    à égalité stricte, `members` étant trié, c'est le premier de l'ordre canonique
  let first = members[0];
  let firstCosine = cosine(first.embedding, centroid);
  for (const m of members.slice(1)) {
    const c = cosine(m.embedding, centroid);
    if (c < firstCosine) {
      first = m;
      firstCosine = c;
    }
  }
  const evidence: EvidenceFragment[] = [first];
  const usedSources = new Set([first.sourceId]);

  // 2) farthest-point sampling, une source par preuve, redondance écartée
  while (evidence.length < maxEvidence) {
    let best: { f: EvidenceFragment; minSim: number } | null = null;
    for (const m of members) {
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
  if (evidence.length < minEvidence) return empty();

  let minPairwiseCosine = 1;
  for (let i = 0; i < evidence.length; i++) {
    for (let j = i + 1; j < evidence.length; j++) {
      minPairwiseCosine = Math.min(
        minPairwiseCosine,
        cosine(evidence[i].embedding, evidence[j].embedding)
      );
    }
  }
  const maxCentroidCosine = Math.max(
    ...evidence.map((e) => cosine(e.embedding, centroid))
  );
  return { evidence, distinctSources, minPairwiseCosine, maxCentroidCosine };
}
