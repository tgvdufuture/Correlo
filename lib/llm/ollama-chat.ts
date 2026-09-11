import type { z } from "zod";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";
import { chatWithJsonCorrection } from "@/lib/llm/chat";
import { LlmError, LlmNetworkError, LlmOutputError } from "@/lib/llm/errors";

/**
 * Chat Ollama local (API /api/chat, format json, stream false).
 * PRD : OLLAMA_CHAT_MODEL — alternative locale, jamais de bascule silencieuse.
 */
export class OllamaChatProvider implements LlmProvider {
  constructor(private opts: { baseUrl: string; model: string }) {}

  async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    const call = async (msgs: ChatMessage[]): Promise<string> => {
      // un seul signal couvre fetch + lecture du corps (res.json())
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
      let res: Response;
      let data: { message?: { content?: unknown } };
      try {
        res = await fetch(`${this.opts.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.opts.model, messages: msgs, stream: false, format: "json" }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          throw new LlmNetworkError(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        data = (await res.json()) as { message?: { content?: unknown } };
      } catch (e) {
        if (e instanceof LlmNetworkError) throw e;
        if ((e as Error).name === "AbortError") {
          throw new LlmNetworkError(
            `Ollama ne répond pas (timeout ${CHAT_TIMEOUT_MS / 1000}s, ${this.opts.baseUrl})`
          );
        }
        throw new LlmNetworkError(`Ollama injoignable (${this.opts.baseUrl}) : ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      const content = data.message?.content;
      if (typeof content !== "string") {
        throw new LlmOutputError("Réponse Ollama sans contenu exploitable");
      }
      return content;
    };
    return chatWithJsonCorrection({ call, messages, schema });
  }

  embed(): Promise<number[]> {
    throw new LlmError("no_embeddings", "OllamaChatProvider ne fournit pas d'embeddings (OllamaProvider requis)");
  }
}

/** Timeout global d'un échange chat (fetch + corps). */
const CHAT_TIMEOUT_MS = 120_000;