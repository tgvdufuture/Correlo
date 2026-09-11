import { describe, expect, it } from "vitest";
import { buildDiscoveryPrompt, DISCOVERY_PROMPT_VERSION } from "@/lib/discover/prompts";

describe("prompt discovery", () => {
  it("tronque les fragments au maxFragmentChars (défaut 1 800)", () => {
    const long = "x".repeat(5000);
    const [system, user] = buildDiscoveryPrompt([
      { candidateId: 3, aText: long, bText: "court", aTitle: null, bTitle: null },
    ]);
    expect(user.content).toContain("--- Paire 3 ---");
    expect(user.content).toContain("<fragment>");
    expect(user.content).not.toContain("x".repeat(4000));
    expect(user.content).toContain("[tronqué]");
    // troncature personnalisée
    const [, user2] = buildDiscoveryPrompt(
      [{ candidateId: 0, aText: long, bText: "court", aTitle: "T", bTitle: null }],
      { maxFragmentChars: 500 }
    );
    expect(user2.content).not.toContain("x".repeat(600));
    expect(user2.content).toContain("« T »");
    // le fragment court n'est pas tronqué
    expect(user.content).toContain("<fragment>\ncourt\n</fragment>");
    // le contenu du modèle interdit les instructions dans les fragments
    expect(system.content).toMatch(/DONNEES NON FIABLES/);
  });

  it("verrouille le français et le test de spécificité (claims génériques)", () => {
    const [system] = buildDiscoveryPrompt([
      { candidateId: 0, aText: "a", bText: "b", aTitle: null, bTitle: null },
    ]);
    expect(system.content).toMatch(/LANGUE : le claim est TOUJOURS rédigé en français/);
    // le raisonnement est autorisé (il améliore la spécificité), mais le JSON final est obligatoire
    expect(system.content).toMatch(/Tu peux raisonner avant de conclure/);
    expect(system.content).toMatch(/se TERMINER par le JSON complet/);
    expect(system.content).toMatch(/TEST DE SPECIFICITE/);
    // formules génériques explicitement bannies
    expect(system.content).toContain("illustrent un même principe");
    expect(system.content).toContain("relation maître/apprenti");
    expect(system.content).toMatch(/deviendrait faux/);
  });

  it("interdit les repères A/B dans les claims et borne leur longueur", () => {
    const [system] = buildDiscoveryPrompt([
      { candidateId: 0, aText: "a", bText: "b", aTitle: null, bTitle: null },
    ]);
    expect(system.content).toMatch(/JAMAIS de repère du prompt dans un claim/);
    expect(system.content).toMatch(/au plus 30 mots/);
    expect(system.content).toMatch(/« A soutient que… » ou « Texte 1 soutient… » est invalide/);
  });

  it("exige qu'un fragment éclaire l'autre et bannit la comparaison de surface", () => {
    const [system] = buildDiscoveryPrompt([
      { candidateId: 0, aText: "a", bText: "b", aTitle: null, bTitle: null },
    ]);
    expect(system.content).toMatch(/un fragment ÉCLAIRE l'autre/);
    expect(system.content).toMatch(/comparaison de surface/);
  });

  it("interdit la répétition d'un même sujet ou fragment au fil du run", () => {
    const [system] = buildDiscoveryPrompt([
      { candidateId: 0, aText: "a", bText: "b", aTitle: null, bTitle: null },
    ]);
    expect(system.content).toMatch(/MÊME sujet, de la MÊME scène/);
    expect(system.content).toMatch(/plus de deux ou trois claims/);
  });

  it("interdit l'ancrage lexical (coïncidence de vocabulaire)", () => {
    const [system] = buildDiscoveryPrompt([
      { candidateId: 0, aText: "a", bText: "b", aTitle: null, bTitle: null },
    ]);
    expect(system.content).toMatch(/ANCRAGE LEXICAL — INTERDIT/);
    expect(system.content).toContain("coïncidence de vocabulaire");
    expect(system.content).toContain("corde suspend un objet");
    expect(system.content).toContain("support d'une ascension");
  });

  it("anti-redites : les claims déjà formulés sont fournis au modèle", () => {
    const pair = { candidateId: 0, aText: "a", bText: "b", aTitle: null, bTitle: null };
    const [system] = buildDiscoveryPrompt([pair]);
    expect(system.content).toMatch(/REDITES/);

    const withoutPrior = buildDiscoveryPrompt([pair])[1].content;
    expect(withoutPrior).not.toContain("CONNEXIONS DÉJÀ FORMULÉES");

    const [withPriorSys, withPriorUserMsg] = buildDiscoveryPrompt([pair], {
      priorClaims: ["A contredit la prémisse de B."],
    });
    const withPriorUser = withPriorUserMsg.content as string;
    expect(withPriorUser).toContain("CONNEXIONS DÉJÀ FORMULÉES");
    expect(withPriorUser).toContain("A contredit la prémisse de B.");
    // les claims déjà formulés ne polluent pas le prompt système (cache stable)
    expect(withPriorSys.content).toBe(system.content);
  });

  it("version du prompt stable et non vide", () => {
    expect(DISCOVERY_PROMPT_VERSION).toMatch(/^discovery-v\d+$/);
  });
});