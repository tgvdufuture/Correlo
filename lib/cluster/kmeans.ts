/**
 * Clustering déterministe partagé (Phase 2A sampler + Phase 5A thèmes).
 *
 * Une seule implémentation de k-means pour tout le dépôt : extraite du sampler Q20
 * à l'identique (le comportement — ordre des tirages PRNG, itérations, recalcul des
 * centroïdes, renormalisation L2 — doit rester bit pour bit le même, sinon les runs
 * 2A déjà validés ne seraient plus reproductibles).
 *
 * Les vecteurs sont supposés L2-normalisés (comme en base) : similarité = produit scalaire.
 */

/** PRNG déterministe (mulberry32) — mêmes tirages pour un même seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Produit scalaire tronqué à `dims` (cosine si les vecteurs sont L2-normalisés). */
export function dotProduct(a: Float32Array, b: Float32Array, dims: number): number {
  let s = 0;
  for (let i = 0; i < dims; i++) s += a[i] * b[i];
  return s;
}

export interface KMeansResult {
  /** Index de cluster de chaque vecteur (parallèle à l'entrée). */
  assignment: number[];
  /** Centroïdes renormalisés L2, un par cluster (index 0..k-1). */
  centroids: Float32Array[];
  k: number;
}

/**
 * k-means (k-means++ léger, itérations déterministes, aucun aléa hors `rng`).
 * `rng` est le seul apport d'aléa : un même (vecteurs, k, rng) donne toujours le
 * même résultat — condition de reproductibilité des runs.
 */
export function kMeansVectors(
  vectors: Float32Array[],
  k: number,
  rng: () => number,
  opts?: { iterations?: number }
): KMeansResult {
  const n = vectors.length;
  if (n === 0) return { assignment: [], centroids: [], k: 0 };
  const dims = vectors[0].length;
  const iterations = opts?.iterations ?? 4;
  // au moins 2 clusters, jamais plus que de points
  const kk = Math.max(2, Math.min(k, n));
  const assignment = new Array<number>(n);

  // k-means++ : premier centroïde au hasard, suivants = les plus éloignés
  const centroids: Float32Array[] = [new Float32Array(vectors[Math.floor(rng() * n)])];
  while (centroids.length < kk) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      for (const c of centroids) {
        const d = 1 - dotProduct(vectors[i], c, dims);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestDist) {
        bestDist = minDist;
        bestIdx = i;
      }
    }
    centroids.push(new Float32Array(vectors[bestIdx]));
  }

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < kk; c++) {
        const s = dotProduct(vectors[i], centroids[c], dims);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      assignment[i] = best;
    }
    // recalcul des centroïdes (moyenne par cluster, renormalisée L2)
    const sums = centroids.map(() => new Float64Array(dims));
    const counts = new Array<number>(kk).fill(0);
    for (let i = 0; i < n; i++) {
      const s = sums[assignment[i]];
      for (let d = 0; d < dims; d++) s[d] += vectors[i][d];
      counts[assignment[i]] += 1;
    }
    for (let c = 0; c < kk; c++) {
      const s = sums[c];
      let norm = 0;
      for (let d = 0; d < dims; d++) norm += s[d] * s[d];
      norm = Math.sqrt(norm) || 1;
      const cvec = centroids[c];
      for (let d = 0; d < dims; d++) cvec[d] = s[d] / norm;
    }
  }
  return { assignment, centroids, k: kk };
}
