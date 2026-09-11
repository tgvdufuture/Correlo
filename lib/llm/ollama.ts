import type { z } from "zod";
import type { EmbedBatcher, LlmProvider } from "@/lib/llm/types";
import { LlmError, LlmNetworkError, LlmOutputError } from "@/lib/llm/errors";

/**
 * Embeddings Ollama locaux (API /api/embed) — PRD : nomic-embed-text uniquement,
 * aucun embedding cloud.
 */
export class OllamaProvider implements LlmProvider, EmbedBatcher {
  constructor(private opts: { baseUrl: string; model: string }) {}

  async embed(text: string): Promise<number[]> {
    const vectors = await this.embedMany([text]);
    return vectors[0];
  }

  /** Un seul appel /api/embed pour N textes (batch GPU) — timeout 60 s. */
  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        res = await fetch(`${this.opts.baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.opts.model, input: texts }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new LlmNetworkError(`Ollama ne répond pas (timeout 60s, ${this.opts.baseUrl})`);
      }
      throw new LlmNetworkError(`Ollama injoignable (${this.opts.baseUrl}) : ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new LlmNetworkError(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { embeddings?: unknown };
    const embeddings = data.embeddings as unknown[] | undefined;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new LlmOutputError(
        `Réponse Ollama sans embedding exploitable (${embeddings?.length ?? 0}/${texts.length})`
      );
    }
    const out: number[][] = [];
    for (const e of embeddings) {
      if (!Array.isArray(e) || !e.every((v) => typeof v === "number")) {
        throw new LlmOutputError("Réponse Ollama avec un embedding invalide");
      }
      out.push(e as number[]);
    }
    return out;
  }

  chat<T extends z.ZodType>(): Promise<z.infer<T>> {
    throw new LlmError(
      "no_chat",
      "OllamaProvider ne fournit pas de chat (voir OllamaChatProvider / GroqProvider)"
    );
  }
}