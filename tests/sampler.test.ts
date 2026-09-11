import { describe, expect, it } from "vitest";
import { makeSeed, mulberry32, samplePairs, type DiscoveryFragment } from "@/lib/discover/sampler";

function frag(id: string, source: string, chunk: number, vec: number[]): DiscoveryFragment {
  return { id, sourceId: source, chunkIndex: chunk, embedding: new Float32Array(vec) };
}

describe("sampler Q20", () => {
  it("est déterministe pour un même seed", () => {
    const corpus = [
      frag("a1", "s1", 0, [1, 0, 0, 0]),
      frag("a2", "s1", 1, [0.9, 0.2, 0, 0]),
      frag("b1", "s2", 0, [0.8, 0.3, 0, 0]),
      frag("b2", "s2", 1, [0.2, 0.9, 0.1, 0]),
    ];
    const seed = makeSeed("hash-corpus", "run-1");
    const opts = { fragments: corpus, seedHex: seed, sampler: "diversified" as const, maxPairs: 100 };
    expect(samplePairs(opts)).toEqual(samplePairs(opts));
  });

  it("le seed dépend du corpus et du run (rejouable à l'identique, jamais croisé)", () => {
    expect(makeSeed("corpus-a", "run-1")).toBe(makeSeed("corpus-a", "run-1"));
    expect(makeSeed("corpus-a", "run-1")).not.toBe(makeSeed("corpus-a", "run-2"));
    expect(makeSeed("corpus-a", "run-1")).not.toBe(makeSeed("corpus-b", "run-1"));
    expect(makeSeed("corpus-a", "run-1")).toMatch(/^[0-9a-f]{64}$/);
    // PRNG : des seeds différents produisent des tirages différents
    const r1 = mulberry32(1);
    const r2 = mulberry32(2);
    expect([r1(), r1(), r1()]).not.toEqual([r2(), r2(), r2()]);
  });

  it("n'émet jamais de paire intra-source", () => {
    const corpus = [
      frag("a1", "s1", 0, [1, 0, 0, 0]),
      frag("a2", "s1", 1, [0.9, 0.2, 0, 0]),
      frag("a3", "s1", 2, [0.8, 0.3, 0, 0]),
      frag("b1", "s2", 0, [0.2, 0.9, 0.1, 0]),
      frag("b2", "s2", 1, [0.1, 0.8, 0.2, 0]),
      frag("c1", "s3", 0, [0, 0.1, 0.9, 0.2]),
    ];
    const pairs = samplePairs({
      fragments: corpus,
      seedHex: makeSeed("h", "r"),
      sampler: "diversified",
      maxPairs: 100,
    });
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) expect(p.aSource).not.toBe(p.bSource);
  });

  it("respecte le quota par source et le plafond global", () => {
    const corpus: DiscoveryFragment[] = [];
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 10; i++) {
        corpus.push(frag(`s${s}f${i}`, `s${s}`, i, [1, s * 0.1, i * 0.01, 0]));
      }
    }
    const pairs = samplePairs({
      fragments: corpus,
      seedHex: makeSeed("h", "r"),
      sampler: "diversified",
      maxPairs: 100,
      maxPairsPerSource: 3,
    });
    expect(pairs.length).toBeLessThanOrEqual(100);
    const perSource: Record<string, number> = {};
    for (const p of pairs) perSource[p.aSource] = (perSource[p.aSource] ?? 0) + 1;
    for (const n of Object.values(perSource)) expect(n).toBeLessThanOrEqual(3);
    expect(pairs.length).toBeGreaterThan(0);
  });

  it("diversified : le top-3 correspond aux 3 voisins les plus proches (cosine)", () => {
    // a1 dans s1 ; b1 > b2 > b3 > b4 en similarité avec a1 (s2)
    const corpus = [
      frag("a1", "s1", 0, [1, 0, 0, 0]),
      frag("b1", "s2", 0, [0.99, 0.02, 0, 0]),
      frag("b2", "s2", 1, [0.5, 0.5, 0, 0]),
      frag("b3", "s2", 2, [0.1, 0.9, 0, 0]),
      frag("b4", "s2", 3, [0, 1, 0, 0]),
    ];
    const pairs = samplePairs({
      fragments: corpus,
      seedHex: makeSeed("h", "r"),
      sampler: "diversified",
      maxPairs: 100,
      maxPairsPerSource: 100,
    });
    const a1Pairs = pairs.filter((p) => p.aId === "a1");
    expect(a1Pairs.length).toBeGreaterThanOrEqual(3);
    expect(a1Pairs.slice(0, 3).map((p) => p.bId)).toEqual(["b1", "b2", "b3"]);
    // cosine décroissant sur le top-3
    expect(a1Pairs[0].cosine).toBeGreaterThan(a1Pairs[1].cosine);
    expect(a1Pairs[1].cosine).toBeGreaterThan(a1Pairs[2].cosine);
  });

  it("top6 : les 6 voisins les plus proches", () => {
    const corpus = [
      frag("a1", "s1", 0, [1, 0, 0, 0]),
      frag("b1", "s2", 0, [0.99, 0.02, 0, 0]),
      frag("b2", "s2", 1, [0.5, 0.5, 0, 0]),
      frag("b3", "s2", 2, [0.1, 0.9, 0, 0]),
      frag("b4", "s2", 3, [0, 1, 0, 0]),
      frag("c1", "s3", 0, [0.7, 0.1, 0, 0]),
      frag("c2", "s3", 1, [0.3, 0.6, 0, 0]),
    ];
    const pairs = samplePairs({
      fragments: corpus,
      seedHex: makeSeed("h", "r"),
      sampler: "top6",
      maxPairs: 100,
      maxPairsPerSource: 100,
    });
    const a1Pairs = pairs.filter((p) => p.aId === "a1");
    expect(a1Pairs.slice(0, 6).map((p) => p.bId)).toEqual(["b1", "c1", "b2", "c2", "b3", "b4"]);
  });

  it("corpus d'une seule source : aucune paire", () => {
    const corpus = [frag("a1", "s1", 0, [1, 0, 0, 0]), frag("a2", "s1", 1, [0.9, 0.1, 0, 0])];
    expect(
      samplePairs({ fragments: corpus, seedHex: makeSeed("h", "r"), sampler: "diversified" })
    ).toEqual([]);
  });
});