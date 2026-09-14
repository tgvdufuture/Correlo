import { describe, expect, it } from "vitest";
import { buildSynthesisPrompt, type PromptEvidence } from "@/lib/synth/prompts";
import { attachSynthesisResult, makeSynthesisSchema } from "@/lib/synth/parser";

const EVIDENCE: PromptEvidence[] = [
  { index: 0, text: "Le brutalisme assume le beton brut.", sourceTitle: "Vers une architecture" },
  { index: 1, text: "L'amortissement etale la charge fiscale.", sourceTitle: null },
  { index: 2, text: "La facade reprend la trame du beton coule.", sourceTitle: "Beton armé" },
];

describe("prompt de synthèse (Phase 5A étape 4)", () => {
  it("numérote les preuves et n'expose jamais d'identifiant de fragment", () => {
    const messages = buildSynthesisPrompt({ seedLabel: "beton · trame", evidence: EVIDENCE });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    const user = messages[1].content;
    expect(user).toContain("beton · trame");
    expect(user).toContain("--- Preuve 0 (« Vers une architecture ») ---");
    expect(user).toContain("--- Preuve 2 (« Beton armé ») ---");
    // le titre est optionnel : la preuve sans titre ne porte pas de parenthèses vides
    expect(user).toContain("--- Preuve 1 ---");
    expect(user).not.toContain("--- Preuve 1 (");
    // aucune trace d'un id technique
    expect(user).not.toMatch(/frag-|source_id|uuid/i);
  });

  it("exige le test de soustraction, autorise l'abstention et ne fait pas du skip la sortie par défaut", () => {
    const system = buildSynthesisPrompt({ seedLabel: "t", evidence: EVIDENCE })[0].content;
    expect(system).toContain("TEST DE LA SOUSTRACTION");
    expect(system).toContain('{"skip": true}');
    expect(system).toContain("FACT");
    // la synthèse n'est jamais un FACT : la base le refuserait
    expect(system).toMatch(/FACT[\s\S]*INTERDIT/);
    // révision v2 : le skip n'est plus présenté comme « infiniment préférable »
    expect(system).not.toContain("infiniment mieux");
    expect(system).toContain("SKIP — à utiliser pour un constat PRÉCIS");
  });

  it("rappelle dans le prompt les énoncés déjà formulés du run", () => {
    const messages = buildSynthesisPrompt({
      seedLabel: "t",
      evidence: EVIDENCE,
      priorSyntheses: ["Le beton et l'amortissement repondent a la meme contrainte."],
    });
    expect(messages[1].content).toContain("SYNTHÈSES DÉJÀ FORMULÉES");
    expect(messages[1].content).toContain("meme contrainte");
    // et ne l'ajoute pas quand il n'y a rien
    expect(
      buildSynthesisPrompt({ seedLabel: "t", evidence: EVIDENCE })[1].content
    ).not.toContain("SYNTHÈSES DÉJÀ FORMULÉES");
  });

  it("tronque les preuves longues (quotas d'entrée du provider)", () => {
    const long = "x".repeat(500);
    const messages = buildSynthesisPrompt({
      seedLabel: "t",
      evidence: [{ index: 0, text: long, sourceTitle: null }],
      maxEvidenceChars: 100,
    });
    expect(messages[1].content).toContain("…[tronqué]");
    expect(messages[1].content).not.toContain("x".repeat(200));
  });
});

describe("schéma de sortie d'une synthèse", () => {
  const valid = {
    synthesis: "Le beton et l'amortissement repondent a la meme contrainte de duree.",
    relation_kind: "combination" as const,
    evidence: [0, 1],
    confidence: "medium" as const,
    epistemic_status: "INFERENCE" as const,
  };

  it("accepte une sortie conforme", () => {
    const parsed = makeSynthesisSchema(3).parse(valid);
    expect(attachSynthesisResult(parsed)).toMatchObject({
      synthesis: valid.synthesis,
      relationKind: "combination",
      evidenceIndices: [0, 1],
      confidence: "medium",
      epistemicStatus: "INFERENCE",
      skipped: false,
    });
  });

  it("accepte l'abstention et refuse l'abstention accompagnée de champs", () => {
    const parsed = makeSynthesisSchema(3).parse({ skip: true });
    expect(attachSynthesisResult(parsed).skipped).toBe(true);
    expect(() => makeSynthesisSchema(3).parse({ skip: true, synthesis: "Un énoncé." })).toThrow();
  });

  it("refuse un indice de preuve halluciné ou dupliqué", () => {
    expect(() => makeSynthesisSchema(3).parse({ ...valid, evidence: [0, 7] })).toThrow();
    expect(() => makeSynthesisSchema(3).parse({ ...valid, evidence: [0, 0] })).toThrow();
  });

  it("refuse une synthèse à moins de deux preuves", () => {
    expect(() => makeSynthesisSchema(3).parse({ ...valid, evidence: [1] })).toThrow();
  });

  it("refuse les champs manquants hors abstention", () => {
    expect(() => makeSynthesisSchema(3).parse({ evidence: [0, 1] })).toThrow();
    expect(() => makeSynthesisSchema(3).parse({ ...valid, confidence: undefined })).toThrow();
  });

  it("ne peut pas représenter un FACT (une synthèse n'est jamais un fait)", () => {
    expect(() =>
      makeSynthesisSchema(3).parse({ ...valid, epistemic_status: "FACT" })
    ).toThrow();
  });
});
