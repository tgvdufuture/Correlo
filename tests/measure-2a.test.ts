import { describe, expect, it } from "vitest";
import {
  claimAnchors,
  contentWords,
  discoveryCredits,
  documentFrequency,
  judgeSuggestion,
  MEASURE_VERSION,
  rareThreshold,
  sharedRareTerms,
  sourcePairKey,
  stemOf,
} from "../scripts/lib/measure-2a.mjs";

/**
 * Corpus synthétique : les deux textes de la paire partagent « medecine » (rare),
 * tandis que « corps » est banal (98 fragments le portent) et ne doit donc jamais
 * servir de signal — c'est exactement la différence entre la mesure v1 et v2.
 */
const PAIR_A = "Bernard observe la medecine experimentale chez le vivant.";
const PAIR_B = "Descartes doute de la medecine et du corps sensible.";
const FILLERS = Array.from(
  { length: 98 },
  (_, i) => `Fragment banal ${i} sur le corps et la matiere sensible.`
);
const CORPUS = [PAIR_A, PAIR_B, ...FILLERS];
const DF = documentFrequency(CORPUS);
const THRESHOLD = rareThreshold(CORPUS.length);

describe("mesure 2A (scripts/lib/measure-2a.mjs)", () => {
  it("est versionnée et son seuil de rareté suit 2 % du corpus", () => {
    expect(MEASURE_VERSION).toBe("measure-2a-v2");
    expect(rareThreshold(100)).toBe(2);
    expect(rareThreshold(3849)).toBe(77);
    expect(rareThreshold(10)).toBe(1); // plancher : un corpus minuscule garde un seuil exploitable
  });

  it("repère un terme rare réellement partagé par les deux fragments", () => {
    const shared = sharedRareTerms(PAIR_A, PAIR_B, DF, THRESHOLD);
    expect(shared).toContain("medecine");
    expect(shared).not.toContain("corps");
    // banal partout, « corps » n'est ni rare ni un signal
    expect(contentWords(PAIR_B)).toContain("corps");
    expect((DF.get("corps") ?? 0) > THRESHOLD).toBe(true);
  });

  it("rattache les flexions par la racine (longueur de préfixe figée)", () => {
    expect(stemOf("recommandation")).toBe("recom");
    expect(stemOf("recommande")).toBe(stemOf("recommandation"));
    expect(stemOf("guerit")).toBe(stemOf("guerir"));
  });

  it("détecte l'ancre lexicale fabriquée par le claim (v2, invisible en v1)", () => {
    const a = "Monsieur Roger presente un eleve recommande au maitre de la classe.";
    const b = "Le baron recoit une lettre de recommandation pour le professeur Lidenbrock.";
    const claim =
      "Un eleve confie sur recommandation rencontre un professeur qui recoit des lettres de recommandation.";
    // v1 : les fragments ne partagent aucun terme → rien ne relie les deux textes
    expect(sharedRareTerms(a, b, DF, THRESHOLD)).toHaveLength(0);
    // v2 : c'est le claim qui porte le mot-clé de la connexion → trouvable → évidente
    expect(claimAnchors(claim, a, b, DF, THRESHOLD)).toContain("recommandation");
    expect(judgeSuggestion({ claim, textA: a, textB: b }, { df: DF, threshold: THRESHOLD }).grade).toBe(
      "correcte_evidente"
    );
  });

  it("ne disqualifie pas une connexion sur un terme banal partagé", () => {
    const a = "Bernard etudie le corps des animaux avec methode.";
    const b = "Descartes interroge le corps et la substance pensante.";
    const claim = "L'un et l'autre ramenent la connaissance au corps et a la substance.";
    expect(claimAnchors(claim, a, b, DF, THRESHOLD)).toHaveLength(0);
    expect(judgeSuggestion({ claim, textA: a, textB: b }, { df: DF, threshold: THRESHOLD }).grade).toBe(
      "non_evidente"
    );
  });

  it("classe non évidente une connexion sans terme rare ni ancre", () => {
    const a = "Le cavalier hesite a poursuivre sa route vers la ville.";
    const b = "Le baron offre une bague ancienne a son neveu.";
    const claim = "Deux personnages differents se tiennent au seuil d'une decision.";
    expect(judgeSuggestion({ claim, textA: a, textB: b }, { df: DF, threshold: THRESHOLD }).grade).toBe(
      "non_evidente"
    );
  });

  it("plafonne le crédit de découverte à un par couple de sources et par run", () => {
    const entries = [
      { runId: "val-div", pairKey: "s1|s2", nonEvidente: true },
      { runId: "val-div", pairKey: "s1|s2", nonEvidente: true },
      { runId: "val-div", pairKey: "s1|s3", nonEvidente: true },
      { runId: "val-div", pairKey: "s1|s2", nonEvidente: false },
      { runId: "val-base", pairKey: "s1|s2", nonEvidente: true },
    ];
    // la répétition du même couple n'est pas une découverte ; l'autre couple et l'autre run si
    expect(discoveryCredits(entries)).toEqual([true, false, true, false, true]);
  });

  it("le couple de sources est non ordonné (a×b = b×a)", () => {
    expect(sourcePairKey("s2", "s1")).toBe(sourcePairKey("s1", "s2"));
  });
});
