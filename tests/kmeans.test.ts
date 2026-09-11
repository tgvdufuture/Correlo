import { describe, expect, it } from "vitest";
import { dotProduct, kMeansVectors, mulberry32 } from "@/lib/cluster/kmeans";

const vec = (...v: number[]) => new Float32Array(v);

describe("k-means déterministe (partagé sampler / thèmes)", () => {
  const corpus = [
    vec(1, 0, 0, 0),
    vec(0.9, 0.1, 0, 0),
    vec(0.8, 0.2, 0, 0),
    vec(0, 1, 0, 0),
    vec(0.1, 0.9, 0, 0),
    vec(0, 0, 1, 0),
  ];

  it("est déterministe : même rng ⇒ mêmes affectations et mêmes centroïdes", () => {
    const a = kMeansVectors(corpus, 3, mulberry32(42));
    const b = kMeansVectors(corpus, 3, mulberry32(42));
    expect(a.assignment).toEqual(b.assignment);
    expect(a.centroids.map((c) => Array.from(c))).toEqual(b.centroids.map((c) => Array.from(c)));
  });

  it("assigne chaque point et renvoie des centroïdes L2-normalisés", () => {
    const r = kMeansVectors(corpus, 3, mulberry32(1));
    expect(r.k).toBe(3);
    expect(r.centroids).toHaveLength(3);
    expect(r.assignment).toHaveLength(corpus.length);
    for (const a of r.assignment) {
      expect(Number.isInteger(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(3);
    }
    for (const c of r.centroids) {
      const norm = Math.sqrt([...c].reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
  });

  it("borne k : jamais plus de clusters que de points, jamais moins de 2", () => {
    expect(kMeansVectors([vec(1, 0)], 5, mulberry32(1)).k).toBe(2);
    expect(kMeansVectors([vec(1, 0)], 0, mulberry32(1)).k).toBe(2);
  });

  it("corpus vide : aucun cluster, aucune affectation", () => {
    expect(kMeansVectors([], 4, mulberry32(1))).toEqual({
      assignment: [],
      centroids: [],
      k: 0,
    });
  });

  it("sépare deux groupes bien distincts", () => {
    const vectors = [
      vec(1, 0, 0),
      vec(0.99, 0.01, 0),
      vec(0.98, 0.02, 0),
      vec(0, 0, 1),
      vec(0.01, 0, 0.99),
      vec(0.02, 0.01, 0.97),
    ];
    const r = kMeansVectors(vectors, 2, mulberry32(7));
    const first = r.assignment[0];
    const last = r.assignment[3];
    expect(r.assignment.slice(0, 3).every((a) => a === first)).toBe(true);
    expect(r.assignment.slice(3).every((a) => a === last)).toBe(true);
    expect(first).not.toBe(last);
  });

  it("dotProduct est le produit scalaire tronqué à dims", () => {
    expect(dotProduct(vec(1, 2, 3), vec(4, 5, 6), 3)).toBe(32);
    expect(dotProduct(vec(1, 2, 3), vec(4, 5, 6), 2)).toBe(14);
  });
});
