import { describe, expect, it } from "vitest";
import { judgeConclusion } from "@/lib/quality/conclusion";
import {
  hasReportingVerb,
  isProseJuxtaposition,
  splitProseClauses,
} from "@/lib/quality/juxtaposition";

/**
 * Barrière de conclusion (Phase 4, US-09). Les deux énoncés « refusés » sont les
 * **sorties réelles** du run HTTP du 2026-09-18 (`data/eval/investigation-validation.db`,
 * modèle `nvidia/nemotron-3-super-120b-a12b`, corpus de 3 853 fragments) — toutes deux
 * **acceptées** par le service d'alors, qui n'appliquait que deux règles (exploration
 * faite, non-reprise de la question) : l'énoncé de 19 mots ci-dessous avait un
 * recouvrement de 0,000 avec sa question, et la juxtaposition de 0,615. La barrière
 * existait, elle n'était pas branchée.
 */
const REAL_CLAIM =
  "Bernard affirme que l'expérimentateur ne fait qu'obéir aux lois de la nature, tandis " +
  "Descartes soutient que la connaissance naît de l'expérience particulière pour déduire les causes.";

/** Sortie réelle n° 1 : « les deux documents… », vraie de n'importe quelle paire. */
const REAL_HOLISTIC =
  "Les deux documents decrivent la meme exigence : ecarter ce qui n'est pas verifiable avant " +
  "d'enoncer une conclusion.";

/** Sortie réelle n° 2 : deux reports coordonnés, aucune relation entre les documents. */
const REAL_JUXTAPOSITION =
  "Bernard et Descartes considèrent tous deux l'expérimentateur comme un intermédiaire entre la " +
  "nature et la connaissance, mais Bernard souligne que l'expérimentateur ne fait qu'obéir à un " +
  "déterminisme absolu des phénomènes (voir [0]), tandis que Descartes montre que l'expérimentateur " +
  "doit partir d'expériences particulières, en remontant des effets aux causes cachées (voir [1]), " +
  "faisant de lui un interprète actif plutôt qu'un simple spectateur.";

describe("judgeConclusion — la juxtaposition reformulée est refusée", () => {
  it("refuse la juxtaposition réelle du run : deux reports, un connecteur, aucune relation", () => {
    expect(judgeConclusion({ answer: REAL_JUXTAPOSITION, claim: REAL_CLAIM })).toEqual({
      ok: false,
      reason: "conclusion_juxtaposition",
      detail: expect.any(String),
    });
  });

  it("refuse la formule holistique réelle du run (une seule clause, aucune attribution)", () => {
    const verdict = judgeConclusion({ answer: REAL_HOLISTIC, claim: REAL_CLAIM });
    expect(verdict.ok).toBe(false);
    // un seule clause ⇒ ce n'est pas le prong de juxtaposition qui la coupe
    expect(verdict).toMatchObject({ reason: "conclusion_generique" });
  });

  it("la juxtaposition passe **avant** les formules génériques (le défaut, pas le symptôme)", () => {
    // la sortie réelle déclenche les deux (elle commence par « considèrent tous deux ») :
    // c'est la structure qui est rapportée au modèle, parce que c'est elle qu'il doit changer
    expect(REAL_JUXTAPOSITION).toContain("considèrent tous deux");
    expect(judgeConclusion({ answer: REAL_JUXTAPOSITION, claim: REAL_CLAIM })).toMatchObject({
      reason: "conclusion_juxtaposition",
    });
  });

  it("accepte un report unique : attribuer une thèse à un texte n'est pas juxtaposer", () => {
    const answer =
      "Le déterminisme bernardien ne précède pas le doute cartésien, il en déplace l'objet : " +
      "ce que Descartes fonde sur l'ordre des raisons, Bernard le vérifie sur le vivant — la " +
      "mesure apparaît alors comme la mise à l'épreuve du critère qui la fonde, et l'expérience " +
      "particulière devient le lieu où ce critère se prouve.";
    expect(judgeConclusion({ answer, claim: REAL_CLAIM })).toEqual({ ok: true });
  });

  it("accepte deux reports reliés par un prédicat relationnel", () => {
    const answer =
      "Bernard souligne que l'expérimentateur obéit à un déterminisme absolu des phénomènes, mais " +
      "Descartes montre que la connaissance remonte des effets aux causes : le déterminisme " +
      "bernardien **applique** ainsi l'exigence d'ordre que le doute cartésien énonce pour l'esprit, " +
      "et non l'inverse — la mesure devient le laboratoire de la règle cartésienne.";
    expect(judgeConclusion({ answer, claim: REAL_CLAIM })).toEqual({ ok: true });
  });

  it("refuse la reprise de la question quand elle n'est pas une juxtaposition", () => {
    // même défaut, mais sans connecteur de bipartition : le prong structurel ne peut pas
    // le voir, c'est le recouvrement avec la question qui le coupe (0,846 mesuré sur la
    // sortie réelle, d'où le seuil propre à l'enquête, un cran sous les 0,85 partagés)
    const answer =
      "Bernard affirme que l'expérimentateur ne fait qu'obéir aux lois de la nature, et " +
      "Descartes soutient que la connaissance naît de l'expérience particulière pour déduire " +
      "les causes.";
    expect(judgeConclusion({ answer, claim: REAL_CLAIM })).toMatchObject({
      reason: "conclusion_recopie_la_question",
    });
  });

  it("refuse un énoncé non francophone et un énoncé vide", () => {
    expect(
      judgeConclusion({
        answer:
          "The two documents describe the same requirement and both reject everything that " +
          "cannot be verified before a conclusion is stated.",
        claim: REAL_CLAIM,
      })
    ).toMatchObject({ reason: "conclusion_langue" });
    expect(judgeConclusion({ answer: "   ", claim: REAL_CLAIM })).toMatchObject({
      reason: "conclusion_hors_format",
    });
  });
});

describe("isProseJuxtaposition — la règle est structurelle, pas attributive", () => {
  it("découpe à **chaque** connecteur, pas seulement au premier de la liste", () => {
    // la version d'origine coupait au premier connecteur trouvé dans la liste puis
    // cherchait les suivants dans le reste seulement : « A mais B tandis que C » ne
    // donnait que deux clauses, la première portant deux reports
    const clauses = splitProseClauses(
      "Bernard affirme l'obéissance, mais Descartes montre la remontée des causes, " +
        "tandis que l'expérimentateur décrit les phénomènes."
    );
    expect(clauses).toHaveLength(3);
    expect(clauses.every((c) => hasReportingVerb(c))).toBe(true);
  });

  it("ne juge pas un énoncé sans connecteur, même s'il empile deux reports", () => {
    // limite assumée : la règle nomme une forme (coordination contrastive). Un énoncé
    // qui empile sans connecteur passe — un refus n'instruit que s'il est précis, et
    // la règle préfère laisser passer un cas douteux que condamner « et » partout.
    expect(
      isProseJuxtaposition(
        "Bernard souligne l'obéissance de l'expérimentateur et Descartes décrit la remontée des " +
          "effets aux causes cachées du vivant."
      )
    ).toBe(false);
  });

  it("ne juge pas un énoncé dont le connecteur sépare une seule attribution", () => {
    expect(isProseJuxtaposition(REAL_HOLISTIC)).toBe(false);
  });

  it("coupe la juxtaposition même quand la question n'a pas été reformulée", () => {
    // la version « attributive » de la règle était aveugle ici : mesurée sur cette
    // sortie, la clause « Descartes montre que… » ne partage que 0,27 de ses termes
    // avec le fragment qu'elle résume — le modèle attribue sans reprendre les mots
    expect(isProseJuxtaposition(REAL_JUXTAPOSITION)).toBe(true);
  });
});
