import type { z } from "zod";
import type { EmbedBatcher, LlmProvider } from "@/lib/llm/types";
import {
  LlmAuthError,
  LlmError,
  LlmNetworkError,
  LlmOutputError,
  LlmRateLimitError,
  LlmTransientError,
} from "@/lib/llm/errors";

/**
 * Embeddings par connecteur API (endpoint OpenAI-compatible `POST /embeddings`).
 *
 * Même contrat que `OllamaProvider` — un seul appel réseau pour N textes — mais la
 * source des vecteurs est un service distant (NVIDIA NIM, Mistral, OpenAI…), ce qui
 * supprime la dépendance à un Ollama local pour vectoriser un dépôt.
 *
 * Trois spécificités mesurées sur le service réel (NVIDIA NIM, 2026-09-16) :
 *   1. `input_type` est attendu par les modèles de retrieval (`passage` pour un
 *      document indexé, `query` pour une requête) ; il est **omis** si non configuré,
 *      car les endpoints qui l'ignorent rejettent un champ inconnu ;
 *   2. les dimensions ne sont **pas négociables** (`dimensions: 768` → `400
 *      dimensions must be one of 2048`) : ce que le modèle rend est ce qu'on encode,
 *      et `EmbeddingService` refuse tout vecteur d'une autre longueur ;
 *   3. l'erreur de modèle inconnu est un `404` dont le corps contient l'id du
 *      modèle — sans lui, « 404 » ne se distingue pas d'une URL erronée.
 */
export class ApiEmbedProvider implements LlmProvider, EmbedBatcher {
  private readonly baseUrl: string;

  constructor(
    private opts: {
      apiKey?: string;
      model: string;
      baseUrl: string;
      /** `passage` (document indexé) | `query` | absent = aucun champ envoyé. */
      inputType?: "passage" | "query";
      timeoutMs?: number;
      label?: string;
    }
  ) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  async embed(text: string): Promise<number[]> {
    const vectors = await this.embedMany([text]);
    return vectors[0];
  }

  /** Un seul appel pour N textes (le batch est découpé par l'appelant). */
  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const label = this.opts.label ?? new URL(this.baseUrl).host;
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // endpoint anonyme : aucun en-tête Authorization (sinon 403)
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model,
          input: texts,
          ...(this.opts.inputType ? { input_type: this.opts.inputType } : {}),
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new LlmTransientError(`${label} ne répond pas (timeout ${timeoutMs / 1000}s, ${this.baseUrl})`);
      }
      throw new LlmNetworkError(
        `${label} injoignable (${this.baseUrl}) : ${(e as Error).message}${causeSuffix(e)}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
      throw new LlmAuthError(`${label} ${res.status}: authentification refusée — ${detail}`);
    }
    if (res.status === 429) {
      const raw = res.headers.get("retry-after");
      const seconds = raw ? Number(raw) : 60;
      throw new LlmRateLimitError(Number.isFinite(seconds) && seconds > 0 ? seconds : 60);
    }
    if (!res.ok) {
      const body = await res.text();
      const detail = body.replace(/\s+/g, " ").slice(0, 200);
      // incident passager (502/503 « overloaded », 504, 408) : réessayable sans
      // consommer une tentative du job, contrairement à un 404 de modèle inconnu
      if (res.status >= 500 || res.status === 408) {
        throw new LlmTransientError(
          `${label} HTTP ${res.status} [modèle « ${this.opts.model} » sur ${this.baseUrl}] : ${detail}`
        );
      }
      throw new LlmNetworkError(
        `${label} HTTP ${res.status} [modèle « ${this.opts.model} » sur ${this.baseUrl}] : ${detail}`
      );
    }

    let data: { data?: { embedding?: unknown; index?: unknown }[] };
    try {
      data = (await res.json()) as { data?: { embedding?: unknown; index?: unknown }[] };
    } catch (e) {
      throw new LlmOutputError(`Réponse ${label} illisible (JSON) : ${(e as Error).message}`);
    }
    const items = data.data;
    if (!Array.isArray(items) || items.length !== texts.length) {
      throw new LlmOutputError(
        `Réponse ${label} sans vecteurs exploitables (${items?.length ?? 0}/${texts.length})`
      );
    }
    // `index` est la seule façon fiable de réordonner un lot : l'ordre de `data`
    // n'est pas contractuel côté OpenAI-compatible, et l'associer à l'aveugle
    // attacherait le texte B au vecteur de A — un décalage silencieux.
    const ordered: number[][] = new Array(texts.length);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const idx = typeof item.index === "number" ? item.index : i;
      if (idx < 0 || idx >= texts.length) {
        throw new LlmOutputError(`Réponse ${label} avec un index hors lot (${idx})`);
      }
      const vec = item.embedding;
      if (!Array.isArray(vec) || !vec.every((v) => typeof v === "number")) {
        throw new LlmOutputError(`Réponse ${label} avec un vecteur invalide (index ${idx})`);
      }
      ordered[idx] = vec as number[];
    }
    return ordered;
  }

  chat<T extends z.ZodType>(): Promise<z.infer<T>> {
    throw new LlmError(
      "no_chat",
      "ApiEmbedProvider ne fournit pas de chat (voir GroqProvider / OllamaChatProvider)"
    );
  }
}

/** Cause racine d'une erreur fetch (code undici), pour le diagnostic. */
function causeSuffix(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  if (!cause) return "";
  return ` (cause : ${cause.code ?? cause.message ?? "inconnue"})`;
}
