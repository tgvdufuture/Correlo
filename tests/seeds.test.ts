import { describe, expect, it } from "vitest";
import { buildSeeds, sharedTerms, SEED_MAX_COSINE, type SeedFragment } from "@/lib/synth/seeds";
import { labelCluster, tokenize } from "@/lib/synth/labels";

const SEED = "a1b2c3d4".repeat(8);

/** 8 fragments, 8 documents distincts : 4 paires proches (cosinus 0,9), le reste à 0. */
function familyCorpus(overrides: Record<number, { text?: string; locator?: string }> = {}) {
  const fragments: SeedFragment[] = [];
  for (let family = 0; family < 4; family += 1) {
    for (let k = 0; k < 2; k += 1) {
      const i = family * 2 + k;
      const vector = new Float32Array(8);
      vector[family * 2] = k === 0 ? 1 : 0.9;
      vector[family * 2 + 1] = k === 0 ? 0 : 0.44;
      fragments.push({
        id: `f${i}`,
        sourceId: `s${i}`,
        chunkIndex: 0,
        text: overrides[i]?.text ?? `Fragment ${i} sur le sujet ${family}.`,
        locator: overrides[i]?.locator ?? "[0,10)",
        embedding: vector,
      });
    }
  }
  return fragments;
}

const titles = new Map(Array.from({ length: 8 }, (_, i) => [`s${i}`, `Document ${i}`]));

describe("graines de synthèse (paires cross-document)", () => {
  it("est reproductible : même seed ⇒ mêmes graines, dans le même ordre", () => {
    const a = buildSeeds({ fragments: familyCorpus(), seedHex: SEED, sourceTitles: titles });
    const b = buildSeeds({ fragments: familyCorpus(), seedHex: SEED, sourceTitles: titles });
    expect(a.map((s) => s.fragmentIds)).toEqual(b.map((s) => s.fragmentIds));
    expect(a.map((s) => s.label)).toEqual(b.map((s) => s.label));
  });

  it("n'apparie jamais deux fragments du même document", () => {
    const fragments = familyCorpus();
    // 2 fragments dans le MÊME document (cosinus 0,9) : impossible à apparier
    fragments[1] = { ...fragments[1], sourceId: fragments[0].sourceId };
    const seeds = buildSeeds({ fragments, seedHex: SEED, sourceTitles: titles });
    for (const seed of seeds) {
      const sources = seed.fragmentIds.map(
        (id) => fragments.find((f) => f.id === id)?.sourceId as string
      );
      expect(new Set(sources).size).toBe(2);
    }
    expect(seeds.every((s) => !(s.fragmentIds.includes("f0") && s.fragmentIds.includes("f1")))).toBe(
      true
    );
  });

  it("préfère les rapprochements les plus proches et écarte les quasi-doublons", () => {
    const seeds = buildSeeds({
      fragments: familyCorpus(),
      seedHex: SEED,
      maxSeeds: 4,
      sourceTitles: titles,
    });
    // les 4 paires « même sujet, deux documents » arrivent en tête
    expect(seeds).toHaveLength(4);
    for (const seed of seeds) {
      expect(seed.minCosine).toBeCloseTo(0.9, 5);
    }
    // une paire à 0,99 est un quasi-doublon : elle ne doit jamais devenir une graine
    const nearDuplicates = familyCorpus();
    nearDuplicates[1] = {
      ...nearDuplicates[1],
      embedding: new Float32Array([0.99, 0.14, 0, 0, 0, 0, 0, 0]),
    };
    const withDup = buildSeeds({
      fragments: nearDuplicates,
      seedHex: SEED,
      maxSeeds: 4,
      sourceTitles: titles,
    });
    expect(SEED_MAX_COSINE).toBeLessThan(0.99);
    expect(
      withDup.some((s) => s.fragmentIds.includes("f0") && s.fragmentIds.includes("f1"))
    ).toBe(false);
    // le run reste complet : un autre rapprochement prend la place
    expect(withDup).toHaveLength(4);
  });

  it("respecte le plafond du run et l'équilibre entre documents", () => {
    const capped = buildSeeds({
      fragments: familyCorpus(),
      seedHex: SEED,
      maxSeeds: 3,
      sourceTitles: titles,
    });
    expect(capped).toHaveLength(3);

    // un document qui fournit beaucoup de fragments ne peut pas accaparer le run
    const skewed: SeedFragment[] = [];
    for (let i = 0; i < 6; i += 1) {
      const vector = new Float32Array(4);
      vector[0] = 1;
      vector[1] = 0.1 * i;
      skewed.push({
        id: `big${i}`,
        sourceId: "sBig",
        chunkIndex: i,
        text: `Fragment ${i} du document volumineux.`,
        embedding: vector,
      });
    }
    for (let i = 0; i < 6; i += 1) {
      const vector = new Float32Array(4);
      vector[1] = 1;
      vector[2] = 0.1 * i;
      skewed.push({
        id: `small${i}`,
        sourceId: `sSmall${i}`,
        chunkIndex: 0,
        text: `Fragment ${i} d'un document court.`,
        embedding: vector,
      });
    }
    const balanced = buildSeeds({
      fragments: skewed,
      seedHex: SEED,
      maxSeeds: 6,
      maxSeedsPerSource: 2,
      sourceTitles: titles,
    });
    const perSource = new Map<string, number>();
    for (const s of balanced) {
      for (const id of s.fragmentIds) {
        const source = skewed.find((f) => f.id === id)?.sourceId as string;
        perSource.set(source, (perSource.get(source) ?? 0) + 1);
      }
    }
    expect(perSource.get("sBig") ?? 0).toBeLessThanOrEqual(2);
    expect(balanced.length).toBeGreaterThan(0);
  });

  it("écarte les fragments d'appareil (sommaire, notes) de toute graine", () => {
    const fragments = familyCorpus({
      1: {
        text: [
          "TABLE DES MATIERES",
          "CHAPITRE PREMIER ........ 11",
          "CHAPITRE II ........... 24",
          "CHAPITRE III .......... 38",
          "NOTES ET VARIANTES .... 51",
          "INDEX DES NOMS ....... 63",
        ].join("\n"),
      },
    });
    const seeds = buildSeeds({ fragments, seedHex: SEED, sourceTitles: titles });
    expect(seeds.some((s) => s.fragmentIds.includes("f1"))).toBe(false);
  });

  it("nomme la graine par ses termes partagés, et se replie sur les titres sinon", () => {
    const shared = familyCorpus({
      0: { text: "Le cadastre fixe la limite de la parcelle voisine." },
      1: { text: "Le cadastre enregistre la parcelle et son proprietaire." },
    });
    const seeds = buildSeeds({ fragments: shared, seedHex: SEED, sourceTitles: titles });
    const first = seeds.find((s) => s.fragmentIds.includes("f0") && s.fragmentIds.includes("f1"));
    expect(first?.label).toContain("cadastre");
    expect(first?.label).not.toContain(" × ");

    // aucun terme commun : le libellé nomme les documents rapprochés (jamais vide)
    const disjoint = familyCorpus();
    const fallback = buildSeeds({ fragments: disjoint, seedHex: SEED, sourceTitles: titles })[0];
    expect(fallback.label).toContain(" × ");
    expect(fallback.label).toMatch(/Document \d/);
  });

  it("conserve un centroïde L2-normalisé dans l'espace des fragments", () => {
    const seeds = buildSeeds({ fragments: familyCorpus(), seedHex: SEED, sourceTitles: titles });
    for (const seed of seeds) {
      expect(seed.centroid).toHaveLength(8);
      let norm = 0;
      for (const v of seed.centroid) norm += v * v;
      expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
    }
  });

  it("corpus vide ou trop petit : aucune graine", () => {
    expect(buildSeeds({ fragments: [], seedHex: SEED })).toEqual([]);
    expect(buildSeeds({ fragments: familyCorpus().slice(0, 1), seedHex: SEED })).toEqual([]);
  });
});

describe("libellés (vocabulaire des graines)", () => {
  it("ne retient que les termes significatifs, sans mots vides français ni anglais", () => {
    const terms = tokenize(
      "Les livres indiquent would themselves that the structure interne est stable depuis toujours."
    );
    expect(terms).toContain("structure");
    expect(terms).toContain("stable");
    // mots vides : français (« depuis », « toujours ») et anglais (Bovary est en anglais)
    expect(terms).not.toContain("livres");
    expect(terms).not.toContain("depuis");
    expect(terms).not.toContain("toujours");
    expect(terms).not.toContain("would");
    expect(terms).not.toContain("themselves");
    // et jamais les résidus trop courts (« ete », « mot »)
    expect(terms.every((t) => t.length >= 5)).toBe(true);
  });

  it("ne partage que les termes présents dans au moins deux fragments", () => {
    const a: SeedFragment = {
      id: "a",
      sourceId: "s1",
      chunkIndex: 0,
      text: "La parcelle cadastrale delimite la propriete du voisin.",
      embedding: new Float32Array(2),
    };
    const b: SeedFragment = {
      id: "b",
      sourceId: "s2",
      chunkIndex: 0,
      text: "La parcelle voisine enregistre une propriete.",
      embedding: new Float32Array(2),
    };
    expect(sharedTerms([a, b]).sort()).toEqual(["parcelle", "propriete"]);
    // un terme unique au fragment n'est jamais « partagé »
    expect(sharedTerms([a, b])).not.toContain("cadastrale");
    expect(sharedTerms([a])).toEqual([]);
  });

  it("labelCluster écarte les termes présents partout ET ceux d'un seul fragment", () => {
    const df = new Map([
      ["communautaire", 100],
      ["rarissime", 1],
      ["moyennement", 5],
    ]);
    const texts = ["communautaire rarissime moyennement", "communautaire rarissime moyennement"];
    // « communautaire » (présent partout) a un score nul, « rarissime » (df=1) est sous
    // le plancher : le libellé retient le terme qui dit réellement le sujet partagé
    expect(labelCluster(texts, df, 100)).toBe("moyennement");

    // si rien ne dépasse le plancher, les termes partagés sont conservés (jamais vide)
    const rareOnly = new Map([
      ["cadastrale", 1],
      ["propriete", 1],
    ]);
    const fallback = labelCluster(
      ["cadastrale propriete", "cadastrale propriete"],
      rareOnly,
      100
    );
    expect(fallback).toContain("cadastrale");
    expect(fallback).toContain("propriete");
  });
});
