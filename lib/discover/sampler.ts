import { sha256Hex } from "@/lib/hash";

/**
 * Sampling de candidats Q20 (PRD §3.5 / Phase 2A) :
 *  - seed = SHA256(corpus_hash | run_id) → ordre d'itération et tirages déterministes ;
 *  - cross-source uniquement (fragment_a.source_id != fragment_b.source_id) ;
 *  - diversified : top-3 cosine + 2 fragments de clusters distincts + 1 lointain ;
 *  - top6 : les 6 plus proches (baseline « top-6 cosine pur », même budget) ;
 *  - quotas : ≤ 20 paires émises par source, ≤ 200 paires par run.
 */

export interface DiscoveryFragment {
  id: string;
  sourceId: string;
  chunkIndex: number;
  /** Embedding Float32 L2-normalisé (cosine = produit scalaire). */
  embedding: Float32Array;
}

export interface PairCandidate {
  aId: string;
  bId: string;
  aSource: string;
  bSource: string;
  cosine: number;
}

export interface SampleOptions {
  fragments: DiscoveryFragment[];
  /** Hex SHA-256 : SHA256(corpus_hash | run_id). */
  seedHex: string;
  sampler: "diversified" | "top6";
  maxPairs?: number;
  maxPairsPerSource?: number;
  topK?: number;
  clusterCount?: number;
}

/** Seed déterministe du run : SHA256(corpus_hash | run_id). */
export function makeSeed(corpusHash: string, runId: string): string {
  return sha256Hex(`${corpusHash}|${runId}`);
}

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

/**
 * Échantillonne les paires de candidats (déterministe pour un seed donné).
 * L'ordre d'itération est (source_id, chunk_index) ; on s'arrête dès que le
 * plafond global est atteint — chaque source contribue donc ≤ maxPairsPerSource.
 */
export function samplePairs(opts: SampleOptions): PairCandidate[] {
  const maxPairs = opts.maxPairs ?? 200;
  const maxPerSource = opts.maxPairsPerSource ?? 20;
  const topK = opts.topK ?? (opts.sampler === "top6" ? 6 : 3);
  const rng = mulberry32(parseInt(opts.seedHex.slice(0, 8), 16) || 1);

  // ordre d'itération déterministe
  const ordered = [...opts.fragments].sort(
    (x, y) => x.sourceId.localeCompare(y.sourceId) || x.chunkIndex - y.chunkIndex
  );
  if (ordered.length < 2) return [];

  const dims = ordered[0].embedding.length;
  const clusters = opts.sampler === "diversified" ? kMeans(ordered, rng, opts.clusterCount ?? 8) : null;

  const emitted = new Set<string>();
  const perSource = new Map<string, number>();
  const pairs: PairCandidate[] = [];

  for (const a of ordered) {
    if (pairs.length >= maxPairs) break;
    if ((perSource.get(a.sourceId) ?? 0) >= maxPerSource) continue;

    const cands = collectCandidates(a, ordered, dims, topK, clusters, rng);
    for (const c of cands) {
      if (pairs.length >= maxPairs) break;
      const key = a.id < c.id ? `${a.id}:${c.id}` : `${c.id}:${a.id}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      perSource.set(a.sourceId, (perSource.get(a.sourceId) ?? 0) + 1);
      pairs.push({ aId: a.id, bId: c.id, aSource: a.sourceId, bSource: c.sourceId, cosine: c.cosine });
      if ((perSource.get(a.sourceId) ?? 0) >= maxPerSource) break;
    }
  }
  return pairs;
}

interface Candidate {
  id: string;
  sourceId: string;
  cosine: number;
}

/** top-3 (ou top-6) + 2 clusters distincts + 1 lointain — jamais intra-source. */
function collectCandidates(
  a: DiscoveryFragment,
  ordered: DiscoveryFragment[],
  dims: number,
  topK: number,
  clusters: number[] | null,
  rng: () => number
): Candidate[] {
  const out: Candidate[] = [];
  const top: Candidate[] = [];
  let worstTop = -Infinity;

  // 8 tirages pour le « lointain » ; on garde le plus éloigné
  const farPool: Candidate[] = [];
  let far: Candidate | null = null;

  for (let j = 0; j < ordered.length; j++) {
    const b = ordered[j];
    if (b.sourceId === a.sourceId) continue;
    let s = 0;
    for (let i = 0; i < dims; i++) s += a.embedding[i] * b.embedding[i];
    const cand: Candidate = { id: b.id, sourceId: b.sourceId, cosine: s };

    if (top.length < topK) {
      top.push(cand);
      top.sort((x, y) => y.cosine - x.cosine);
      worstTop = top[top.length - 1].cosine;
    } else if (s > worstTop) {
      top[topK - 1] = cand;
      top.sort((x, y) => y.cosine - x.cosine);
      worstTop = top[topK - 1].cosine;
    }

    if (farPool.length < 8) farPool.push(cand);
    else if (s < farPool[farPool.length - 1].cosine) farPool[farPool.length - 1] = cand;
  }
  for (const c of top) out.push(c);

  if (clusters) {
    // 2 clusters distincts de celui de A — un fragment échantillonné par PRNG
    const aCluster = clusters[ordered.indexOf(a)];
    const k = clusters.length;
    const others: number[] = [];
    for (let c = 0; c < k; c++) if (c !== aCluster) others.push(c);
    for (let t = 0; t < 2 && others.length > 0; t++) {
      const ci = others.splice(Math.floor(rng() * others.length), 1)[0];
      const members = ordered.filter((f, idx) => clusters[idx] === ci && f.sourceId !== a.sourceId);
      const pick = pickCrossSource(members, a.sourceId, rng);
      if (pick) {
        const cosine = dot(a.embedding, pick.embedding, dims);
        out.push({ id: pick.id, sourceId: pick.sourceId, cosine });
      }
    }
  }

  if (farPool.length > 0) {
    far = farPool.reduce((min, c) => (c.cosine < min.cosine ? c : min), farPool[0]);
    out.push(far);
  }
  return out;
}

function pickCrossSource(
  members: DiscoveryFragment[],
  sourceId: string,
  rng: () => number
): DiscoveryFragment | null {
  if (members.length === 0) return null;
  for (let t = 0; t < 10; t++) {
    const pick = members[Math.floor(rng() * members.length)];
    if (pick.sourceId !== sourceId) return pick;
  }
  return members.find((m) => m.sourceId !== sourceId) ?? null;
}

function dot(a: Float32Array, b: Float32Array, dims: number): number {
  let s = 0;
  for (let i = 0; i < dims; i++) s += a[i] * b[i];
  return s;
}

/**
 * k-means (k-means++ léger, itérations déterministes) sur les embeddings.
 * Retourne l'assignation cluster de chaque fragment (index parallèle à `frags`).
 */
function kMeans(frags: DiscoveryFragment[], rng: () => number, k: number): number[] {
  const n = frags.length;
  const dims = frags[0].embedding.length;
  const kk = Math.max(2, Math.min(k, n));
  const assignment = new Array<number>(n);

  // k-means++ : premier centroïde au hasard, suivants = les plus éloignés
  const centroids: Float32Array[] = [new Float32Array(frags[Math.floor(rng() * n)].embedding)];
  while (centroids.length < kk) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      for (const c of centroids) {
        const d = 1 - dot(frags[i].embedding, c, dims);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestDist) {
        bestDist = minDist;
        bestIdx = i;
      }
    }
    centroids.push(new Float32Array(frags[bestIdx].embedding));
  }

  for (let iter = 0; iter < 4; iter++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < kk; c++) {
        const s = dot(frags[i].embedding, centroids[c], dims);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      assignment[i] = best;
    }
    // recalcule des centroïdes (moyenne par cluster, renormalisée)
    const sums = centroids.map(() => new Float64Array(dims));
    const counts = new Array<number>(kk).fill(0);
    for (let i = 0; i < n; i++) {
      const s = sums[assignment[i]];
      for (let d = 0; d < dims; d++) s[d] += frags[i].embedding[d];
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
  return assignment;
}