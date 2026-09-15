import type { z } from "zod";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";
import { chatWithJsonCorrection } from "@/lib/llm/chat";
import {
  LlmAuthError,
  LlmError,
  LlmJsonModeError,
  LlmNetworkError,
  LlmOutputError,
  LlmRateLimitError,
  LlmTransientError,
} from "@/lib/llm/errors";

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
      /**
       * Effort de raisonnement (Groq/OpenAI : `reasoning_effort`). Absent ⇒ aucun
       * champ envoyé. Un modèle de raisonnement à qui on ne le demande pas ne
       * raisonne pas : il renvoie la sortie la plus courte possible (mesuré : 6
       * tokens, JSON `{skip:true}` sans lecture des preuves).
       */
      reasoningEffort?: "low" | "medium" | "high";
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
    const request = async (
      msgs: ChatMessage[],
      maxTokens?: number,
      jsonMode = true
    ): Promise<Completion> => {
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
            // repli sans mode JSON : le texte est alors nettoyé par chatWithJsonCorrection
            ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
            ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
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
          const body = await res.text();
          // modèle + endpoint dans l'erreur : un 404 vient presque toujours d'un id de modèle inconnu
          const detail = body.replace(/\s+/g, " ").slice(0, 200);
          // mode JSON refusé par le provider (génération vide) : erreur distincte, pour que
          // l'appelant rejoue SANS `response_format` au lieu de brûler les attempts du job
          if (jsonMode && /json_validate_failed|failed_generation/.test(body)) {
            throw new LlmJsonModeError(
              `${this.label} a refusé la génération JSON [modèle « ${this.opts.model} »] : ${detail}`
            );
          }
          // incident passager du provider (502/503 « Service temporarily overloaded »,
          // 504, 408) : réessayable au niveau de l'appel, contrairement à un 404 de
          // modèle inconnu ou à un 400 de requête mal formée (cf. LlmTransientError)
          if (res.status >= 500 || res.status === 408) {
            throw new LlmTransientError(
              `${this.label} HTTP ${res.status} [modèle « ${this.opts.model} » sur ${this.baseUrl}] : ${detail}`
            );
          }
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
          // timeout : le provider a répondu trop lentement (constaté : latences 25–250 s
          // et jusqu'à > 300 s sur un provider gratuit saturé) — passager par nature
          throw new LlmTransientError(`${this.label} ne répond pas (timeout ${this.timeoutMs / 1000}s)`);
        }
        // la cause (ECONNRESET, UND_ERR_*, …) est indispensable au diagnostic :
        // « fetch failed » seul ne dit pas si c'est un DNS, un reset ou un timeout
        // connexion coupée en cours d'échange (reset, socket, DNS temporairement
        // indisponible) : passager ; un hôte inexistant ou un service éteint
        // (ENOTFOUND, ECONNREFUSED) reste une erreur franche, visible tout de suite
        const causeCode = (e as { cause?: { code?: string } }).cause?.code ?? "";
        const message = `${this.label} injoignable : ${(e as Error).message}${causeSuffix(e)}`;
        throw (TRANSIENT_CAUSE_CODES.has(causeCode)
          ? new LlmTransientError(message)
          : new LlmNetworkError(message));
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
    /** Un essai complet : budget nominal, puis budget doublé si la sortie est tronquée. */
    const attempt = async (msgs: ChatMessage[], jsonMode: boolean): Promise<string> => {
      const first = await request(msgs, this.opts.maxTokens, jsonMode);
      // `finish_reason: length` = sortie coupée par le budget : un modèle qui raisonne
      // consomme ses tokens avant d'écrire le JSON. On rejoue une fois avec un budget
      // doublé (borné) plutôt que de perdre le batch ; si c'est encore tronqué, le
      // retry de correction de chatWithJsonCorrection demandera un JSON direct.
      if (first.truncated && this.opts.maxTokens) {
        const bigger = Math.min(this.opts.maxTokens * 2, MAX_TOKENS_CEILING);
        if (bigger > this.opts.maxTokens) {
          const retry = await request(msgs, bigger, jsonMode);
          if (!retry.truncated) return retry.content;
        }
      }
      return first.content;
    };

    const call = async (msgs: ChatMessage[]): Promise<string> => {
      try {
        return await attempt(msgs, true);
      } catch (e) {
        if (!(e instanceof LlmJsonModeError)) throw e;
        // Le mode JSON a été refusé (génération vide) : on rejoue SANS `response_format`.
        // Le prompt exige déjà du JSON ; `chatWithJsonCorrection` sait extraire un objet
        // noyé dans de la prose et corrige une sortie invalide. Sans ce repli, un prompt
        // déterministe en échec faisait tomber tout le run (5 attempts consommés).
        return await attempt(msgs, false);
      }
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

/**
 * Codes de cause d'une erreur `fetch` qui signalent une coupure **passagère** de la
 * connexion. `ENOTFOUND` (nom d'hôte inexistant) et `ECONNREFUSED` (service éteint) en
 * sont volontairement absents : ce sont des erreurs de configuration, qu'il vaut mieux
 * voir tout de suite plutôt que de les réessayer cinq fois.
 */
const TRANSIENT_CAUSE_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Cause racine d'une erreur fetch (code undici / errno), pour le diagnostic. */
function causeSuffix(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  if (!cause) return "";
  return ` (cause : ${cause.code ?? cause.message ?? "inconnue"})`;
}
