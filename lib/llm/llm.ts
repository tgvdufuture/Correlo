import { getConfig } from "@/lib/config/env";
import type { LlmProvider } from "@/lib/llm/types";
import { GroqProvider } from "@/lib/llm/groq";
import { OllamaChatProvider } from "@/lib/llm/ollama-chat";
import { OllamaProvider } from "@/lib/llm/ollama";
import { HybridProvider } from "@/lib/llm/hybrid";
import { EMBEDDING_VERSION } from "@/lib/llm/embedding-codec";

export const EMBEDDING_MODEL_ENV = "OLLAMA_EMBED_MODEL";

/** Provider composé : chat = LLM_CHAT_PROVIDER (groq|ollama), embed = Ollama. */
export function getLlm(): LlmProvider {
  const c = getConfig();
  const chatProvider =
    c.LLM_CHAT_PROVIDER === "ollama"
      ? new OllamaChatProvider({ baseUrl: c.OLLAMA_BASE_URL, model: c.OLLAMA_CHAT_MODEL as string })
      :        new GroqProvider({
          apiKey: c.GROQ_API_KEY,
          model: c.GROQ_CHAT_MODEL,
          maxTokens: c.GROQ_MAX_TOKENS,
          reasoningEffort: c.GROQ_REASONING_EFFORT,
          timeoutMs: c.GROQ_CHAT_TIMEOUT_SECONDS
            ? c.GROQ_CHAT_TIMEOUT_SECONDS * 1000
            : undefined,
          baseUrl: c.GROQ_BASE_URL,
          label: chatEndpointLabel(c.GROQ_BASE_URL),
        });
  const embedProvider = new OllamaProvider({
    baseUrl: c.OLLAMA_BASE_URL,
    model: c.OLLAMA_EMBED_MODEL,
  });
  return new HybridProvider(chatProvider, embedProvider);
}

/** Nom du modèle de chat actif (idempotency + métadonnées). */
export function getChatModelName(): string {
  const c = getConfig();
  return c.LLM_CHAT_PROVIDER === "ollama" ? (c.OLLAMA_CHAT_MODEL as string) : c.GROQ_CHAT_MODEL;
}

/**
 * Signature du réglage du chat : modèle **et** paramètres qui changent la réponse
 * à prompt identique (effort de raisonnement, plafond de sortie).
 *
 * Elle entre dans la clé du cache de prompt. Sans elle, activer `reasoning_effort`
 * laisse le cache rejouer les réponses produites sans raisonnement — le défaut
 * réapparaît à l'identique et le correctif semble sans effet (observé).
 */
export function getChatSignature(): string {
  const c = getConfig();
  if (c.LLM_CHAT_PROVIDER === "ollama") return `ollama:${c.OLLAMA_CHAT_MODEL}`;
  return [
    `groq:${c.GROQ_CHAT_MODEL}`,
    `reasoning=${c.GROQ_REASONING_EFFORT ?? "none"}`,
    `max_tokens=${c.GROQ_MAX_TOKENS ?? "default"}`,
  ].join("|");
}

/** Étiquette du provider chat (logs/erreurs) : « Groq » ou le host de l'endpoint configuré. */
function chatEndpointLabel(baseUrl: string): string {
  if (baseUrl.includes("api.groq.com")) return "Groq";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Clé absente alors que le provider chat est groq ⇒ résumé failed structuré (US-10 AC3).
 * Un endpoint anonyme (ex. OVHcloud AI Endpoints) n'exige pas de clé : pas d'échec.
 */
export function isGroqKeyMissing(): boolean {
  const c = getConfig();
  return c.LLM_CHAT_PROVIDER === "groq" && !c.GROQ_API_KEY && c.GROQ_BASE_URL.includes("api.groq.com");
}

/** Métadonnées d'embedding persistées sur chaque fragment. */
export function embeddingMeta() {
  const c = getConfig();
  return {
    model: c.OLLAMA_EMBED_MODEL,
    dimensions: 768,
    version: EMBEDDING_VERSION,
  };
}