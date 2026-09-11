import type { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Interface verrouillée par le PRD §3.1/§3.2 — DO NOT CHANGE.
 * chat = provider configurable ; embed = Ollama local. Aucune référence Gemini.
 */
export interface LlmProvider {
  /** Appel chat avec sortie JSON validée par schéma Zod (+ 1 retry de correction). */
  chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>>;
  /** Embedding d'un texte (Ollama local, Float32 L2-normalisé côté codec). */
  embed(text: string): Promise<number[]>;
}

/**
 * Extension optionnelle (hors interface verrouillée) : embeddings par lot en un
 * seul appel réseau — Ollama traite le batch en une passe GPU.
 */
export interface EmbedBatcher {
  embedMany(texts: string[]): Promise<number[][]>;
}