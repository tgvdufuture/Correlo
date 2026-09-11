import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GroqProvider } from "@/lib/llm/groq";

const schema = z.object({
  results: z.array(z.object({ candidate_id: z.number(), claim: z.string() })),
});

function reply(content: string, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GroqProvider — budget de sortie", () => {
  it("rejoue avec un budget doublé quand le raisonnement a tronqué la réponse", async () => {
    const calls: { max_tokens?: number }[] = [];
    const valid = JSON.stringify({ results: [{ candidate_id: 0, claim: "A contredit B." }] });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { max_tokens?: number };
      calls.push(body);
      // 1er appel : le modèle raisonne et épuise son budget (finish_reason=length) → JSON absent
      if (calls.length === 1) return reply("We need to output JSON. Let's analyze each pair…", "length");
      return reply(valid);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GroqProvider({ apiKey: "k", model: "m", maxTokens: 1000 });
    const out = await provider.chat([{ role: "user", content: "paires" }], schema);

    expect(out.results[0].claim).toBe("A contredit B.");
    expect(calls).toHaveLength(2);
    expect(calls[0].max_tokens).toBe(1000);
    expect(calls[1].max_tokens).toBe(2000);
  });

  it("n'appelle qu'une fois quand la réponse n'est pas tronquée", async () => {
    const valid = JSON.stringify({ results: [{ candidate_id: 0, claim: "A prolonge B." }] });
    const fetchMock = vi.fn(async () => reply(valid));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GroqProvider({ apiKey: "k", model: "m", maxTokens: 1000 });
    await provider.chat([{ role: "user", content: "paires" }], schema);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
