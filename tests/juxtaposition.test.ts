import { describe, expect, it } from "vitest";
import {
  hasRelationalPredicate,
  isJuxtapositionClaim,
  splitJuxtaposedClauses,
} from "@/lib/quality/juxtaposition";

/**
 * Détecteur de juxtaposition (défaut 1 du run discovery-v4). Les exemples
 * « rejetés » et « conservés » sont tirés des claims réellement produits par le
 * corpus de validation (23 suggestions des runs `val-div` / `val-base`), pour que
 * la règle soit jugée sur ce qu'elle doit couper, pas sur des cas d'école.
 */
describe("splitJuxtaposedClauses", () => {
  it("découpe sur un connecteur de bipartition", () => {
    const sides = splitJuxtaposedClauses(
      "Bernard affirme que l'intuition engendre l'idée, tandis que Descartes voit un esprit universel."
    );
    expect(sides).not.toBeNull();
    expect(sides![0]).toContain("bernard affirme");
    expect(sides![1]).toContain("descartes");
  });

  it("découpe sur un point-virgule", () => {
    const sides = splitJuxtaposedClauses("Flaubert dédie à Senard; Renan dédie à sa sœur.");
    expect(sides).not.toBeNull();
    expect(sides![1]).toContain("renan");
  });

  it("découpe une comparaison initiale « Comme X …, Y … »", () => {
    const sides = splitJuxtaposedClauses(
      "Comme Bernard voit l'expérimentateur obéir aux lois, Descartes voit la certitude géométrique."
    );
    expect(sides).not.toBeNull();
    expect(sides![1]).toContain("descartes");
  });

  it("découpe un connecteur de bipartition **initial**", () => {
    // En jux-v1 les connecteurs n'étaient cherchés qu'à un indice > 0 : un énoncé
    // commençant par le connecteur passait la règle (claim réel de val-div).
    const sides = splitJuxtaposedClauses(
      "Alors que le manteau du cavalier yankee souligne son caractère d'homme d'action, la robe de jésuite empruntée sert à Candide à se déguiser en prêtre."
    );
    expect(sides).not.toBeNull();
    expect(sides![0]).toContain("manteau");
    expect(sides![1]).toContain("robe");
  });

  it("ne découpe pas un énoncé mono-clause", () => {
    expect(
      splitJuxtaposedClauses(
        "Dans Madame Bovary, le maître qui recommande un élève préfigure Jésus choisissant les douze apôtres."
      )
    ).toBeNull();
  });
});

describe("isJuxtapositionClaim — coupe la coordination vide", () => {
  it("rejette « X dit A, tandis que Y dit B »", () => {
    expect(
      isJuxtapositionClaim(
        "Bernard affirme que l'intuition engendre l'idée expérimentale, tandis que Descartes voit son esprit universel guider divers domaines comme la métaphysique et la morale."
      )
    ).toBe(true);
  });

  it("rejette la coordination par point-virgule", () => {
    expect(
      isJuxtapositionClaim(
        "Bernard dit que la pathologie trouve les causes des maladies pour les combattre par médicaments; Flaubert montre que la lettre dans les abricots provoque l'agitation d'Emma."
      )
    ).toBe(true);
  });

  it("rejette une comparaison initiale sans relation énoncée", () => {
    expect(
      isJuxtapositionClaim(
        "Comme Bernard voit l'expérimentateur obéir aux lois de la nature, Descartes voit la certitude géométrique nécessiter l'idée d'un être parfait pour garantir l'existence."
      )
    ).toBe(true);
  });

  it("rejette un contraste où chaque côté a son propre objet", () => {
    expect(
      isJuxtapositionClaim(
        "Bernard affirme que les vérités expérimentales sont objectives, tandis que Descartes soutient que notre connaissance de la matière dépend des idées de l'âme et de la véracité de Dieu."
      )
    ).toBe(true);
  });

  it("rejette la bipartition ouverte par le connecteur", () => {
    expect(
      isJuxtapositionClaim(
        "Alors que le manteau du cavalier yankee souligne son caractère d'homme d'action, la robe de jésuite empruntée sert à Candide à se déguiser en prêtre pour traverser les frontières."
      )
    ).toBe(true);
  });
});

describe("isJuxtapositionClaim — ne coupe pas une connexion énoncée", () => {
  it("conserve un prédicat relationnel explicite", () => {
    expect(
      isJuxtapositionClaim(
        "Dans Madame Bovary, le maître qui recommande un élève à la classe préfigure Jésus choisissant les douze apôtres pour perpétuer son œuvre."
      )
    ).toBe(false);
    expect(
      isJuxtapositionClaim(
        "Le cavalier yankee, homme d'action, trouve son équivalent dans Cacambo qui agit avec la même résolution rapide."
      )
    ).toBe(false);
  });

  it("conserve un contraste portant sur le même concept, racine comprise", () => {
    // « douter » / « doute » : appariement par racine de 5 lettres (convention du projet).
    expect(
      isJuxtapositionClaim(
        "Claude Bernard affirme que l'expérimentateur doit douter et fuir les idées fixes, tandis que Descartes doute des sens pour chercher la vérité via Dieu."
      )
    ).toBe(false);
  });

  it("conserve un contraste **affirmé** (« contrairement à »)", () => {
    // « contrairement à » énonce le contraste : c'est le type `contradiction` du
    // PRD. Il était en jux-v1 dans la liste de bipartition, inopérant en position
    // initiale — le claim était donc jugé comme une coordination vide.
    expect(
      isJuxtapositionClaim(
        "Contrairement à Claude Bernard qui fonde l'expérience sur l'observation provoquée, Descartes juge les sens trompeurs et cherche la vérité auprès de Dieu."
      )
    ).toBe(false);
  });

  it("conserve un contraste sur un concept commun littéral", () => {
    expect(
      isJuxtapositionClaim(
        "Bernard définit l'expérience comme une observation provoquée, tandis que Descartes soutient que l'expérience doit être maîtrisée par le génie."
      )
    ).toBe(false);
  });

  it("ne prend pas une proposition de but pour une relation", () => {
    // « pour illustrer » est le but d'un des côtés, pas une relation entre les deux.
    expect(
      isJuxtapositionClaim(
        "Claude Bernard considère la vivisection comme méthode pour établir le déterminisme expérimental, tandis que Descartes utilise la dissection du cœur pour illustrer le mécanisme du sang."
      )
    ).toBe(true);
  });

  it("laisse passer un énoncé trop court pour être jugé", () => {
    expect(isJuxtapositionClaim("Bernard doute, tandis que Descartes croit.")).toBe(false);
  });

  it("ne juge pas un énoncé vide", () => {
    expect(isJuxtapositionClaim("   ")).toBe(false);
  });
});

describe("hasRelationalPredicate", () => {
  it("détecte les prédicats relationnels du corpus", () => {
    expect(hasRelationalPredicate("Le maître préfigure Jésus.")).toBe(true);
    expect(hasRelationalPredicate("Le bonnet illustre l'optique cartésienne.")).toBe(true);
    expect(hasRelationalPredicate("Elle reflète la calomnie décrite par Descartes.")).toBe(true);
  });

  it("ignore une relation située dans une proposition de but", () => {
    expect(hasRelationalPredicate("Descartes utilise la dissection pour illustrer le sang.")).toBe(
      false
    );
  });

  it("ne prend pas une formule de comparaison pour une relation", () => {
    // « même logique », « deux modèles »… exemptaient la règle qu'ils doivent
    // déclencher ; ils sont désormais rejetés comme génériques (profil de claim).
    expect(hasRelationalPredicate("Les deux procédés relèvent d'une même logique.")).toBe(false);
  });
});
