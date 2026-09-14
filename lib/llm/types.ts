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

/**
 * Cache par hash de prompt (modèle | version de prompt | messages).
 *
 * Interface minimale — et non `Map` — pour que l'implémentation puisse être
 * **persistante** (`lib/repositories/llm-cache.ts`) : c'est ce qui rend un rejeu
 * de run reproductible, donc ce qui permet à la dédup `content_sig` de faire son
 * travail (le modèle ne reformule plus la même question). Une `Map` en mémoire
 * satisfait cette interface : les tests peuvent l'utiliser telle quelle.
 */
export interface PromptCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
}