import { describe, expect, it } from "vitest";
import {
  CLAIM_TEXT_PROFILE,
  isNearDuplicateTokens,
  isParaphraseOf,
  lexicalContainment,
  looksEnglish,
  mentionsProtocolReference,
  normalizeText,
  rejectText,
  textTokens,
} from "@/lib/quality/text-rules";
import {
  rejectSynthesis,
  synthesisTokens,
  SYNTHESIS_MAX_WORDS,
} from "@/lib/synth/rules";

describe("barrière qualité partagée (lib/quality/text-rules)", () => {
  it("normalise comme l'évaluateur (accents, ponctuation, casse)", () => {
    expect(normalizeText("L'Étendue, la Grandeur — le Mouvement !")).toBe(
      "l etendue la grandeur le mouvement"
    );
  });

  it("détecte les repères de protocole : famille indexée (Phase 6) et famille historique", () => {
    // mesuré sur le premier tour réel de la Phase 6 : « Le fragment [0] affirme que… » était
    // le texte **affiché**, puisque `messages.text` est l'union des affirmations
    expect(mentionsProtocolReference("Le fragment [0] affirme que la vérité résiste.")).toBe(true);
    expect(mentionsProtocolReference("voir [12] et [3]")).toBe(true);
    expect(mentionsProtocolReference("le fragment 2 décrit la mesure")).toBe(true);
    expect(mentionsProtocolReference("le document n°3 le confirme")).toBe(true);
    // la famille historique reste couverte (elle n'était appliquée qu'aux profils 2A/5A)
    expect(mentionsProtocolReference("Texte 1 explique la mesure")).toBe(true);
    expect(mentionsProtocolReference("A soutient que le doute est premier")).toBe(true);
    // le discours sur le sujet n'est pas touché
    expect(mentionsProtocolReference("Le doute méthodique écarte les opinions probables.")).toBe(
      false
    );
    expect(mentionsProtocolReference("Les conditions de l'expérience exigent une mesure répétée.")).toBe(
      false
    );
  });

  it("extrait les termes significatifs (mots courts, vides et chiffres écartés)", () => {
    const tokens = textTokens("Le béton de la trame 1848 est très brut.");
    expect(tokens.has("beton")).toBe(true);
    expect(tokens.has("trame")).toBe(true);
    expect(tokens.has("brut")).toBe(false); // 4 lettres : trop court pour une signature
    expect(tokens.has("le")).toBe(false);
    expect(tokens.has("1848")).toBe(false);
  });

  it("mesure le recouvrement lexical et détecte les quasi-doublons", () => {
    expect(lexicalContainment(new Set(), textTokens("béton"))).toBe(0);
    const a = textTokens("Claude Bernard soutient que l'intuition engendre l'idée expérimentale.");
    const b = textTokens(
      "Claude Bernard affirme que l'intuition ou le sentiment engendre l'idée expérimentale."
    );
    expect(isNearDuplicateTokens(a, b)).toBe(true);
    // deux textes qui ne partagent qu'un mot ne sont pas des doublons
    expect(
      isNearDuplicateTokens(
        textTokens("La géométrie éclaire la physique chez Descartes."),
        textTokens("La physique quantique contredit la géométrie euclidienne.")
      )
    ).toBe(false);
  });

  it("le profil des claims est inchangé (2A reste comparable)", () => {
    expect(rejectText("   ", CLAIM_TEXT_PROFILE)).toBe("generic");
    expect(
      rejectText("Les deux auteurs accordent une importance centrale à l'observation.", CLAIM_TEXT_PROFILE)
    ).toBe("generic");
    expect(
      rejectText("Le doute méthodique de Descartes rejoint le doute expérimental de Bernard.", CLAIM_TEXT_PROFILE)
    ).toBeNull();
  });

  it("détecte un texte anglais sans rejeter un nom propre anglais", () => {
    expect(
      looksEnglish(
        normalizeText("The two authors share a common view of the experimental method and of doubt.")
      )
    ).toBe(true);
    expect(
      looksEnglish(normalizeText("Le doute méthodique de Descartes rejoint le doute expérimental."))
    ).toBe(false);
  });
});

describe("barrière qualité des synthèses (Phase 5A étape 4)", () => {
  const evidence = [
    "Le brutalisme assume le beton brut et la trame structurelle de la facade.",
    "L'amortissement fiscal etale la charge d'un investissement sur plusieurs exercices.",
  ];

  it("accepte un énoncé qui ajoute quelque chose aux preuves", () => {
    expect(
      rejectSynthesis(
        "Rendre visible la charge que supporte une structure : le geste constructif et l'aveu de la contrainte procedent du meme arbitrage.",
        evidence
      )
    ).toBeNull();
  });

  it("refuse la paraphrase d'UNE preuve (aucune preuve ne dit cela seule)", () => {
    const paraphrase =
      "Le brutalisme assume le beton brut et la trame structurelle de la facade du batiment.";
    expect(rejectSynthesis(paraphrase, evidence)).toBe("paraphrase");
    // une paraphrase n'est refusée que si elle est comparée à ses preuves
    expect(rejectSynthesis(paraphrase, [])).toBeNull();
  });

  it("refuse un énoncé creux, trop long, générique ou anglais", () => {
    expect(rejectSynthesis("Voir ci-dessus.", evidence)).toBe("tooShort");
    expect(rejectSynthesis("", evidence)).toBe("tooShort");

    const long = `${"Le mecanisme decrit conduit a une consequence structurelle. ".repeat(3)}`;
    expect(rejectSynthesis(long, evidence)).toBe("tooLong");
    const manyWords = Array.from({ length: SYNTHESIS_MAX_WORDS + 5 }, (_, i) => `terme${i}`).join(
      " "
    );
    expect(rejectSynthesis(manyWords, evidence)).toBe("tooLong");

    expect(
      rejectSynthesis("Les deux textes accordent une importance centrale a la structure.", evidence)
    ).toBe("generic");
    expect(
      rejectSynthesis(
        "The documents together show that structure and amortization share a common logic.",
        evidence
      )
    ).toBe("english");
  });

  it("rejette les repères techniques du prompt", () => {
    expect(
      rejectSynthesis("La preuve A soutient que la facade est structurelle.", evidence)
    ).not.toBeNull();
  });

  it("isParaphraseOf ne déclenche pas quand le recouvrement reste sous le seuil", () => {
    expect(isParaphraseOf(synthesisTokens("Betón brut de la facade eternelle."), evidence)).toBe(
      false
    );
    expect(
      isParaphraseOf(
        synthesisTokens("Le brutalisme assume le beton et la trame structurelle de la facade."),
        evidence
      )
    ).toBe(true);
  });
});
