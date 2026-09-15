import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GroqProvider } from "@/lib/llm/groq";
import { LlmNetworkError, LlmTransientError } from "@/lib/llm/errors";

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

/**
 * Sans `reasoning_effort`, un modèle de raisonnement ne raisonne pas : il rend la
 * sortie la plus courte possible (mesuré sur Groq : 6 tokens, `{skip:true}`), ce qui
 * vide de sens toute consigne de synthèse. Le champ doit donc être transmis — mais
 * jamais imposé à un endpoint qui ne le connaît pas. */
/**
 * Constaté en réel (2026-09-13) : Groq répond `HTTP 400 json_validate_failed` avec
 * `failed_generation: ""` quand un modèle de raisonnement épuise son budget avant
 * d'écrire le JSON — aucun `finish_reason` n'est alors renvoyé, donc le réessai sur
 * troncature ne peut pas s'en saisir. À température 0 la sortie est déterministe : les
 * 5 attempts du job tombaient sur le même prompt. Le repli consiste à rejouer **sans**
 * `response_format`, le JSON étant extrait du texte par `chatWithJsonCorrection`.
 */
describe("GroqProvider — mode JSON refusé par le provider", () => {
  function jsonRefused() {
    return new Response(
      JSON.stringify({
        error: {
          message: "Failed to validate JSON. Please adjust your prompt.",
          type: "invalid_request_error",
          code: "json_validate_failed",
          failed_generation: "",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  it("rejoue sans response_format et récupère le JSON noyé dans le texte", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      if (bodies.length === 1) return jsonRefused();
      // 2e essai : pas de mode JSON imposé, le modèle bavarde puis rend l'objet
      return reply(
        'Voici le résultat : {"results":[{"candidate_id":0,"claim":"A prolonge B."}]}'
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GroqProvider({ apiKey: "k", model: "m", maxTokens: 1000 });
    const out = await provider.chat([{ role: "user", content: "paires" }], schema);

    expect(out.results[0].claim).toBe("A prolonge B.");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect("response_format" in bodies[1]).toBe(false);
  });

  it("ne masque pas un 400 sans rapport avec le mode JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GroqProvider({ apiKey: "k", model: "m" });
    await expect(
      provider.chat([{ role: "user", content: "paires" }], schema)
    ).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Distinguer « le provider est passagèrement surchargé » de « la configuration est
 * fausse » : le premier mérite un réessai d'appel (il ne doit pas consommer une
 * tentative de job), le second doit échouer tout de suite et visiblement.
 */
describe("GroqProvider — nature des incidents (réessayable ou définitive)", () => {
  /** Erreur réellement levée par `chat` pour la réponse simulée. */
  async function errorFor(response: () => Promise<Response>): Promise<Error> {
    vi.stubGlobal("fetch", vi.fn(response));
    const provider = new GroqProvider({ apiKey: "k", model: "m" });
    return provider.chat([{ role: "user", content: "paires" }], schema).then(
      () => new Error("aucune erreur levée"),
      (e: Error) => e
    );
  }

  it("503 « Service temporarily overloaded » → incident passager", async () => {
    const err = await errorFor(async () =>
      new Response(JSON.stringify({ error: { message: "Service temporarily overloaded" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    );
    expect(err).toBeInstanceOf(LlmTransientError);
  });

  it("timeout de l'échange → incident passager", async () => {
    const err = await errorFor(async () => {
      const abort = new Error("This operation was aborted");
      abort.name = "AbortError";
      throw abort;
    });
    expect(err).toBeInstanceOf(LlmTransientError);
  });

  it("connexion coupée en cours d'échange → incident passager", async () => {
    const err = await errorFor(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    });
    expect(err).toBeInstanceOf(LlmTransientError);
  });

  it("404 de modèle inconnu → erreur définitive (pas de réessai)", async () => {
    const err = await errorFor(async () =>
      new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    );
    expect(err).toBeInstanceOf(LlmNetworkError);
    expect(err).not.toBeInstanceOf(LlmTransientError);
  });

  it("hôte inexistant (ENOTFOUND) → erreur définitive", async () => {
    const err = await errorFor(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    expect(err).toBeInstanceOf(LlmNetworkError);
    expect(err).not.toBeInstanceOf(LlmTransientError);
  });
});

describe("GroqProvider — effort de raisonnement", () => {
  async function captureBody(opts: { reasoningEffort?: "low" | "medium" | "high" }) {
    const bodies: Record<string, unknown>[] = [];
    const valid = JSON.stringify({ results: [{ candidate_id: 0, claim: "A prolonge B." }] });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return reply(valid);
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GroqProvider({ apiKey: "k", model: "m", ...opts });
    await provider.chat([{ role: "user", content: "paires" }], schema);
    return bodies[0];
  }

  it("transmet reasoning_effort quand il est configuré", async () => {
    expect((await captureBody({ reasoningEffort: "low" })).reasoning_effort).toBe("low");
  });

  it("ne l'envoie pas par défaut (endpoints OpenAI-compatibles qui l'ignorent)", async () => {
    expect("reasoning_effort" in (await captureBody({}))).toBe(false);
  });
});
