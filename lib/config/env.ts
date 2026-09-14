import { z } from "zod";

/**
 * Validation des variables d'environnement (PRD §10).
 * GROQ_API_KEY requise seulement si LLM_CHAT_PROVIDER=groq ;
 * OLLAMA_CHAT_MODEL requis seulement si LLM_CHAT_PROVIDER=ollama.
 */
const envSchema = z
  .object({
    DATABASE_PATH: z.string().min(1).default("./data/serendipity.db"),
    LLM_CHAT_PROVIDER: z.enum(["groq", "ollama"]).default("groq"),
    GROQ_API_KEY: z.string().optional(),
    /** Endpoint chat OpenAI-compatible (Groq par défaut ; tout serveur compatible accepté). */
    GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
    GROQ_CHAT_MODEL: z.string().min(1).default("qwen/qwen3.8-27b"),
    /**
     * Plafond de sortie explicite. Indispensable sur le free tier Groq : sans lui, la
     * sortie max du modèle est réservée contre la fenêtre TPM (8 000/min), ce qui
     * provoque des 429 en rafale et des appels 7× plus lents.
     */
    GROQ_MAX_TOKENS: z.coerce.number().int().positive().optional(),
    /**
     * Effort de raisonnement demandé au modèle (Groq : `reasoning_effort`).
     *
     * Indispensable pour un modèle de raisonnement : sans ce champ, `qwen/qwen3.8-27b`
     * répond en **6 tokens** et renvoie le JSON le plus court possible ({skip:true})
     * sans jamais lire les preuves — mesuré sur le corpus réel (10 thèmes → 10 skips).
     * Avec `low`, la même requête produit ~1 000 tokens de raisonnement.
     * Absent = comportement du serveur (aucun champ envoyé) ; les endpoints qui ne
     * connaissent pas le paramètre ne le reçoivent donc jamais.
     */
    GROQ_REASONING_EFFORT: z.enum(["low", "medium", "high"]).optional(),
    /**
     * Timeout d'un échange chat (secondes). Un modèle qui raisonne avant de
     * répondre dépasse facilement 120 s : un timeout trop court tue le batch et
     * consomme les attempts du job (observé : 5 timeouts → job failed).
     */
    GROQ_CHAT_TIMEOUT_SECONDS: z.coerce.number().int().positive().optional(),
    OLLAMA_BASE_URL: z.string().min(1).default("http://localhost:11434"),
    OLLAMA_EMBED_MODEL: z.string().min(1).default("nomic-embed-text"),
    OLLAMA_CHAT_MODEL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_CHAT_PROVIDER === "ollama" && !env.OLLAMA_CHAT_MODEL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OLLAMA_CHAT_MODEL"],
        message: "OLLAMA_CHAT_MODEL est requis quand LLM_CHAT_PROVIDER=ollama",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getConfig(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => `  - ${i.path.join(".") || "(racine)"}: ${i.message}`)
        .join("\n");
      throw new Error(`Configuration invalide (.env.local) :\n${details}`);
    }
    cached = parsed.data;
  }
  return cached;
}