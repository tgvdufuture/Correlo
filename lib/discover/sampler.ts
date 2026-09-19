import { sha256Hex } from "@/lib/hash";
import { dotProduct, kMeansVectors, mulberry32 } from "@/lib/cluster/kmeans";

/**
 * Sampling de candidats Q20 (PRD §3.5 / Phase 2A) :
 *  - seed = SHA256(corpus_hash | run_id) → ordre d'itération et tirages déterministes ;
 *  - cross-source uniquement (fragment_a.source_id != fragment_b.source_id) ;
 *  - diversified : top-3 cosine + 2 fragments de clusters distincts + 1 lointain ;
 *  - top6 : les 6 plus proches (baseline « top-6 cosine pur », même budget) ;
 *  - quotas : ≤ 20 paires émises par source, ≤ 200 paires par run ;
 *  - `focusSourceIds` : les sources à examiner **en premier** (dépôt d'un fichier =
 *    on cherche ses liens, pas ceux du corpus entier).
 *
 * Le PRNG et le k-means vivent dans lib/cluster/kmeans.ts (partagés avec les thèmes
 * de la Phase 5A) ; mulberry32 reste ré-exporté ici, son comportement étant contractuel.
 */
export { mulberry32 };

/**
 * Version de l'algorithme d'échantillonnage — persistée dans
 * `discover_runs.sampler_version` (Phase 2B, AC1).
 *
 * À incrémenter dès que la **sélection** change (top-k, nombre de clusters,
 * quotas, ordre d'itération) : un run dont la version diffère ne décrit plus le
 * même échantillon, donc n'est plus « rejouable à l'identique » — c'est ce que la
 * colonne permet de détecter, elle qui accompagne la seed rejouée.
 *
 * `sampler-v2` (2026-09-16) : ordre d'itération « sources examinées d'abord »
 * (`focusSourceIds`). Un run focalisé sur un fichier échantillonne **ses** paires
 * au lieu des premières sources par ordre alphabétique — sans ce changement, le
 * plafond global était consommé par d'autres documents et le fichier fraîchement
 * déposé n'était jamais examiné.
 */
export const SAMPLER_VERSION = "sampler-v2";

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
  /**
   * Sources examinées en premier (itération). Elles passent devant l'ordre
   * alphabétique : un dépôt de fichier trouve donc ses liens même quand le
   * plafond de paires est petit — et le reste du corpus est échantillonné
   * seulement si le budget n'est pas épuisé.
   */
  focusSourceIds?: string[];
}

/** Seed déterministe du run : SHA256(corpus_hash | run_id). */
export function makeSeed(corpusHash: string, runId: string): string {
  return sha256Hex(`${corpusHash}|${runId}`);
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

  // ordre d'itération déterministe : sources mises en avant d'abord, puis
  // (source_id, chunk_index) — un ordre total, donc une sélection reproductible
  const focus = new Set(opts.focusSourceIds ?? []);
  const byNatural = (x: DiscoveryFragment, y: DiscoveryFragment) =>
    x.sourceId.localeCompare(y.sourceId) || x.chunkIndex - y.chunkIndex;
  const ordered = [
    ...opts.fragments.filter((f) => focus.has(f.sourceId)).sort(byNatural),
    ...opts.fragments.filter((f) => !focus.has(f.sourceId)).sort(byNatural),
  ];
  if (ordered.length < 2) return [];

  const dims = ordered[0].embedding.length;
  const clusters =
    opts.sampler === "diversified"
      ? kMeansVectors(
          ordered.map((f) => f.embedding),
          opts.clusterCount ?? 8,
          rng
        ).assignment
      : null;

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
    const s = dotProduct(a.embedding, b.embedding, dims);
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
        const cosine = dotProduct(a.embedding, pick.embedding, dims);
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
