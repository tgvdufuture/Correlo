import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiEmbedProvider } from "@/lib/llm/api-embed";
import {
  LlmAuthError,
  LlmNetworkError,
  LlmOutputError,
  LlmRateLimitError,
  LlmTransientError,
} from "@/lib/llm/errors";

/**
 * Le connecteur d'embeddings par API. Aucun réseau : `fetch` est remplacé, et les
 * tests portent sur ce qui a réellement cassé en pratique sur ce genre d'endpoint —
 * l'ordre du lot, le champ `input_type` refusé par certains services, et la
 * distinction entre un incident passager et une erreur définitive.
 */

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(url, init)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const embed = (texts: string[], indexOffset = 0) => ({
  data: texts.map((_, i) => ({ index: i + indexOffset, embedding: Array.from({ length: 4 }, (_, k) => i + k * 0.5) })),
});

afterEach(() => vi.unstubAllGlobals());

describe("connecteur d'embeddings par API (OpenAI-compatible)", () => {
  it("envoie modèle, lot et input_type, et normalise l'URL", async () => {
    const fetchMock = stubFetch((url, init) => {
      expect(url).toBe("https://api.test/v1/embeddings");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ model: "mon-modele", input: ["a", "b"], input_type: "passage" });
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
      return jsonResponse(embed(["a", "b"]));
    });
    const provider = new ApiEmbedProvider({
      apiKey: "k",
      model: "mon-modele",
      baseUrl: "https://api.test/v1/",
      inputType: "passage",
    });
    const vectors = await provider.embedMany(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([0, 0.5, 1, 1.5]);
  });

  it("omet input_type quand il n'est pas configuré (endpoints qui rejettent un champ inconnu)", async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body).not.toHaveProperty("input_type");
      return jsonResponse(embed(["a"]));
    });
    await new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" }).embed("a");
  });

  it("n'envoie pas d'en-tête Authorization sans clé (endpoint anonyme)", async () => {
    stubFetch((_url, init) => {
      expect(init.headers).not.toHaveProperty("Authorization");
      return jsonResponse(embed(["a"]));
    });
    await new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" }).embed("a");
  });

  /**
   * L'ordre de `data` n'est pas contractuel côté OpenAI-compatible. L'associer à
   * l'aveugle au texte d'entrée attacherait le vecteur de B au texte de A — un
   * décalage silencieux, invisible dans les métriques.
   */
  it("réordonne le lot par index (l'ordre de data n'est pas contractuel)", async () => {
    stubFetch(() =>
      jsonResponse({
        data: [
          { index: 1, embedding: [10, 10] },
          { index: 0, embedding: [5, 5] },
        ],
      })
    );
    const provider = new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" });
    expect(await provider.embedMany(["premier", "second"])).toEqual([
      [5, 5],
      [10, 10],
    ]);
  });

  it("ne fait aucun appel pour une liste vide", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ data: [] }));
    expect(await new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" }).embedMany([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 → erreur d'authentification nommant le service", async () => {
    stubFetch(() => new Response("Authorization failed", { status: 401 }));
    const provider = new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" });
    await expect(provider.embed("a")).rejects.toBeInstanceOf(LlmAuthError);
  });

  it("429 → rate limit avec Retry-After (le worker attendra le bon délai)", async () => {
    stubFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "12" } }));
    const provider = new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" });
    const error = await provider.embed("a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmRateLimitError);
    expect((error as LlmRateLimitError).retryAfterSeconds).toBe(12);
  });

  it("503 → incident passager (réessayé sans consommer une tentative du job)", async () => {
    stubFetch(() => new Response("Service temporarily overloaded", { status: 503 }));
    const provider = new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" });
    await expect(provider.embed("a")).rejects.toBeInstanceOf(LlmTransientError);
  });

  it("404 → erreur définitive qui nomme le modèle et l'endpoint", async () => {
    stubFetch(() => new Response('{"detail":"Function not found for account"}', { status: 404 }));
    const provider = new ApiEmbedProvider({ model: "modele/inconnu", baseUrl: "https://api.test/v1" });
    const error = await provider.embed("a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmNetworkError);
    expect((error as Error).message).toContain("modele/inconnu");
    expect((error as Error).message).toContain("https://api.test/v1");
  });

  it("réponse sans vecteurs exploitables → sortie invalide (jamais de BLOB partiel)", async () => {
    stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] }));
    const provider = new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" });
    await expect(provider.embedMany(["a", "b"])).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("vecteur non numérique ou index hors lot → sortie invalide", async () => {
    stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1, "x"] }] }));
    const bad = new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" });
    await expect(bad.embed("a")).rejects.toBeInstanceOf(LlmOutputError);

    stubFetch(() => jsonResponse({ data: [{ index: 7, embedding: [1, 2] }] }));
    const outOfRange = new ApiEmbedProvider({ model: "m", baseUrl: "https://api.test/v1" });
    await expect(outOfRange.embed("a")).rejects.toBeInstanceOf(LlmOutputError);
  });
});
