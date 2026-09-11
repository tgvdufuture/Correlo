import { describe, expect, it } from "vitest";
import {
  buildThemes,
  LABEL_STOPWORDS,
  labelCluster,
  themeCountFor,
  tokenize,
  type ThemeFragment,
} from "@/lib/synth/themes";
import { sha256Hex } from "@/lib/hash";

/** Deux familles de vocabulaire, aucune intersection — le clustering doit les séparer. */
const VOCAB_A = ["brutalisme", "beton", "facade", "volume"];
const VOCAB_B = ["comptabilite", "bilan", "fiscal", "amortissement"];

function frag(
  id: string,
  sourceId: string,
  chunkIndex: number,
  text: string,
  vector: number[]
): ThemeFragment {
  return { id, sourceId, chunkIndex, text, embedding: new Float32Array(vector) };
}

/** 20 fragments « architecture » (s1/s2) + 20 « comptabilité » (s3/s4), dims 8. */
function makeCorpus(): ThemeFragment[] {
  const out: ThemeFragment[] = [];
  for (let i = 0; i < 10; i++) {
    out.push(frag(`a${i}`, "s1", i, `${VOCAB_A.join(" ")} étude ${i}`, [1, 0.02 * i, 0, 0, 0, 0, 0, 0]));
    out.push(frag(`b${i}`, "s2", i, `${VOCAB_A.join(" ")} analyse ${i}`, [0.98, 0.05 * i, 0, 0, 0, 0, 0, 0]));
    out.push(frag(`c${i}`, "s3", i, `${VOCAB_B.join(" ")} rapport ${i}`, [0, 1, 0.02 * i, 0, 0, 0, 0, 0]));
    out.push(frag(`d${i}`, "s4", i, `${VOCAB_B.join(" ")} synthèse ${i}`, [0, 0.97, 0.04 * i, 0, 0, 0, 0, 0]));
  }
  return out;
}

const SEED = sha256Hex("corpus-hash|run-1");

describe("thèmes (Phase 5A)", () => {
  it("borne le nombre de thèmes : clamp(round(n/25), 4, 24)", () => {
    expect(themeCountFor(0)).toBe(0);
    expect(themeCountFor(10)).toBe(4);
    expect(themeCountFor(100)).toBe(4);
    expect(themeCountFor(200)).toBe(8);
    expect(themeCountFor(600)).toBe(24);
    expect(themeCountFor(5000)).toBe(24);
  });

  it("corpus vide : aucun thème", () => {
    expect(buildThemes({ fragments: [], seedHex: SEED })).toEqual({
      themes: [],
      assignment: [],
      k: 0,
    });
  });

  it("est reproductible : même seed ⇒ mêmes thèmes, fragment pour fragment", () => {
    const corpus = makeCorpus();
    const first = buildThemes({ fragments: corpus, seedHex: SEED });
    const second = buildThemes({ fragments: corpus, seedHex: SEED });
    expect(second.assignment).toEqual(first.assignment);
    expect(second.themes.map((t) => t.label)).toEqual(first.themes.map((t) => t.label));
    expect(second.themes.map((t) => t.size)).toEqual(first.themes.map((t) => t.size));
    expect(second.themes.map((t) => t.fragmentIds)).toEqual(first.themes.map((t) => t.fragmentIds));
    expect(second.themes.map((t) => Array.from(t.centroid))).toEqual(
      first.themes.map((t) => Array.from(t.centroid))
    );
  });

  it("ne mélange jamais les deux familles de vocabulaire dans un même thème", () => {
    const corpus = makeCorpus();
    const { themes } = buildThemes({ fragments: corpus, seedHex: SEED });
    expect(themes.length).toBeGreaterThanOrEqual(2);
    for (const theme of themes) {
      const texts = theme.fragmentIds.map((id) => corpus.find((f) => f.id === id)?.text ?? "");
      const hasA = texts.some((t) => t.includes("brutalisme"));
      const hasB = texts.some((t) => t.includes("comptabilite"));
      expect(hasA && hasB).toBe(false);
    }
  });

  it("chaque thème a un libellé discriminant, sans mot vide", () => {
    const corpus = makeCorpus();
    const { themes } = buildThemes({ fragments: corpus, seedHex: SEED });
    for (const theme of themes) {
      const sample = corpus.find((f) => f.id === theme.fragmentIds[0])?.text ?? "";
      const expected = sample.includes("brutalisme") ? VOCAB_A : VOCAB_B;
      expect(expected.some((term) => theme.label.includes(term))).toBe(true);
      // aucun mot vide ne doit se retrouver dans un libellé
      for (const term of tokenize(theme.label)) expect(LABEL_STOPWORDS.has(term)).toBe(false);
    }
  });

  it("l'affectation couvre exactement les membres des thèmes retenus", () => {
    const corpus = makeCorpus();
    const { themes, assignment } = buildThemes({ fragments: corpus, seedHex: SEED });
    expect(assignment).toHaveLength(corpus.length);
    const covered = themes.flatMap((t) => t.fragmentIds);
    const assigned = corpus.filter((_, i) => assignment[i] >= 0).map((f) => f.id);
    expect(new Set(covered)).toEqual(new Set(assigned));
    for (let i = 0; i < corpus.length; i++) {
      if (assignment[i] >= 0) expect(themes[assignment[i]].fragmentIds).toContain(corpus[i].id);
    }
  });

  it("écarte les clusters inutilisables (trop petits) et marque -1", () => {
    const corpus = makeCorpus();
    const { themes, assignment } = buildThemes({
      fragments: corpus,
      seedHex: SEED,
      minClusterSize: 9999,
    });
    expect(themes).toEqual([]);
    expect(assignment.every((a) => a === -1)).toBe(true);
  });

  it("repli de libellé : un cluster sans terme significatif reste lisible", () => {
    const corpus = [
      frag("x1", "s1", 0, "dans le texte de cet auteur", [1, 0, 0, 0, 0, 0, 0, 0]),
      frag("x2", "s2", 0, "dans le texte de cet auteur", [0.99, 0.01, 0, 0, 0, 0, 0, 0]),
      frag("y1", "s3", 0, "de la page de ce livre", [0, 1, 0, 0, 0, 0, 0, 0]),
      frag("y2", "s4", 0, "de la page de ce livre", [0, 0.99, 0.01, 0, 0, 0, 0, 0]),
    ];
    const { themes } = buildThemes({ fragments: corpus, seedHex: SEED, k: 2 });
    expect(themes.length).toBeGreaterThan(0);
    for (const theme of themes) expect(theme.label).toMatch(/^Thème \d+$/);
  });

  it("labelCluster écarte les termes présents partout (TF-IDF)", () => {
    // « beton » est dans tous les fragments du corpus → poids nul, donc jamais dans le libellé
    const texts = ["beton et verriere", "beton et verriere", "beton et pilier"];
    const df = new Map([
      ["beton", 20],
      ["verriere", 2],
      ["pilier", 1],
    ]);
    const label = labelCluster(texts, df, 20, 2);
    expect(label).toBe("verriere · pilier");
  });
});
