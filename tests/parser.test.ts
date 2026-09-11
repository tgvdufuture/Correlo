import { describe, expect, it } from "vitest";
import { makeDiscoveryBatchSchema, attachResults } from "@/lib/discover/parser";

const base = {
  claim: "Les deux fragments décrivent un même phénomène.",
  relation_type: "analogy" as const,
  tier: "medium" as const,
  epistemic_status: "INFERENCE" as const,
};

const skipOnly = {
  relation_type: "analogy" as const,
  tier: "medium" as const,
  epistemic_status: "INFERENCE" as const,
  skip: true as const,
};

describe("parser discovery (Zod + rattachement)", () => {
  it("accepte une sortie valide et rattache les candidate_id", () => {
    const schema = makeDiscoveryBatchSchema(3);
    const parsed = schema.parse({
      results: [
        { candidate_id: 1, ...base },
        { candidate_id: 2, ...base, relation_type: "cause", cause_fragment: "b" },
        { candidate_id: 0, ...skipOnly },
      ],
    });
    const attached = attachResults(parsed);
    expect(attached).toHaveLength(3);
    expect(attached[0].candidateId).toBe(1);
    expect(attached[1].causeSide).toBe("b");
    expect(attached[2].skipped).toBe(true);
    expect(attached[2].claim).toBe(""); // skip ⇒ pas de claim
  });

  it("rejette un candidate_id hors du batch", () => {
    const schema = makeDiscoveryBatchSchema(2);
    expect(() =>
      schema.parse({ results: [{ candidate_id: 2, ...base }] })
    ).toThrow();
  });

  it("rejette un candidate_id dupliqué", () => {
    const schema = makeDiscoveryBatchSchema(3);
    expect(() =>
      schema.parse({ results: [{ candidate_id: 1, ...base }, { candidate_id: 1, ...base }] })
    ).toThrow();
  });

  it("cause sans cause_fragment : accepté par le schéma (filtré par le service)", () => {
    // un oubli du modèle ne fait pas échouer tout le batch ; le service ignore l'entrée
    const schema = makeDiscoveryBatchSchema(2);
    expect(() =>
      schema.parse({ results: [{ candidate_id: 0, ...base, relation_type: "cause" }] })
    ).not.toThrow();
  });

  it("skip : claim ignoré ; skip + claim mutuellement exclusifs ; claim requis sinon", () => {
    const schema = makeDiscoveryBatchSchema(2);
    expect(() => schema.parse({ results: [{ candidate_id: 0, ...skipOnly }] })).not.toThrow();
    expect(() =>
      schema.parse({ results: [{ candidate_id: 0, ...skipOnly, claim: "quand même" }] })
    ).toThrow();
    expect(() =>
      schema.parse({
        results: [{ candidate_id: 0, relation_type: "analogy", tier: "medium", epistemic_status: "INFERENCE" }],
      })
    ).toThrow();
  });

  it("objet skip pur (aucun autre champ) : accepté", () => {
    const schema = makeDiscoveryBatchSchema(2);
    expect(() => schema.parse({ results: [{ candidate_id: 0, skip: true }] })).not.toThrow();
    // non-skip sans les champs obligatoires : rejeté
    expect(() => schema.parse({ results: [{ candidate_id: 0 }] })).toThrow();
  });

  it("rejette un claim vide (blank)", () => {
    const schema = makeDiscoveryBatchSchema(2);
    expect(() =>
      schema.parse({ results: [{ candidate_id: 0, ...base, claim: "   " }] })
    ).toThrow();
  });
});