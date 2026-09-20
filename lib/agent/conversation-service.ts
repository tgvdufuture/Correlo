import type { Db } from "@/lib/db/client";
import { sha256Hex } from "@/lib/hash";
import { LlmOutputError } from "@/lib/llm/errors";
import { MAX_PROVIDER_ATTEMPTS, providerRetryDelayMs } from "@/lib/llm/retry";
import { assertSingleEmbeddingSpace } from "@/lib/llm/embedding-space";
import type { LlmProvider, PromptCache } from "@/lib/llm/types";
import { buildCorpusIndex, type CorpusIndex, type IndexedFragment } from "@/lib/agent/retrieval";
import { toCatalogueEntry } from "@/lib/agent/citations";
import { looksStructural } from "@/lib/synth/select";
import { mentionsProtocolReference } from "@/lib/quality/text-rules";
import { WebRefusalError } from "@/lib/agent/web-guard";
import type { WebSearchResult } from "@/lib/agent/web-search";
import type { WebTools } from "@/lib/agent/web-tools";
import type { CatalogueEntry } from "@/lib/agent/types";
import {
  CONVERSATION_PROMPT_VERSION,
  buildConversationPrompt,
} from "@/lib/agent/conversation-prompts";
import {
  CONVERSATION_ACTION_SCHEMA,
  type ConversationActionOutput,
} from "@/lib/agent/conversation-schema";
import {
  CONVERSATION_STEP_BUDGET,
  DEFAULT_HISTORY_MESSAGES,
  MAX_WEB_RESULTS,
  assembleAnswerText,
  stepScope,
  webExcerpt,
  type AnswerRejection,
  type ClaimProvenance,
  type ConversationClaim,
  type ConversationStatus,
  type ConversationStep,
  type ConversationTurn,
  type WebResult,
} from "@/lib/agent/conversation-types";
import { DEFAULT_AGENT_CATALOGUE_SIZE, DEFAULT_AGENT_PAGE_SIZE } from "@/lib/agent/types";
import type { ConversationsRepo, MessageRow } from "@/lib/repositories/conversations";
import type { SynthesesRepo } from "@/lib/repositories/syntheses";
import type { FragmentsRepo } from "@/lib/repositories/fragments";
import type { SourcesRepo } from "@/lib/repositories/sources";

/**
 * Phase 6 — un tour de conversation (amendement v1.3 §13).
 *
 * Une seule boucle séquentielle, **un appel LLM par étape**, au plus
 * `CONVERSATION_STEP_BUDGET` étapes **internes** plus — quand le serveur a constaté que le
 * corpus ne suffit pas — au plus `WEB_STEP_BUDGET` étapes **web**. À chaque tour le modèle
 * choisit **une** action ; le serveur l'exécute lui-même, enrichit son catalogue (ou ses
 * résultats web), puis redonne la main. Aucun sous-agent, aucun parallélisme.
 *
 * Trois différences avec l'enquête de la Phase 4, et elles sont de fond :
 *  1. **le serveur assemble la réponse**. Le modèle ne rend pas de prose mais des
 *     affirmations ; `messages.text` est leur concaténation. C'est ce qui rend l'AC1
 *     vérifiable — il n'y a pas de phrase dont la provenance serait à deviner ;
 *  2. **l'historique fait partie du prompt**. Le cache de prompt ne protège donc pas
 *     « la même question posée plus tard » (le contexte a changé, et c'est voulu :
 *     l'utilisateur attend une réponse au contexte d'aujourd'hui), mais le **rejeu du
 *     même tour** — celui d'une reprise après un `503`, ou d'un `POST` rejoué ;
 *  3. **le web est exposé par constat, pas par humeur** (§13.4, ci-dessous).
 *
 * Les citations sont vérifiées **à la lecture**, pas au moment du run : une source
 * supprimée ou ré-ingérée transforme une affirmation sourcée en affirmation non sourcée
 * (`lib/agent/conversation-citations.ts`), jamais en preuve silencieuse.
 */

export interface ConversationRunOptions {
  /** Identifiant du message de réponse — c'est celui du **job** (`jobs.id`). */
  messageId: string;
  /**
   * Message de l'utilisateur qui a déclenché le tour. Sert à deux choses : délimiter
   * l'historique (tout ce qui précède) et rendre le tour idempotent par question.
   */
  questionMessageId: string;
  /** La question, telle que l'utilisateur l'a écrite. */
  question: string;
  /** Plafond d'actions **internes** demandé ; plafonné dur à CONVERSATION_STEP_BUDGET. */
  maxSteps?: number;
  /** Fragments ajoutés au catalogue par action d'exploration. */
  pageSize?: number;
  /** Taille maximale du catalogue (borne le prompt et le document persisté). */
  catalogueSize?: number;
  /** Troncature des fragments **dans le prompt** (la copie persistée reste intégrale). */
  maxFragmentChars?: number;
  /** Tours précédents réinjectés dans le prompt. */
  historyMessages?: number;
  /** Cache de prompt (worker) ou en mémoire (tests) — surchargeable par tour. */
  promptCache?: PromptCache;
  onProgress?: (info: {
    step: number;
    budget: number;
    status: ConversationStatus;
    llmCalls: number;
    stepsFromCache: number;
  }) => void;
}

export interface ConversationRunResult {
  messageId: string;
  status: ConversationStatus;
  steps: number;
  /** Étapes internes et web consommées (AC5′). */
  internalSteps: number;
  webSteps: number;
  /** Le web a-t-il été exposé à ce tour (et pourquoi) ? */
  webUnlocked: boolean;
  webUnlockReason?: string;
  llmCalls: number;
  llmCallsFromCache: number;
  /** Affirmations retenues (0 si le tour n'a pas répondu). */
  claims: number;
  /** Affirmations sans preuve — comptées, jamais présentées comme un fait. */
  unsourced: number;
  failure?: string;
}

/**
 * État web **d'un tour**. Il vit à côté du document (pas dedans) : `web_results` est
 * partagé de toute façon (le tableau du document est muté en place), et les compteurs de
 * budget ont besoin d'être lus et écrits à chaque étape.
 */
interface WebRuntime {
  tools: WebTools | null;
  unlocked: boolean;
  reason: string;
  budget: number;
  used: number;
  /** `search_web` est limité à **1 par tour** (§13.4). */
  searched: boolean;
  results: WebResult[];
  /** Horloge injectable (dates de recherche et de lecture) — les tests n'attendent pas. */
  now: () => Date;
}

export class ConversationService {
  constructor(
    private deps: {
      db: Db;
      conversations: ConversationsRepo;
      syntheses: SynthesesRepo;
      fragments: FragmentsRepo;
      sources: SourcesRepo;
      chat: LlmProvider;
      chatModel: string;
      /** Signature du **réglage** du chat (modèle + effort + budget) — entre dans la clé de cache. */
      chatSignature?: string;
      promptCache?: PromptCache;
      /** Index du corpus déjà construit (tests) — sinon il est construit par le run. */
      index?: CorpusIndex;
      /**
       * Outils web (§13.4). Absents ⇒ le tour est **entièrement hors ligne** : c'est le
       * défaut, et un tour sans web est complet (AC5′ : 0 étape web).
       */
      web?: WebTools;
      /** Horloge injectable (dates de lecture web) — surchargeable par les tests. */
      now?: () => Date;
    }
  ) {}

  async run(conversationId: string, opts: ConversationRunOptions): Promise<ConversationRunResult> {
    const conversation = this.deps.conversations.getById(conversationId);
    if (!conversation) {
      // rien à écrire : on n'enfile pas un tour pour une conversation inexistante
      throw new Error(`conversation : conversation introuvable (${conversationId})`);
    }
    // Invariant de la maison : on ne compare que des vecteurs du même espace. Ici le
    // risque est réel — `dotProduct` lit `dims` valeurs, donc un corpus mixte produirait
    // des voisinages faux mais plausibles.
    assertSingleEmbeddingSpace(this.deps.db, [], `conversation ${opts.messageId}`);
    const index = this.deps.index ?? buildCorpusIndex(this.deps.db);

    const budget = Math.min(opts.maxSteps ?? CONVERSATION_STEP_BUDGET, CONVERSATION_STEP_BUDGET);
    const pageSize = opts.pageSize ?? DEFAULT_AGENT_PAGE_SIZE;
    const catalogueSize = opts.catalogueSize ?? DEFAULT_AGENT_CATALOGUE_SIZE;

    const tools = this.deps.web ?? null;
    const minEvidence = tools?.unlockMinEvidence ?? 2;
    const web: WebRuntime = {
      tools: tools?.enabled ? tools : null,
      unlocked: false,
      // état initial : ni exposé ni écarté — le constat n'a pas encore été fait
      reason: tools?.enabled ? "constat_en_attente" : (tools?.disabledReason ?? "connecteur_absent"),
      budget: tools?.enabled ? tools.maxSteps : 0,
      used: 0,
      searched: false,
      results: [],
      now: this.deps.now ?? (() => new Date()),
    };

    const history = this.loadHistory(conversationId, opts);
    const seed = this.seedCatalogue(conversation.anchor_kind, conversation.anchor_ref);
    const doc: ConversationTurn = {
      prompt_version: CONVERSATION_PROMPT_VERSION,
      chat_model: this.deps.chatModel,
      step_budget: budget,
      web_budget: web.budget,
      llm_calls: 0,
      steps_from_cache: 0,
      history_messages: history.length,
      internal_steps: 0,
      web_steps: 0,
      web_unlocked: false,
      web_unlock_min_evidence: minEvidence,
      web_unlock_reason: web.reason,
      web_results: web.results,
      catalogue: seed.entries,
      steps: [],
      claims: [],
      unsourced: 0,
      anchor_missing: seed.anchorMissing || undefined,
    };
    const persist = (status: ConversationStatus): void => {
      doc.internal_steps = charged(doc.steps, "internal");
      doc.web_steps = charged(doc.steps, "web");
      doc.web_unlocked = web.unlocked;
      doc.web_unlock_reason = web.reason;
      this.deps.conversations.upsertAssistantMessage({
        id: opts.messageId,
        conversationId,
        status,
        // le texte affiché **est** l'union des affirmations : jamais la prose du modèle
        text: assembleAnswerText(doc.claims),
        claims: doc.claims,
        turn: doc,
      });
    };
    // la ligne existe **avant** le premier appel LLM : une panne du provider laisse un
    // tour consultable (avec son statut) au lieu d'un trou dans la conversation
    persist("pending");

    let status: ConversationStatus = "pending";
    // Dernier refus **récupérable** : s'il n'y a pas de réponse valide à la fin du budget,
    // c'est cette raison-là qui décrit le tour — « budget épuisé » serait vrai mais ne
    // dirait rien de ce qui a été refusé.
    let lastRefusal: AnswerRejection | undefined;
    const promptCache = opts.promptCache ?? this.deps.promptCache;
    // Une exploration est plafonnée à `budget − 1` : la réponse est une étape interne comme
    // une autre, et il faut lui laisser sa place. Sans cette réserve, un modèle qui explore
    // cinq fois n'a plus de tour pour répondre et le tour échoue alors qu'il avait de quoi
    // répondre — le défaut que la Phase 4 avait déjà mesuré (le modèle conclut ou explore
    // jusqu'à épuisement). L'AC5′ reste tenu à la lettre : `internal_steps ≤ step_budget`.
    const explorationBudget = Math.max(1, budget - 1);
    // la boucle est bornée par la somme des deux budgets : une action interne alors que le
    // budget interne est épuisé ne peut donc pas faire tourner le tour indéfiniment
    const maxIterations = budget + web.budget;

    for (let stepIndex = 1; stepIndex <= maxIterations && status === "pending"; stepIndex++) {
      const internalUsed = charged(doc.steps, "internal");
      const webUsed = charged(doc.steps, "web");
      // une seule source de vérité : le compteur web est **dérivé** des étapes facturées,
      // jamais incrémenté à la main (sinon un chemin d'erreur peut oublier de le faire, et
      // le budget web ne borne plus rien — ce que le test « trois lectures » a attrapé)
      web.used = webUsed;
      if (internalUsed >= budget && webUsed >= web.budget) break;

      const messages = buildConversationPrompt(
        {
          question: opts.question,
          anchor: {
            kind: conversation.anchor_kind,
            synthesisText: seed.synthesisText,
            synthesisStale: seed.synthesisStale,
          },
          history,
          catalogue: doc.catalogue,
          steps: doc.steps,
          stepBudget: budget,
          web: {
            enabled: web.tools !== null,
            unlocked: web.unlocked,
            reason: web.reason,
            budget: web.budget,
            used: webUsed,
            minEvidence,
            results: web.results,
          },
        },
        { maxFragmentChars: opts.maxFragmentChars }
      );
      const cacheKey = sha256Hex(
        JSON.stringify([
          this.deps.chatSignature ?? this.deps.chatModel,
          CONVERSATION_PROMPT_VERSION,
          messages,
        ])
      );
      const cached = promptCache?.get(cacheKey);
      let action: ConversationActionOutput;
      if (cached !== undefined) {
        // rejeu du même tour (reprise, `POST` rejoué) : le prompt est identique, donc la
        // réponse enregistrée est la bonne — le modèle n'est pas rappelé
        action = cached as ConversationActionOutput;
        doc.steps_from_cache += 1;
      } else {
        try {
          action = await this.callChat(messages);
          doc.llm_calls += 1;
          promptCache?.set(cacheKey, action);
        } catch (e) {
          if (e instanceof LlmOutputError) {
            // sortie inexploitable après le retry de correction : la trace est écrite
            // (étape `invalid`), un échec silencieux serait pire
            doc.steps.push({
              index: stepIndex,
              action: "invalid",
              scope: "internal",
              input: {},
              added: [],
              observation: [],
              failure: "sortie_invalide",
              // rien n'a été exécuté : l'étape est tracée, elle n'est pas facturée
              charged: false,
            });
            status = "failed";
            doc.failure = "sortie_invalide";
            break;
          }
          throw e;
        }
      }

      const known = new Set(doc.catalogue.map((e) => e.fragment_id));
      const outcome = await applyAction(action, {
        index,
        stepIndex,
        pageSize,
        catalogueSize,
        catalogue: doc.catalogue,
        known,
        priorSteps: doc.steps,
        web,
        internalUsed,
        internalBudget: budget,
        explorationBudget,
      });
      doc.steps.push(outcome.step);
      if (outcome.step.action === "answer") {
        if (outcome.claims) {
          doc.claims = outcome.claims;
          // comptage **au moment du tour** : la relecture le recalcule (une preuve peut
          // ne plus tenir), et c'est le verdict de la lecture qui est affiché
          doc.unsourced = outcome.claims.filter((c) => c.provenance.length === 0).length;
          status = "done";
        } else {
          // `??` et non une affectation sèche : une réponse non exécutée (budget interne
          // épuisé) n'a pas de `refused`, et écraserait le dernier refus **récupérable** —
          // le tour finirait par dire « budget épuisé » alors qu'il a été refusé pour une
          // raison précise, qui est justement ce que le motif doit apprendre.
          lastRefusal = outcome.step.refused ?? lastRefusal;
        }
      }
      this.evaluateWebUnlock(doc, web, minEvidence);
      persist(status);
      opts.onProgress?.({
        step: stepIndex,
        budget,
        status,
        llmCalls: doc.llm_calls,
        stepsFromCache: doc.steps_from_cache,
      });
    }

    if (status === "pending") {
      // budget épuisé sans réponse recevable : c'est un échec au sens du protocole, et la
      // trace des actions reste consultable (on ne rend jamais un silence)
      status = "failed";
      doc.failure = lastRefusal ?? "step_budget_exhausted";
      persist(status);
    }

    return {
      messageId: opts.messageId,
      status,
      steps: doc.steps.length,
      internalSteps: doc.internal_steps,
      webSteps: doc.web_steps,
      webUnlocked: doc.web_unlocked,
      webUnlockReason: doc.web_unlock_reason,
      llmCalls: doc.llm_calls,
      llmCallsFromCache: doc.steps_from_cache,
      claims: doc.claims.length,
      unsourced: doc.unsourced,
      failure: doc.failure,
    };
  }

  /**
   * Le déverrouillage du web (§13.4), **évalué par le serveur et une seule fois par tour**.
   *
   * ```
   * fragments utilisables = fragments du catalogue non structurels (looksStructural)
   *                         et appartenant à au moins 2 sources distinctes
   * outils web exposés  ⇔  fragments utilisables < WEB_UNLOCK_MIN_EVIDENCE
   * ```
   *
   * **Quand le constat est fait, et pourquoi ce n'est pas au premier tour de boucle.** Le
   * constat exige qu'une exploration interne ait **abouti** : une question sur le corpus
   * entier démarre avec un catalogue vide, et décider « le corpus ne suffit pas » sur un
   * catalogue vide reviendrait à décider sans avoir rien cherché. Ce modèle prend toujours
   * le chemin le plus court — mesuré en 5A (6 tokens et `{"skip":true}` sans effort de
   * raisonnement) et en Phase 4 (conclusion dès la première étape) : exposé d'entrée, il
   * répondrait **depuis le web** à des questions que le corpus couvre, c'est-à-dire qu'il
   * remplacerait le produit. Une exploration doit donc avoir eu lieu.
   *
   * **Latched, dans le sens qui protège.** Une fois exposés, les outils restent exposés pour
   * le tour (« évaluée une fois par tour ») : l'inverse ferait disparaître un outil du
   * milieu d'un tour, et le modèle paierait un refus pour avoir suivi le prompt précédent.
   * Un constat de suffisance, lui, n'est pas définitif : il est réévalué à chaque étape
   * interne, ce qui permet de basculer si l'exploration ne donne rien.
   */
  private evaluateWebUnlock(doc: ConversationTurn, web: WebRuntime, minEvidence: number): void {
    if (!web.tools || web.unlocked) return;
    const explored = doc.steps.some(
      (s) => (s.action === "search" || s.action === "expand") && !s.failure
    );
    if (!explored) return;
    const usable = usableEvidence(doc.catalogue);
    if (usable < minEvidence) {
      web.unlocked = true;
      web.reason = "corpus_insuffisant";
    } else {
      web.reason = "corpus_suffisant";
    }
  }

  /**
   * Tours précédents, bornés : tout ce qui précède le message déclencheur, les messages
   * aboutis seulement (une réponse en échec ou en attente n'est pas de l'historique), et
   * les `historyMessages` derniers.
   */
  private loadHistory(
    conversationId: string,
    opts: ConversationRunOptions
  ): { role: "user" | "assistant"; text: string }[] {
    const all = this.deps.conversations.listMessages(conversationId);
    const triggerAt = all.findIndex((m) => m.id === opts.questionMessageId);
    const before: MessageRow[] = triggerAt >= 0 ? all.slice(0, triggerAt) : all;
    const limit = opts.historyMessages ?? DEFAULT_HISTORY_MESSAGES;
    return before
      .filter((m) => m.status === "done")
      .slice(-limit)
      .map((m) => ({ role: m.role, text: m.text }));
  }

  /**
   * Catalogue de départ : les preuves **vivantes** de la synthèse ancrée.
   *
   * Ce sont les fragments au moment du tour (`fragments.getById`), pas le
   * `provenance_snapshot` de la synthèse : la copie du catalogue est ce qui sera comparé
   * à la base à la lecture, et comparer une copie plus ancienne ferait échouer une
   * citation sur un fragment qui n'a pas bougé. C'est déjà la règle de la Phase 4.
   *
   * Une synthèse disparue ne casse pas la conversation : l'ancre est un point de départ,
   * pas une condition d'existence (le schéma ne pose pas de FK, précisément pour que la
   * conversation reste lisible). L'absence est **écrite** (`anchor_missing`) et dite au
   * modèle, jamais tue.
   */
  private seedCatalogue(
    anchorKind: "synthesis" | "corpus",
    anchorRef: string | null
  ): {
    entries: CatalogueEntry[];
    synthesisText?: string | null;
    synthesisStale?: boolean;
    anchorMissing: boolean;
  } {
    if (anchorKind !== "synthesis" || !anchorRef) {
      return { entries: [], anchorMissing: false };
    }
    const synthesis = this.deps.syntheses.getById(anchorRef);
    if (!synthesis) {
      return { entries: [], anchorMissing: true };
    }
    const entries: CatalogueEntry[] = [];
    let evidenceIds: string[] = [];
    try {
      const parsed = JSON.parse(synthesis.evidence_fragment_ids) as unknown;
      if (Array.isArray(parsed)) evidenceIds = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      evidenceIds = [];
    }
    for (const id of evidenceIds) {
      const f = this.deps.fragments.getById(id);
      if (!f) continue;
      entries.push(
        toCatalogueEntry(
          {
            id: f.id,
            source_id: f.source_id,
            source_title: this.deps.sources.getById(f.source_id)?.title ?? null,
            chunk_index: f.chunk_index,
            locator: f.locator,
            text: f.text,
          },
          entries.length,
          "seed"
        )
      );
    }
    return {
      entries,
      synthesisText: synthesis.text,
      synthesisStale: synthesis.stale === 1,
      anchorMissing: false,
    };
  }

  /**
   * Un appel chat par étape, avec réessai des incidents **passagers** du provider
   * (429/503/timeout/ECONNRESET, même politique qu'en 2A/4/5A). Une sortie invalide n'est
   * pas un incident passager : elle remonte pour être tracée comme étape `invalid`.
   */
  private async callChat(messages: Parameters<LlmProvider["chat"]>[0]): Promise<ConversationActionOutput> {
    for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        const out = await this.deps.chat.chat(messages, CONVERSATION_ACTION_SCHEMA);
        console.log(`[conversation] action LLM : ${Date.now() - startedAt} ms`);
        return out as ConversationActionOutput;
      } catch (e) {
        const delay = providerRetryDelayMs(e, attempt);
        if (delay === null || attempt === MAX_PROVIDER_ATTEMPTS - 1) throw e;
        console.warn(
          `[conversation] incident provider — tentative ${attempt + 1}/${MAX_PROVIDER_ATTEMPTS} ` +
            `dans ${Math.round(delay / 1000)}s : ${(e as Error).message.slice(0, 140)}`
        );
        await sleep(delay);
      }
    }
    throw new Error("étape de conversation sans résultat après tentatives");
  }
}

/**
 * Fragments **utilisables** d'un catalogue (§13.4) : non structurels (un sommaire n'est pas
 * une preuve — constat 5A, `looksStructural`) et appartenant à au moins **deux sources
 * distinctes** : la transversalité est la valeur du produit, un stock mono-document ne
 * répond pas à la question que la conversation pose.
 */
export function usableEvidence(catalogue: CatalogueEntry[]): number {
  const pool = catalogue.filter((e) => !looksStructural(e.text, e.locator));
  if (new Set(pool.map((e) => e.source_id)).size < 2) return 0;
  return pool.length;
}

/**
 * Exécute une action et renvoie l'étape, plus les affirmations quand la réponse est
 * acceptée.
 *
 * Les refus de réponse sont **récupérables** : ils consomment l'étape, le modèle lit le
 * motif dans la transcription et se reprend dans le budget restant. Un refus non
 * récupérable tuerait le tour au premier essai, ce que le prompt promet de ne pas faire.
 *
 * Six règles, toutes **structurelles** (aucune n'essaie de juger le sens), **les fautes
 * de protocole avant le jugement de contenu** :
 *  1. `reponse_sans_exploration` — répondre sans qu'aucune exploration (`search`/`expand`)
 *     n'ait **abouti dans ce tour**. C'était la règle de la Phase 4
 *     (`conclusion_sans_exploration`) et elle y avait coûté une mesure : le modèle avait
 *     conclu dès la première action, à partir des deux graines ;
 *  2. `reponse_hors_catalogue` — le modèle cite un indice qu'il n'a jamais vu (fragment du
 *     catalogue ou résultat web du tour). Le schéma Zod ne peut pas l'attraper : l'indice
 *     *est* bien un entier. On ne le rabat pas silencieusement en « affirmation non
 *     sourcée » : ce serait cacher une faute de protocole derrière une catégorie prévue
 *     pour autre chose ;
 *  3. `reponse_web_non_lue` — le modèle cite une page qu'il a **trouvée** mais jamais lue.
 *     Seule une lecture (`read_page`) rend une page citable : c'est ce qui garantit que la
 *     copie citée est bien celle qui est passée par le durcissement réseau, et qu'elle est
 *     datée ;
 *  4. `reponse_avec_repere_technique` — la prose parle du protocole (« Le fragment [0]
 *     affirme que… ») au lieu du sujet. `messages.text` **est** le texte des affirmations :
 *     un indice de catalogue dedans n'est pas un détail de style ;
 *  5. `reponse_web_ignoree` — le serveur a **constaté** que le corpus ne suffit pas (donc il
 *     a exposé les outils web) et la réponse arrive **sans une seule étape web**. C'est le
 *     défaut mesuré sur le premier tour web réel (2026-09-20) : outils exposés, question
 *     dont le corpus ne dit rien (« la régulation européenne des batteries lithium » sur un
 *     corpus du xixᵉ), et une réponse de 2 étapes rendue **depuis le corpus seul** — un
 *     constat négatif précis, sourcé sur des fragments hors sujet. Le prompt l'y invitait
 *     même (« un constat négatif précis vaut mieux qu'une généralité »). Exposer un outil
 *     n'est pas le faire employer : il fallait que l'ignorer soit un refus.
 *     Le constat porte sur les **tentatives**, pas sur les succès : une étape web qui a
 *     échoué compte comme une réponse au constat (sinon une recherche sans résultat — ou un
 *     `WEB_MAX_STEPS=0` — condamnerait le tour à échouer) ;
 *  6. `reponse_sans_aucune_preuve` — une ou plusieurs affirmations non sourcées sont
 *     admises (l'AC1 les prévoit et l'écran les nomme), mais une réponse dont **aucune**
 *     affirmation n'est appuyée n'est pas une réponse sourcée. Elle passe **après** la
 *     règle 5 : quand le web est exposé, « tu n'as rien appuyé » et « tu n'es pas sorti »
 *     sont vrais ensemble, et c'est le second motif qui indique quoi faire.
 *
 * **Pourquoi l'exemption de tour ancré a été retirée** — question réelle « Que disent ces
 * documents sur ce qui rend une observation fiable ? », ancrée sur une synthèse : le tour a
 * été répondu en **1 étape** (aucune lecture) à partir des 2 preuves de la synthèse, dont le
 * sujet n'était pas la question. Le modèle a rattaché de force les bûchers et les archives
 * diplomatiques à « ce qui rend l'observation fiable », et le tour suivant (« Et ensuite ? »)
 * a rendu **la même matière** — catalogue inchangé, 2 fragments. L'ancre est un **contexte**,
 * pas une lecture : la règle coûte un appel LLM par tour ancré, et c'est le prix de « l'agent
 * lit le corpus avant de répondre ».
 *
 * Ce qui **n'est pas** repris de la Phase 4 : `judgeConclusion`. Sa barrière juge un
 * énoncé unique de 40–120 mots contre une paire de documents (juxtaposition, reprise de la
 * question) ; une réponse conversationnelle est une suite d'affirmations dont certaines
 * sont légitimement attributives. L'appliquer ici refuserait des réponses correctes pour
 * des raisons qui ne les concernent pas.
 */
/** Ce qu'une action a le droit de lire et d'écrire dans le tour en cours. */
interface ActionContext {
  index: CorpusIndex;
  stepIndex: number;
  pageSize: number;
  catalogueSize: number;
  catalogue: CatalogueEntry[];
  known: Set<string>;
  priorSteps: ConversationStep[];
  web: WebRuntime;
  internalUsed: number;
  internalBudget: number;
  /** Plafond des explorations (`budget − 1`) : la réponse garde sa place. */
  explorationBudget: number;
}

async function applyAction(
  action: ConversationActionOutput,
  ctx: ActionContext
): Promise<{
  step: ConversationStep;
  claims?: ConversationClaim[];
}> {
  const { index, stepIndex, pageSize, catalogueSize, catalogue, known, priorSteps } = ctx;

  if (action.action === "search" || action.action === "expand") {
    if (ctx.internalUsed >= ctx.explorationBudget) {
      // budget interne épuisé : l'action n'est pas exécutée, mais elle ne fait pas non plus
      // boucler le tour (la boucle est bornée par la somme des budgets) — le modèle voit
      // l'échec et répond avec ce qu'il a
      return {
        step: {
          index: stepIndex,
          action: action.action,
          scope: "internal",
          input:
            action.action === "search"
              ? { query: action.query ?? "" }
              : { fragment: action.fragment as number },
          added: [],
          observation: [],
          failure: "budget_interne_epuise",
          charged: false,
        },
      };
    }
    const step: ConversationStep = {
      index: stepIndex,
      action: action.action,
      scope: "internal",
      input:
        action.action === "search"
          ? { query: action.query ?? "" }
          : { fragment: action.fragment as number },
      added: [],
      observation: [],
    };
    let candidates: IndexedFragment[];
    if (action.action === "expand") {
      const base = catalogue.find((e) => e.index === action.fragment);
      if (!base) {
        step.failure = "indice_hors_catalogue";
        step.charged = false;
        return { step };
      }
      candidates = index.neighbours(base.fragment_id, pageSize * 2);
    } else {
      candidates = index.search(action.query ?? "", pageSize * 2);
    }

    const room = Math.max(0, catalogueSize - catalogue.length);
    const quota = Math.min(room, pageSize);
    for (const f of candidates) {
      if (step.added.length >= quota) break;
      if (known.has(f.id)) continue;
      known.add(f.id);
      const entry = toCatalogueEntry(
        {
          id: f.id,
          source_id: f.sourceId,
          source_title: f.sourceTitle,
          chunk_index: f.chunkIndex,
          locator: f.locator,
          text: f.text,
        },
        catalogue.length,
        action.action
      );
      catalogue.push(entry);
      step.added.push(entry.index);
    }
    step.observation = [...step.added];
    return { step };
  }

  if (action.action === "search_web" || action.action === "read_page") {
    return applyWebAction(action, ctx);
  }

  if (action.action === "ask_web") {
    const step: ConversationStep = {
      index: stepIndex,
      action: "ask_web",
      scope: "internal",
      input: { reason: action.reason ?? "" },
      added: [],
      observation: [],
    };
    // Aucun outil à ouvrir : la demande est refusée **avant** toute autre considération,
    // sinon le modèle croirait avoir ouvert un web désactivé et chercherait pourquoi.
    if (!ctx.web.tools) {
      step.failure = "outil_web_indisponible";
      step.charged = false;
      return { step };
    }
    // Déjà exposés : il n'y a rien à demander. Non facturé — le modèle suit un prompt qui
    // a pu vieillir d'une étape, et ce n'est pas une tentative d'aller chercher dehors.
    if (ctx.web.unlocked) {
      step.failure = "web_deja_expose";
      step.charged = false;
      return { step };
    }
    // Le cœur de la règle : on demande le web **après** avoir lu, jamais avant. Sans
    // exploration aboutie, la demande serait le raccourci que les mesures de 5A et de la
    // Phase 4 annoncent (ce modèle prend toujours le chemin le plus court) : le web
    // remplacerait le corpus au lieu de le compléter.
    const explored = ctx.priorSteps.some(
      (s) => (s.action === "search" || s.action === "expand") && !s.failure
    );
    if (!explored) {
      step.failure = "exploration_requise";
      step.charged = false;
      return { step };
    }
    // Même réserve que `search`/`expand` : la réponse garde sa place dans le budget interne.
    if (ctx.internalUsed >= ctx.explorationBudget) {
      step.failure = "budget_interne_epuise";
      step.charged = false;
      return { step };
    }
    // Exécutée : c'est une étape **facturée**, comme une exploration — elle change l'état du
    // tour. Le motif du modèle devient la raison du déverrouillage, et la trace le garde.
    ctx.web.unlocked = true;
    ctx.web.reason = "demande_modele";
    return { step };
  }

  // `answer`
  const step: ConversationStep = {
    index: stepIndex,
    action: "answer",
    scope: "internal",
    input: {},
    added: [],
    observation: [],
  };
  // Garde de budget : en pratique la réserve ci-dessus rend ce cas impossible, mais un
  // tour ne doit pas pouvoir dépasser son plafond par un chemin imprévu
  if (ctx.internalUsed >= ctx.internalBudget) {
    step.failure = "budget_interne_epuise";
    step.charged = false;
    return { step };
  }
  // Règle de run **avant** la règle de citation : quand le catalogue est vide et qu'aucune
  // exploration n'a abouti, toute citation est forcément hors catalogue — et dire au modèle
  // « tu cites un fragment que tu n'as jamais vu » l'enverrait chercher un indice inexistant,
  // alors que le défaut réel est qu'il n'a **rien lu**. Le motif rendu doit être celui qu'il
  // peut corriger dans le budget restant.
  //
  // Aucune exemption d'ancrage : l'ancre fournit un **contexte** (ce que la synthèse affirme,
  // et ses preuves, citables), jamais la lecture du tour — mesure dans l'encadré ci-dessus.
  const explored = priorSteps.some(
    (s) => (s.action === "search" || s.action === "expand") && !s.failure
  );
  if (!explored) {
    step.refused = "reponse_sans_exploration";
    return { step };
  }

  const raw = action.claims ?? [];
  const unknown = [
    ...raw.flatMap((c) => c.citations ?? []).filter((i) => !catalogue.some((e) => e.index === i)),
    ...raw
      .flatMap((c) => c.web ?? [])
      .filter((i) => !ctx.web.results.some((r) => r.index === i)),
  ];
  if (unknown.length > 0) {
    step.refused = "reponse_hors_catalogue";
    return { step };
  }

  const unread = raw
    .flatMap((c) => c.web ?? [])
    .filter((i) => !ctx.web.results.find((r) => r.index === i)?.read);
  if (unread.length > 0) {
    step.refused = "reponse_web_non_lue";
    return { step };
  }

  // la prose parle du protocole (« le fragment [0] affirme que… ») : elle est réécrite ou
  // refusée, jamais affichée telle quelle — `messages.text` est l'union de ces textes
  if (raw.some((c) => mentionsProtocolReference(c.text ?? ""))) {
    step.refused = "reponse_avec_repere_technique";
    return { step };
  }

  // Le constat d'insuffisance a exposé les outils web : répondre sans avoir **rien** tenté
  // dehors contredit ce constat. Le défaut est mesuré sur un tour réel (voir la règle 5 de
  // l'encadré ci-dessus) : outils exposés, 0 étape web, réponse rendue depuis le corpus.
  //
  // Ce qui compte est la **tentative**, pas le succès : un `search_web` refusé par le
  // durcissement, ou une recherche sans résultat, a répondu au constat — exiger un succès
  // ferait échouer un tour que le web ne peut pas aider (et `WEB_MAX_STEPS=0` le ferait
  // échouer à coup sûr).
  const webUntouched = !priorSteps.some((s) => s.scope === "web");
  if (ctx.web.unlocked && ctx.web.budget > 0 && webUntouched) {
    step.refused = "reponse_web_ignoree";
    return { step };
  }

  const claims: ConversationClaim[] = raw.map((c) => ({
    text: c.text.trim(),
    provenance: [
      ...(c.citations ?? []).map((i) => {
        const entry = catalogue.find((e) => e.index === i) as CatalogueEntry;
        const provenance: ClaimProvenance = {
          kind: "fragment",
          index: entry.index,
          fragment_id: entry.fragment_id,
          source_id: entry.source_id,
          source_title: entry.source_title,
          locator: entry.locator,
          text: entry.text,
        };
        return provenance;
      }),
      ...(c.web ?? []).map((i) => {
        const result = ctx.web.results.find((r) => r.index === i) as WebResult;
        const provenance: ClaimProvenance = {
          kind: "url",
          index: result.index,
          url: result.url,
          title: result.title,
          // `read` est vrai : la lecture a eu lieu, donc la date et la copie existent
          retrieved_at: result.retrieved_at as string,
          excerpt: webExcerpt(result.text ?? ""),
        };
        return provenance;
      }),
    ],
  }));

  if (claims.every((c) => c.provenance.length === 0)) {
    step.refused = "reponse_sans_aucune_preuve";
    return { step };
  }
  step.observation = claims.flatMap((c) =>
    c.provenance.filter((p) => p.kind === "fragment").map((p) => p.index)
  );
  step.web_observation = claims.flatMap((c) =>
    c.provenance.filter((p) => p.kind === "url").map((p) => p.index)
  );
  return { step, claims };
}

/**
 * Les deux outils web (§13.4), et leurs refus — tous **récupérables**, et tous tracés :
 *
 *  - `outil_web_indisponible` — le web n'est pas exposé (interrupteur, connecteur absent,
 *    ou constat pas encore fait) ;
 *  - `budget_web_epuise` / `recherche_deja_faite` / `page_deja_lue` — demandes hors budget
 *    ou redondantes.
 *
 *  Ces cinq refus sont **non facturés** (`charged: false`) : rien n'a été exécuté. Le
 *  modèle ne peut donc pas se servir d'un outil verrouillé pour « gagner » des étapes, et
 *  un refus ne se paie pas deux fois. Ils restent bornés par le nombre d'itérations du tour
 *  (`budget + budget web` étapes au plus, refus compris) ;
 *  - `resultat_hors_recherche` — lire une page qui n'est pas dans les résultats **du tour**
 *    (`W` d'un autre tour, ou inventé) : la règle « aucun `read_page` hors des résultats du
 *    `search_web` du tour » est ce qui empêche l'agent de faire du modèle une porte vers
 *    n'importe quelle adresse ;
 *  - une action web **exécutée** (même refusée par le durcissement réseau) consomme son
 *    étape : la borne existe pour ça, et un refus doit pouvoir être retenté une fois, pas
 *    infiniment.
 */
async function applyWebAction(
  action: ConversationActionOutput,
  ctx: ActionContext
): Promise<{ step: ConversationStep }> {
  const web = ctx.web;
  const step: ConversationStep = {
    index: ctx.stepIndex,
    action: action.action,
    scope: "web",
    input:
      action.action === "search_web"
        ? { query: action.query ?? "" }
        : { result: action.result as number },
    added: [],
    observation: [],
    web_added: [],
  };
  const notPaid = (failure: string): { step: ConversationStep } => ({
    step: { ...step, failure, charged: false },
  });

  if (!web.tools?.enabled || !web.unlocked) return notPaid("outil_web_indisponible");
  if (web.used >= web.budget) return notPaid("budget_web_epuise");

  if (action.action === "search_web") {
    if (web.searched) return notPaid("recherche_deja_faite");
    let found: WebSearchResult[];
    try {
      found = await (web.tools.search as NonNullable<WebTools["search"]>).search(
        (action.query ?? "").trim()
      );
    } catch (e) {
      step.failure = e instanceof WebRefusalError ? e.refusal : "recherche_echec";
      return { step };
    }
    if (found.length === 0) {
      step.failure = "aucun_resultat";
      return { step };
    }
    const at = web.now().toISOString();
    for (const r of found.slice(0, MAX_WEB_RESULTS)) {
      const entry: WebResult = {
        index: web.results.length,
        url: r.url,
        title: r.title,
        snippet: r.snippet,
        found_at: at,
        read: false,
      };
      web.results.push(entry);
      step.web_added?.push(entry.index);
    }
    web.searched = true;
    step.web_observation = [...(step.web_added ?? [])];
    return { step };
  }

  // `read_page`
  const target = web.results.find((r) => r.index === action.result);
  if (!target) return notPaid("resultat_hors_recherche");
  if (target.read) return notPaid("page_deja_lue");
  try {
    const page = await web.tools.read(target.url);
    // `page.text` est déjà normalisé et plafonné par `readWebPage` : c'est cette copie-là
    // qui est citée, jamais la page relue plus tard
    target.text = page.text;
    target.title = page.title ?? target.title;
    target.retrieved_at = web.now().toISOString();
    target.read = true;
    delete target.failure;
    step.web_observation = [target.index];
    return { step };
  } catch (e) {
    // la lecture a été tentée : l'étape web est consommée, et le motif reste consultable
    target.failure = e instanceof WebRefusalError ? e.refusal : "lecture_echec";
    step.failure = target.failure;
    return { step };
  }
}

/**
 * Étapes **facturées** d'une famille. Une étape refusée avant d'avoir rien fait
 * (`charged: false`) est tracée mais ne consomme pas de budget : c'est ce qui permet à
 * l'AC5′ de dire « ≤ 5 internes + ≤ 3 web » sur ce qui a été *exécuté*, sans qu'un refus
 * se transforme en étape payée.
 */
function charged(steps: ConversationStep[], scope: "internal" | "web"): number {
  return steps.filter((s) => stepScope(s.action) === scope && s.charged !== false).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
