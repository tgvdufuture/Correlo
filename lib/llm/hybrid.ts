import type { z } from "zod";
import type { ChatMessage, EmbedBatcher, LlmProvider } from "@/lib/llm/types";

/**
 * Composition (PRD §3.1) : chat → `LLM_CHAT_PROVIDER` (groq|ollama),
 * embed → `EMBED_PROVIDER` (ollama local | connecteur API). Aucun fallback
 * automatique : le connecteur d'embeddings est un choix, et son espace vectoriel
 * est un réglage du corpus (voir `lib/llm/embedding-space.ts`).
 */
export class HybridProvider implements LlmProvider, EmbedBatcher {
  constructor(
    private chatProvider: LlmProvider,
    private embedProvider: LlmProvider
  ) {}

  chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    return this.chatProvider.chat(messages, schema);
  }

  embed(text: string): Promise<number[]> {
    return this.embedProvider.embed(text);
  }

  embedMany(texts: string[]): Promise<number[][]> {
    const batcher = (this.embedProvider as Partial<EmbedBatcher>).embedMany;
    if (batcher) return batcher.call(this.embedProvider, texts);
    return Promise.all(texts.map((t) => this.embedProvider.embed(t)));
  }
}