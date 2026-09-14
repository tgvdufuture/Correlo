import { describe, expect, it } from "vitest";
import {
  clusterCentroid,
  looksStructural,
  selectEvidence,
  type EvidenceFragment,
} from "@/lib/synth/select";

/** Les embeddings du corpus sont L2-normalisés : le helper l'applique aussi. */
function frag(
  id: string,
  sourceId: string,
  vector: number[],
  chunkIndex = 0,
  text = `Texte ${id}`
): EvidenceFragment {
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return {
    id,
    sourceId,
    chunkIndex,
    text,
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
      coreSize: 0,
      dropped: 0,
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

describe("cohérence des preuves sur un thème fourre-tout", () => {
  /** Noyau cohérent : 10 fragments répartis dans un cône de ±0,45 rad. */
  const coreCone = Array.from({ length: 10 }, (_, i) => {
    const theta = -0.45 + 0.1 * i;
    return frag(`c${i}`, `srcc${i}`, [Math.cos(theta), Math.sin(theta), 0]);
  });
  /** Point aberrant : à 1,37 rad du centre, mais rattaché au même cluster par k-means. */
  const outlier = frag("out", "srcout", [Math.cos(1.37), Math.sin(1.37), 0]);

  it("écarte les membres les plus atypiques avant de diversifier", () => {
    const withBand = selectEvidence({ fragments: [...coreCone, outlier] });
    expect(withBand.coreSize).toBe(9); // 11 membres, bande de 25 %
    expect(withBand.evidence.map((e) => e.id)).not.toContain("out");

    // sans bande, le point aberrant est le plus périphérique : il est pris en premier
    const noBand = selectEvidence({ fragments: [...coreCone, outlier], outlierQuantile: 0 });
    expect(noBand.evidence[0].id).toBe("out");
    // et le jeu de preuves devient incohérent
    expect(noBand.minPairwiseCosine).toBeLessThan(0);
    expect(withBand.minPairwiseCosine).toBeGreaterThan(noBand.minPairwiseCosine);
  });

  it("la bande ne vide jamais un petit thème (garde-fou minCandidates)", () => {
    const selection = selectEvidence({
      fragments: [frag("sa", "sa", [1, 0, 0]), frag("sb", "sb", [0.5, 0.86, 0])],
    });
    expect(selection.coreSize).toBe(2);
    expect(selection.evidence).toHaveLength(2);
  });

  it("un sommaire n'est jamais retenu comme preuve", () => {
    const toc =
      "I. Premier chapitre 12\nII. Deuxième chapitre 45\nIII. Troisième partie 78\n" +
      "IV. Quatrième livre 99\nV. Cinquième section 120\nVI. Sixième et dernier 141";
    expect(looksStructural(toc)).toBe(true);
    expect(
      looksStructural(
        "La mémoire humaine n'est pas un enregistrement fidèle du passé : elle reconstruit.\n" +
          "Chaque rappel modifie le souvenir rappelé.\nTrois expériences le montrent."
      )
    ).toBe(false);

    const fragments = [...coreCone.slice(0, 5), frag("toc", "srctoc", [0.2, 0.98, 0], 0, toc)];
    const guarded = selectEvidence({ fragments });
    expect(guarded.evidence.map((e) => e.id)).not.toContain("toc");
    expect(guarded.dropped).toBe(1);

    // sans le filtre structurel, le sommaire redevient le fragment le plus périphérique
    const unguarded = selectEvidence({ fragments, excludeStructural: false });
    expect(unguarded.evidence[0].id).toBe("toc");
  });

  /**
   * Cas réel du 2026-09-13 : deux fragments d'appareil (crédits d'édition + table des
   * matières, puis un bloc de notes) ont produit une synthèse qui ne parlait que de la
   * bibliographie du corpus. Ces règles écartent la source du défaut, sans emporter la
   * prose qui, elle, mentionne des notes ou un index.
   */
  it("écarte la matière frontale d'un e-book (crédits de production)", () => {
    const credits =
      "This Etext was prepared by Distributed Proofreaders EU - Mireille Harmelin " +
      "et Michel Arotcarena - Ebooks libres et gratuits - Jean-Claude, Fred et Coolmicro.\n" +
      "Claude Bernard\nINTRODUCTION À L'ÉTUDE DE LA MÉDECINE EXPÉRIMENTALE\n(1865)\n" +
      "Table des matières\nPREMIÈRE PARTIE DU RAISONNEMENT EXPÉRIMENTAL.";
    expect(looksStructural(credits)).toBe(true);
  });

  it("écarte une ligne d'appareil isolée (sommaire, index), mais pas une phrase qui en parle", () => {
    expect(looksStructural("Table des matières")).toBe(true);
    expect(looksStructural("Sommaire\nChapitre I\nChapitre II")).toBe(true);
    expect(
      looksStructural(
        "La table des matières était reliée en fin de volume, ce qui obligeait le lecteur " +
          "à feuilleter longuement avant de trouver le chapitre voulu."
      )
    ).toBe(false);
  });

  it("écarte un bloc majoritairement fait de références (notes, bibliographie)", () => {
    const notes =
      "et contrairement à la morale universelle, ces vues sont hérissées de difficultés.\n" +
      "[1] Voy. Cours de pathologie expérimentale. - Médical Times, 1859-1860.\n" +
      "[2] Bacon, oeuvres, édition par Fr. Riaux, Introduction, p. 30.\n" +
      "[3] J. de Maistre, Examen de la philosophie de Bacon, 1836.\n" +
      "[4] Müller, De glandularum secernentium structura, Leipzig, 1830.\n" +
      "[5] Virchow, La pathologie cellulaire, p. 12.\n" +
      "[6] Cf. Ibid., p. 40 et op. cit., § 2.";
    expect(looksStructural(notes)).toBe(true);
  });

  it("écarte une section d'appareil d'après le locator (signal le plus fiable)", () => {
    // cas réel : locators mesurés sur le corpus (#FOOTNOTE 7, #NOTES 49, #TABLE DES MATI 11)
    for (const locator of [
      "#FOOTNOTES:;[220076,221803)",
      "#NOTES DU CHAPITRE XII;[12000,13500)",
      "#(p. 397) TABLE DES MATIÈRES;[573147,575003)",
      "#SOMMAIRE GÉNÉRAL;[1,900)",
    ]) {
      expect(looksStructural("Texte de note sans ponctuation particulière.", locator)).toBe(true);
    }
    // un locator de chapitre normal n'écarte rien
    for (const locator of [
      "#CHAPITRE XI.HISTOIRE DE LA VIEILLE.;[50,900)",
      "#XXXI De la volupté dans les aliments.;[1,900)",
      "#SUR LA TROISIÈME MÉDITATION;[656256,658154)",
    ]) {
      expect(looksStructural("Ici un vrai paragraphe d'auteur, sans appareil.", locator)).toBe(false);
    }
  });

  it("un fragment d'appareil repéré par son locator n'est jamais retenu comme preuve", () => {
    const fragments = [
      ...coreCone.slice(0, 5),
      {
        id: "note",
        sourceId: "srcnote",
        chunkIndex: 0,
        locator: "#FOOTNOTES:;[220076,221803)",
        text: "in Joann., VI, 24) a proposé de substituer Béthabara, et sa correction.",
        embedding: new Float32Array([0.3, 0.95, 0]),
      },
    ];
    const guarded = selectEvidence({ fragments });
    expect(guarded.evidence.map((e) => e.id)).not.toContain("note");
    expect(guarded.dropped).toBe(1);
  });

  it("garde la prose qui ne contient qu'un appel de note isolé", () => {
    expect(
      looksStructural(
        "Selon le témoignage [1] recueilli en 1863, la méthode expérimentale suppose une " +
          "hypothèse préalable, vérifiée par l'expérience et corrigée par les faits observés."
      )
    ).toBe(false);
  });
});
