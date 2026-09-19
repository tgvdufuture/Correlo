import { getConfig } from "@/lib/config/env";
import type { LlmProvider } from "@/lib/llm/types";
import { GroqProvider } from "@/lib/llm/groq";
import { OllamaChatProvider } from "@/lib/llm/ollama-chat";
import { OllamaProvider } from "@/lib/llm/ollama";
import { HybridProvider } from "@/lib/llm/hybrid";
import { ApiEmbedProvider } from "@/lib/llm/api-embed";
import { getEmbeddingSpace } from "@/lib/llm/active-space";
import type { EmbeddingSpace } from "@/lib/llm/embedding-space";

export { getEmbeddingSpace };

/** Provider composé : chat = LLM_CHAT_PROVIDER (groq|ollama), embed = EMBED_PROVIDER. */
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
  // Le connecteur d'embeddings est un choix de service, pas un fallback : Ollama
  // local ou endpoint OpenAI-compatible. Les vecteurs des deux ne sont pas
  // comparables — l'app refuse de les mélanger plutôt que de deviner.
  const embedProvider =
    c.EMBED_PROVIDER === "api"
      ? new ApiEmbedProvider({
          apiKey: c.NVIDIA_API_KEY,
          model: c.NVIDIA_EMBED_MODEL,
          baseUrl: c.NVIDIA_BASE_URL,
          inputType: c.NVIDIA_EMBED_INPUT_TYPE === "off" ? undefined : c.NVIDIA_EMBED_INPUT_TYPE,
          timeoutMs: c.NVIDIA_EMBED_TIMEOUT_SECONDS * 1000,
          label: chatEndpointLabel(c.NVIDIA_BASE_URL),
        })
      : new OllamaProvider({
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

/** Métadonnées d'embedding persistées sur chaque fragment (espace actif). */
export function embeddingMeta(): EmbeddingSpace {
  return getEmbeddingSpace();
}