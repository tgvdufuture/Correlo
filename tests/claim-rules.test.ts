import { describe, expect, it } from "vitest";
import {
  claimTokens,
  isNearDuplicateClaim,
  normalizeClaimText,
  rejectClaim,
} from "@/lib/discover/claim-rules";

describe("barrière qualité des claims", () => {
  it("défaut 1 — rejette les claims génériques", () => {
    const generic = [
      "Les deux auteurs accordent une importance centrale à l'observation.",
      "Les deux textes traitent de la même question morale.",
      "Ces deux fragments partagent une vision commune de la science.",
      "L'auteur s'inspire de la pensée de son prédécesseur.",
      "Le rapport maître/apprenti structure les deux extraits.",
      "Tous deux soulignent que l'expérience est nécessaire.",
    ];
    for (const claim of generic) expect(rejectClaim(claim)).toBe("generic");
  });

  it("défaut 1 — rejette les formules de comparaison (« deux modèles », « même logique »)", () => {
    // Famille des formules vraies de n'importe quelle paire, mesurée sur le run
    // jux-v1 : ces deux claims ont survécu à la barrière avant d'être ajoutés.
    const compared = [
      "Monsieur Roger recommande le nouvel élève selon son travail et sa conduite; le professeur Lidenbrock somme impulsivement son neveu Axel de le suivre, montrant deux modèles d'autorité.",
      "Les deux procédés relèvent d'une même logique de progression.",
      "Les deux auteurs proposent deux conceptions opposées de la preuve.",
    ];
    for (const claim of compared) expect(rejectClaim(claim)).toBe("generic");
  });

  it("défaut 1 — laisse passer un claim qui porte sur un mécanisme précis", () => {
    expect(
      rejectClaim(
        "Le mécanisme d'auto-renforcement que Bentham décrit pour la réputation est celui que Smith applique à la richesse."
      )
    ).toBeNull();
  });

  it("défaut 2 — rejette les repères techniques du prompt (ancrage/placeholder)", () => {
    const leaked = [
      "Fragment A montre une scène de classe, tandis que Fragment B expose une thèse.",
      "Texte 1 soutient que la méthode expérimentale progresse par le doute.",
      "A contredit la prémisse du second texte sur la mesure.",
      "Le premier fragment décrit un rituel que le second fragment condamne.",
    ];
    for (const claim of leaked) expect(rejectClaim(claim)).toBe("placeholder");
  });

  it("défaut 3 — détecte la même idée reformulée sur une autre paire", () => {
    const a = claimTokens("Claude Bernard soutient que l'intuition engendre l'idée expérimentale.");
    const b = claimTokens(
      "Claude Bernard affirme que l'intuition ou le sentiment engendre l'idée expérimentale."
    );
    expect(isNearDuplicateClaim(a, b)).toBe(true);

    const c = claimTokens("La géométrie éclaire la physique chez Descartes.");
    expect(isNearDuplicateClaim(a, c)).toBe(false);
  });

  it("défaut 4 — rejette un claim rédigé en anglais", () => {
    expect(
      rejectClaim("The two authors share a common view of the experimental method and of doubt.")
    ).toBe("english");
    // un titre ou un nom propre anglais ne suffit pas à rejeter un claim français
    expect(rejectClaim("Le doute méthodique de Descartes rejoint le doute expérimental de Bernard.")).toBeNull();
  });

  it("rejette les claims fourre-tout (longueur / plusieurs phrases)", () => {
    const long = "Le mécanisme décrit conduit à une conséquence. ".repeat(4);
    expect(rejectClaim(long)).toBe("tooLong");
    expect(rejectClaim("   ")).toBe("generic");
  });

  it("les règles de normalisation sont stables (accents, ponctuation, casse)", () => {
    expect(normalizeClaimText("L'Étendue, la Grandeur — le Mouvement !")).toBe(
      "l etendue la grandeur le mouvement"
    );
  });
});
