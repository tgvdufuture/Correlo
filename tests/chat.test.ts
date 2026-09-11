import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatWithJsonCorrection } from "@/lib/llm/chat";
import { LlmOutputError } from "@/lib/llm/errors";

const schema = z.object({ claim: z.string(), skip: z.boolean().optional() });

const messages = [{ role: "user" as const, content: "analyse" }];

describe("chatWithJsonCorrection", () => {
  it("valide une sortie JSON directe en un seul appel", async () => {
    let calls = 0;
    const result = await chatWithJsonCorrection({
      call: async () => {
        calls += 1;
        return '{"claim":"connexion"}';
      },
      messages,
      schema,
    });
    expect(result.claim).toBe("connexion");
    expect(calls).toBe(1);
  });

  it("récupère un JSON noyé dans de la prose (modèles bavards)", async () => {
    let calls = 0;
    const result = await chatWithJsonCorrection({
      call: async () => {
        calls += 1;
        return "We need to output JSON with results array. Let's decide:\n{\"claim\":\"noix\",\"skip\":false}\nDone.";
      },
      messages,
      schema,
    });
    expect(result.claim).toBe("noix");
    expect(calls).toBe(1); // aucune correction nécessaire
  });

  it("ignore les accolades des chaînes et des échappements", async () => {
    const result = await chatWithJsonCorrection({
      call: async () => 'préambule {"claim":"a { b } \\" c","skip":true} suite',
      messages,
      schema,
    });
    expect(result.claim).toBe('a { b } " c');
  });

  it("retry de correction quand la sortie reste invalide, puis échec explicite", async () => {
    let calls = 0;
    await expect(
      chatWithJsonCorrection({
        call: async () => {
          calls += 1;
          return "pas de JSON ici";
        },
        messages,
        schema,
      })
    ).rejects.toBeInstanceOf(LlmOutputError);
    expect(calls).toBe(2); // appel initial + 1 retry de correction
  });

  it("le retry de correction peut sauver la mise", async () => {
    let calls = 0;
    const result = await chatWithJsonCorrection({
      call: async () => {
        calls += 1;
        return calls === 1 ? "réponse bavarde sans objet" : '{"claim":"corrigé"}';
      },
      messages,
      schema,
    });
    expect(result.claim).toBe("corrigé");
    expect(calls).toBe(2);
  });
});
