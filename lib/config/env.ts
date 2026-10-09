import { z } from "zod";

/**
 * Validation des variables d'environnement (PRD §10).
 * GROQ_API_KEY requise seulement si LLM_CHAT_PROVIDER=groq ;
 * OLLAMA_CHAT_MODEL requis seulement si LLM_CHAT_PROVIDER=ollama.
 */
const envSchema = z
  .object({
    DATABASE_PATH: z.string().min(1).default("./data/correlo.db"),
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
    /**
     * Découverte automatique après dépôt d'un fichier (canvas-atelier) :
     * l'ingestion réussie met en file un run `discover` **focalisé** sur le fichier
     * déposé. `off` rend le comportement d'avant (run déclenché à la main).
     */
    AUTO_DISCOVER: z.enum(["on", "off"]).default("on"),
    /** Plafond de paires d'un run automatique (le corpus entier coûte des heures). */
    AUTO_DISCOVER_MAX_PAIRS: z.coerce.number().int().positive().default(12),
    AUTO_DISCOVER_MAX_PAIRS_PER_SOURCE: z.coerce.number().int().positive().default(12),
    AUTO_DISCOVER_BATCH_SIZE: z.coerce.number().int().positive().default(4),
    AUTO_DISCOVER_MAX_FRAGMENT_CHARS: z.coerce.number().int().positive().default(2400),
    /**
     * Pause entre deux batchs du run automatique (fenêtre de quota du provider).
     * Mesuré sur le free tier : une pause nulle provoque des 429 en rafale ; 65 s
     * est la valeur des runs manuels, à baisser seulement si le quota le permet.
     */
    AUTO_DISCOVER_INTER_BATCH_DELAY_MS: z.coerce.number().int().nonnegative().default(65_000),
    /**
     * Étapes **internes** d'un tour de conversation (Phase 6). Un tour fait au plus cet
     * nombre d'appels LLM, un par étape ; le service plafonne de toute façon dur à 5
     * (`CONVERSATION_STEP_BUDGET`, AC5′), donc une valeur plus grande n'a pas d'effet —
     * elle est lue ici pour que le réglage soit visible là où les autres le sont.
     */
    CONVERSATION_MAX_STEPS: z.coerce.number().int().positive().default(5),
    /**
     * Accès web d'un tour de conversation (amendement v1.3 §13.4).
     *
     * `on` ne suffit **pas** : les outils web sont exposés au modèle seulement si le
     * serveur **constate** que le catalogue ne porte pas `WEB_UNLOCK_MIN_EVIDENCE`
     * fragments utilisables issus d'au moins deux sources. `off` les retire quel que soit
     * le constat (AC2′c).
     */
    WEB_ACCESS: z.enum(["on", "off"]).default("on"),
    /**
     * Étape web d'un tour : au plus `WEB_MAX_STEPS` (recherche comprise), en **plus** des
     * `CONVERSATION_MAX_STEPS` étapes internes (AC5′). Le service plafonne dur à 3
     * (`WEB_STEP_BUDGET`), donc une valeur plus grande n'a pas d'effet — elle est lue ici
     * pour que le réglage soit visible là où les autres le sont.
     */
    WEB_MAX_STEPS: z.coerce.number().int().positive().default(3),
    /** Fragments utilisables en deçà desquels le web est exposé (défaut 2). */
    WEB_UNLOCK_MIN_EVIDENCE: z.coerce.number().int().positive().default(2),
    /**
     * Connecteur de recherche. `none` (défaut) ⇒ **les outils web n'existent pas**, et la
     * Phase 6 reste complète et hors ligne. Aucun fallback : la maison n'a jamais de chemin
     * de repli implicite.
     */
    SEARCH_PROVIDER: z.enum(["exa", "none"]).default("none"),
    /** Clé du connecteur `exa` (requise dès que `SEARCH_PROVIDER=exa`). */
    EXA_API_KEY: z.string().optional(),
    /** Résultats rendus par une recherche web (borne le prompt et le coût). */
    WEB_SEARCH_RESULTS: z.coerce.number().int().positive().max(10).default(5),
    /**
     * Racine du **workspace** (Phase 6, AC3) : le dossier local que l'agent a le droit de
     * lire, en lecture seule.
     *
     * Vide ⇒ **l'outil n'existe pas** dans la liste exposée au modèle — c'est la même façon
     * de rendre une contrainte vraie par construction que le web sans connecteur. Ce n'est
     * pas une erreur à l'exécution : c'est le défaut, et une Phase 6 complète sans lui.
     *
     * Le réglage désigne une racine, jamais un dossier choisi par l'écran : un sélecteur de
     * dossier serait un écran de réglages, hors AC3 (§13.5).
     */
    WORKSPACE_ROOT: z.string().optional(),
    OLLAMA_BASE_URL: z.string().min(1).default("http://localhost:11434"),
    OLLAMA_EMBED_MODEL: z.string().min(1).default("nomic-embed-text"),
    OLLAMA_CHAT_MODEL: z.string().optional(),
    /**
     * Connecteur d'embeddings : `ollama` (local, 768 dims) ou `api` (endpoint
     * OpenAI-compatible `POST /embeddings`).
     *
     * C'est un réglage **du corpus**, pas seulement du code : un vecteur n'a de sens
     * que dans l'espace qui l'a produit. Changer ce réglage sans re-vectoriser laisse
     * deux espaces incomparables en base — `npm run reembed` remet le corpus dans
     * l'espace actif, dans les deux sens.
     */
    EMBED_PROVIDER: z.enum(["ollama", "api"]).default("ollama"),
    /** Endpoint d'embeddings OpenAI-compatible (NVIDIA NIM par défaut). */
    NVIDIA_BASE_URL: z.string().url().default("https://integrate.api.nvidia.com/v1"),
    NVIDIA_API_KEY: z.string().optional(),
    NVIDIA_EMBED_MODEL: z.string().min(1).default("nvidia/nemotron-3-embed-1b"),
    /**
     * Dimensions **rendues par le modèle**, pas une cible : NVIDIA refuse toute autre
     * valeur que celle du modèle (`400 dimensions must be one of 2048`). Sert à
     * contrôler la réponse (un vecteur d'une autre longueur est refusé avant encodage).
     */
    NVIDIA_EMBED_DIMENSIONS: z.coerce.number().int().positive().default(2048),
    /** `passage` pour un document indexé, `query` pour une requête, `off` = champ omis. */
    NVIDIA_EMBED_INPUT_TYPE: z.enum(["passage", "query", "off"]).default("passage"),
    /** Textes par appel d'embeddings (mesuré : 32 en 2,7 s sur NVIDIA NIM). */
    NVIDIA_EMBED_BATCH_SIZE: z.coerce.number().int().positive().default(32),
    NVIDIA_EMBED_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_CHAT_PROVIDER === "ollama" && !env.OLLAMA_CHAT_MODEL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OLLAMA_CHAT_MODEL"],
        message: "OLLAMA_CHAT_MODEL est requis quand LLM_CHAT_PROVIDER=ollama",
      });
    }
    // Connecteur web déclaré sans clé : échouer au boot plutôt qu'au milieu d'un tour de
    // conversation, où le refus arriverait après que l'utilisateur a attendu son tour.
    if (env.SEARCH_PROVIDER === "exa" && !env.EXA_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EXA_API_KEY"],
        message: "EXA_API_KEY est requis quand SEARCH_PROVIDER=exa",
      });
    }
    // Clé absente sur le service NVIDIA (qui l'exige) : échouer au boot plutôt qu'au
    // premier lot d'embeddings, où le message arriverait au milieu d'une ingestion.
    if (env.EMBED_PROVIDER === "api" && env.NVIDIA_BASE_URL.includes("integrate.api.nvidia.com") && !env.NVIDIA_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NVIDIA_API_KEY"],
        message: "NVIDIA_API_KEY est requis quand EMBED_PROVIDER=api sur integrate.api.nvidia.com",
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