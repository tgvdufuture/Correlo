import type { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Interface verrouillée par le PRD §3.1/§3.2 — DO NOT CHANGE.
 * chat = provider configurable ; embed = provider configurable (`EMBED_PROVIDER` :
 * Ollama local ou endpoint OpenAI-compatible). Aucune référence Gemini.
 *
 * Amendement v1.5 (2026-09-16, `PRD-v1.3-amendement.md` §10) : la seule évolution est
 * l'origine de l'embedding — les signatures ci-dessous sont inchangées. Le choix du
 * connecteur est un réglage **du corpus** : `lib/llm/embedding-space.ts` porte
 * l'invariant (un run ne compare que des vecteurs d'un même espace) et
 * `npm run reembed` écrit le corpus dans l'espace actif.
 */
export interface LlmProvider {
  /** Appel chat avec sortie JSON validée par schéma Zod (+ 1 retry de correction). */
  chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>>;
  /** Embedding d'un texte (Float32 L2-normalisé côté codec). */
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