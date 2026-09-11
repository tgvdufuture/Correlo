import type { z } from "zod";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";
import { chatWithJsonCorrection } from "@/lib/llm/chat";
import { LlmAuthError, LlmError, LlmNetworkError, LlmOutputError, LlmRateLimitError } from "@/lib/llm/errors";

/** Endpoint par défaut : API Groq (OpenAI-compatible). */
export const DEFAULT_CHAT_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Client chat OpenAI-compatible (Groq par défaut ; l'endpoint est configurable via
 * GROQ_BASE_URL pour un serveur compatible : OVHcloud AI Endpoints, vLLM, LM Studio…).
 * JSON mode + validation Zod + 1 retry de correction. PRD : pas de fallback automatique.
 *
 * Un endpoint anonyme (ex. OVHcloud, sans clé) refuse l'en-tête Authorization :
 * il n'est donc envoyé que si une clé est configurée.
 */
export class GroqProvider implements LlmProvider {
  private readonly baseUrl: string;
  private readonly label: string;

  private readonly timeoutMs: number;

  constructor(
    private opts: {
      apiKey?: string;
      model: string;
      maxTokens?: number;
      baseUrl?: string;
      label?: string;
      timeoutMs?: number;
    }
  ) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CHAT_BASE_URL).replace(/\/+$/, "");
    this.label = opts.label ?? "Groq";
    this.timeoutMs = opts.timeoutMs ?? CHAT_TIMEOUT_MS;
  }

  async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    const request = async (msgs: ChatMessage[], maxTokens?: number): Promise<Completion> => {
      // un seul signal couvre fetch + lecture du corps (res.json()) :
      // un LLM muet ne doit jamais laisser un job running à vie
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res: Response;
      let data: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] };
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // endpoint anonyme : aucun en-tête Authorization (sinon 403)
            ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.opts.model,
            messages: msgs,
            temperature: 0,
            response_format: { type: "json_object" },
            // borne la réservation TPM du free tier et accélère nettement la réponse
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
          }),
          signal: ctrl.signal,
        });
        if (res.status === 401 || res.status === 403) {
          // le corps dit *pourquoi* (clé absente, en-tête refusé…) : indispensable au diagnostic
          const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
          throw new LlmAuthError(
            `${this.label} ${res.status}: authentification refusée — ${detail}`
          );
        }
        if (res.status === 429) {
          const raw = res.headers.get("retry-after");
          const seconds = raw ? Number(raw) : 60;
          throw new LlmRateLimitError(Number.isFinite(seconds) && seconds > 0 ? seconds : 60);
        }
        if (!res.ok) {
          // modèle + endpoint dans l'erreur : un 404 vient presque toujours d'un id de modèle inconnu
          const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
          throw new LlmNetworkError(
            `${this.label} HTTP ${res.status} [modèle « ${this.opts.model} » sur ${this.baseUrl}] : ${detail}`
          );
        }
        data = (await res.json()) as {
          choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
        };
      } catch (e) {
        if (e instanceof LlmError) throw e;
        if ((e as Error).name === "AbortError") {
          throw new LlmNetworkError(`${this.label} ne répond pas (timeout ${this.timeoutMs / 1000}s)`);
        }
        // la cause (ECONNRESET, UND_ERR_*, …) est indispensable au diagnostic :
        // « fetch failed » seul ne dit pas si c'est un DNS, un reset ou un timeout
        throw new LlmNetworkError(
          `${this.label} injoignable : ${(e as Error).message}${causeSuffix(e)}`
        );
      } finally {
        clearTimeout(timer);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new LlmOutputError(`Réponse ${this.label} sans contenu exploitable`);
      }
      return {
        content,
        truncated: data.choices?.[0]?.finish_reason === "length",
      };
    };
    const call = async (msgs: ChatMessage[]): Promise<string> => {
      const first = await request(msgs, this.opts.maxTokens);
      // `finish_reason: length` = sortie coupée par le budget : un modèle qui raisonne
      // consomme ses tokens avant d'écrire le JSON. On rejoue une fois avec un budget
      // doublé (borné) plutôt que de perdre le batch ; si c'est encore tronqué, le
      // retry de correction de chatWithJsonCorrection demandera un JSON direct.
      if (first.truncated && this.opts.maxTokens) {
        const bigger = Math.min(this.opts.maxTokens * 2, MAX_TOKENS_CEILING);
        if (bigger > this.opts.maxTokens) {
          const retry = await request(msgs, bigger);
          if (!retry.truncated) return retry.content;
        }
      }
      return first.content;
    };
    return chatWithJsonCorrection({ call, messages, schema });
  }

  embed(): Promise<number[]> {
    throw new LlmError("no_embeddings", "GroqProvider ne fournit pas d'embeddings (OllamaProvider requis)");
  }
}

interface Completion {
  content: string;
  truncated: boolean;
}

/** Timeout par défaut d'un échange chat (fetch + corps) — surchargeable par env. */
const CHAT_TIMEOUT_MS = 300_000;

/** Plafond du budget de sortie quand on rejoue une réponse tronquée. */
const MAX_TOKENS_CEILING = 8_192;

/** Cause racine d'une erreur fetch (code undici / errno), pour le diagnostic. */
function causeSuffix(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  if (!cause) return "";
  return ` (cause : ${cause.code ?? cause.message ?? "inconnue"})`;
}
