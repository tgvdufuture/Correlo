import { describe, expect, it } from "vitest";
import {
  clusterCentroid,
  selectEvidence,
  type EvidenceFragment,
} from "@/lib/synth/select";

/** Les embeddings du corpus sont L2-normalisés : le helper l'applique aussi. */
function frag(
  id: string,
  sourceId: string,
  vector: number[],
  chunkIndex = 0
): EvidenceFragment {
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return {
    id,
    sourceId,
    chunkIndex,
    text: `Texte ${id}`,
    embedding: new Float32Array(vector.map((v) => v / norm)),
  };
}

describe("sélection des preuves d'un thème (Phase 5A étape 3)", () => {
  it("prend une seule preuve par source, et au moins deux sources", () => {
    const selection = selectEvidence({
      fragments: [
        frag("sa1", "sa", [1, 0, 0]),
        frag("sa2", "sa", [0.9, 0.4, 0], 1),
        frag("sb1", "sb", [0, 1, 0], 0),
      ],
    });
    expect(selection.evidence).toHaveLength(2);
    expect(new Set(selection.evidence.map((e) => e.sourceId)).size).toBe(2);
    expect(selection.distinctSources).toBe(2); // sa et sb
    // jamais deux fragments de la même source
    const perSource = selection.evidence.map((e) => e.sourceId);
    expect(new Set(perSource).size).toBe(perSource.length);
  });

  it("refuse un thème mono-source", () => {
    const selection = selectEvidence({
      fragments: [frag("a", "sa", [1, 0, 0]), frag("b", "sa", [0, 1, 0], 1)],
    });
    expect(selection.evidence).toEqual([]);
    expect(selection.distinctSources).toBe(1);
  });

  it("part du fragment le plus périphérique, pas du plus typique", () => {
    const selection = selectEvidence({
      fragments: [
        // « sa » est au centre du thème (fragment le plus typique)
        frag("sa1", "sa", [1, 0, 0]),
        frag("sa2", "sa", [1, 0, 0.02], 1),
        // « sb » est à l'extrémité
        frag("sb1", "sb", [0.1, 0.995, 0]),
        frag("sc1", "sc", [0.3, 0.95, 0.05]),
      ],
    });
    expect(selection.evidence[0].sourceId).toBe("sb");
  });

  it("maximise la diversité : après le fragment périphérique, prend l'opposé, pas le quasi-voisin", () => {
    const selection = selectEvidence({
      maxEvidence: 2,
      fragments: [
        frag("sa1", "sa", [1, 0, 0]),
        frag("sb1", "sb", [0.99, 0.1, 0], 0), // quasi identique à sa1 (cosine ≈ 0,995)
        frag("sc1", "sc", [0, 0, 1]), // opposé
      ],
    });
    const ids = selection.evidence.map((e) => e.id);
    expect(ids).toEqual(["sc1", "sa1"]); // le plus périphérique, puis l'opposé
    expect(ids).not.toContain("sb1"); // le quasi-voisin n'apporte rien au thème
    expect(selection.minPairwiseCosine).toBeLessThan(0.2);
  });

  it("garde-fou de redondance : deux sources quasi identiques ne forment pas un thème", () => {
    const nearDuplicate = [
      frag("sa1", "sa", [1, 0, 0]),
      frag("sb1", "sb", [0.9999, 0.01, 0], 0),
    ];
    expect(selectEvidence({ fragments: nearDuplicate }).evidence).toEqual([]);

    // avec une troisième source réellement différente, le thème devient exploitable
    // — et les deux sources quasi identiques ne sont jamais retenues ensemble
    const withThird = selectEvidence({
      maxEvidence: 2,
      fragments: [...nearDuplicate, frag("sc1", "sc", [0, 0, 1])],
    });
    expect(withThird.evidence).toHaveLength(2);
    const ids = withThird.evidence.map((e) => e.id);
    expect(ids).toEqual(["sc1", "sa1"]);
    expect(ids.includes("sa1") && ids.includes("sb1")).toBe(false);
  });

  it("borne le nombre de preuves et signale les mesures de diversité", () => {
    const selection = selectEvidence({
      fragments: [
        frag("sa1", "sa", [1, 0, 0]),
        frag("sb1", "sb", [0, 1, 0]),
        frag("sc1", "sc", [0, 0, 1]),
        frag("sd1", "sd", [0, 0.7, 0.7]),
        frag("se1", "se", [0.7, 0.7, 0]),
      ],
    });
    expect(selection.evidence).toHaveLength(4); // maxEvidence par défaut
    expect(selection.distinctSources).toBe(5);
    expect(selection.minPairwiseCosine).toBeGreaterThanOrEqual(0);
    expect(selection.maxCentroidCosine).toBeLessThanOrEqual(1);
  });

  it("est déterministe et indépendant de l'ordre d'entrée", () => {
    const fragments = [
      frag("sa1", "sa", [1, 0, 0]),
      frag("sb1", "sb", [0, 1, 0]),
      frag("sc1", "sc", [0, 0, 1]),
      frag("sd1", "sd", [0.5, 0.5, 0.7]),
    ];
    const ordered = selectEvidence({ fragments });
    const shuffled = selectEvidence({ fragments: [...fragments].reverse() });
    expect(shuffled.evidence.map((e) => e.id)).toEqual(ordered.evidence.map((e) => e.id));
    expect(shuffled.minPairwiseCosine).toBe(ordered.minPairwiseCosine);
  });

  it("corpus vide : aucune preuve", () => {
    expect(selectEvidence({ fragments: [] })).toEqual({
      evidence: [],
      distinctSources: 0,
      minPairwiseCosine: 0,
      maxCentroidCosine: 0,
    });
  });

  it("clusterCentroid renvoie la direction moyenne, normalisée", () => {
    const centroid = clusterCentroid([frag("a", "sa", [1, 0, 0]), frag("b", "sb", [0, 1, 0])]);
    expect(centroid[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(centroid[1]).toBeCloseTo(Math.SQRT1_2, 6);
    const norm = Math.sqrt([...centroid].reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(clusterCentroid([])).toHaveLength(0);
  });
});
