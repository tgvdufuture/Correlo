import type { Db } from "@/lib/db/client";
import { sha256Hex } from "@/lib/hash";
import { LlmOutputError } from "@/lib/llm/errors";
import { MAX_PROVIDER_ATTEMPTS, providerRetryDelayMs } from "@/lib/llm/retry";
import { assertSingleEmbeddingSpace } from "@/lib/llm/embedding-space";
import type { LlmProvider, PromptCache } from "@/lib/llm/types";
import { buildCorpusIndex, interleave, type CorpusIndex, type IndexedFragment, type QueryEmbedder } from "@/lib/agent/retrieval";
import { toCatalogueEntry } from "@/lib/agent/citations";
import { looksStructural } from "@/lib/synth/select";
import { mentionsProtocolReference } from "@/lib/quality/text-rules";
import { contentWords, stemOf } from "@/lib/quality/lexical-anchor";
import { WebRefusalError } from "@/lib/agent/web-guard";
import {
  WorkspaceRefusalError,
  workspaceExcerpt,
  type WorkspaceReader,
  type WorkspaceReadResult,
} from "@/lib/agent/workspace";
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
  MAX_REFUSED_STEPS,
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
  type WorkspaceRead,
} from "@/lib/agent/conversation-types";
import { DEFAULT_AGENT_CATALOGUE_SIZE, DEFAULT_AGENT_PAGE_SIZE } from "@/lib/agent/types";
import type { ConversationsRepo, MessageRow } from "@/lib/repositories/conversations";
import type { ConversationCanvasRepo } from "@/lib/repositories/conversation-canvases";
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
 *  3. **le web est exposé par constat, pas par humeur** (§13.4, ci-dessous) ;
 *  4. **le workspace est le seul outil local** (`read_file`, §13.5) : lecture seule, confiné
 *     à `WORKSPACE_ROOT`, et **il n'existe pas** sans racine configurée. Il ne consomme ni
 *     budget web ni réseau, mais une étape **interne** — c'est du travail de l'agent.
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
  /** Lectures de fichiers du tour (réussies et refusées). */
  workspaceReads: number;
  llmCalls: number;
  llmCallsFromCache: number;
  /** Affirmations retenues (0 si le tour n'a pas répondu). */
  claims: number;
  /** Affirmations sans preuve — comptées, jamais présentées comme un fait. */
  unsourced: number;
  failure?: string;
}

/**
 * État **workspace** d'un tour (§13.5). Même parti pris que l'état web : le tableau
 * `workspace_reads` du document est muté en place, et le lecteur est celui du réglage.
 */
interface WorkspaceRuntime {
  /** `null` quand aucune racine n'est configurée : l'outil n'existe pas. */
  reader: WorkspaceReader | null;
  reads: WorkspaceRead[];
  now: () => Date;
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
      /** Les tableaux ancrés d'une conversation (multi-ancrage v1.6, AC5). */
      canvasLinks: ConversationCanvasRepo;
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
       * Encodeur de **requête** pour la recherche sémantique (Ollama local — aucune donnée
       * ne sort de la machine, G3). Absent ⇒ `search` reste purement lexical (comportement
       * des phases 4/6 précédentes, et voie des tests sans réseau).
       */
      embedQuery?: QueryEmbedder;
      /**
       * Outils web (§13.4). Absents ⇒ le tour est **entièrement hors ligne** : c'est le
       * défaut, et un tour sans web est complet (AC5′ : 0 étape web).
       */
      web?: WebTools;
      /**
       * Lecteur du workspace (§13.5, AC3). Absent ou désactivé ⇒ `read_file` n'existe pas
       * dans la liste exposée au modèle, et un appel direct est refusé sans être facturé.
       */
      workspace?: WorkspaceReader | null;
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
    const index =
      this.deps.index ?? buildCorpusIndex(this.deps.db, { embedQuery: this.deps.embedQuery });

    const budget = Math.min(opts.maxSteps ?? CONVERSATION_STEP_BUDGET, CONVERSATION_STEP_BUDGET);
    const pageSize = opts.pageSize ?? DEFAULT_AGENT_PAGE_SIZE;
    const catalogueSize = opts.catalogueSize ?? DEFAULT_AGENT_CATALOGUE_SIZE;

    const tools = this.deps.web ?? null;
    const minEvidence = tools?.unlockMinEvidence ?? 2;
    const wsReader = this.deps.workspace ?? null;
    const ws: WorkspaceRuntime = {
      // `enabled: false` (racine vide) et « pas de lecteur » sont le même cas pour le tour :
      // l'outil n'est pas exposé — et le refus direct reste porté par le lecteur lui-même
      reader: wsReader?.enabled ? wsReader : null,
      reads: [],
      now: this.deps.now ?? (() => new Date()),
    };
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
    const seed = this.seedCatalogue(
      conversation.anchor_kind,
      conversation.anchor_ref,
      conversationId,
      catalogueSize
    );
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
      // la racine **du tour** est écrite : un tour relu doit dire d'où venaient ses
      // fichiers, même si le réglage a changé depuis (c'est le cas où une citation cesse
      // d'être revérifiable — et il doit être lisible, pas deviné)
      workspace_root: ws.reader?.root ?? null,
      workspace_reads: ws.reads,
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
    // La boucle a **deux** bornes, et pas une :
    //  - les budgets, qui comptent ce qui est **exécuté** (un refus ne coûte rien, AC5′) ;
    //  - `MAX_REFUSED_STEPS` refus **non facturés** d'affilée, puisqu'un refus ne consomme
    //    aucun budget et que la boucle doit finir.
    //
    // Pourquoi deux, et pas « la somme des budgets + une marge » : chaque itération est un
    // appel LLM, et les refus n'avancent pas le budget — donc compter les itérations comme les
    // étapes faisait qu'un refus **prenait la place de la réponse**. Mesuré en écrivant les
    // tests du workspace : un tour à 3 étapes dont une lecture de fichier refusée par le
    // confinement finissait `step_budget_exhausted` sans jamais répondre, alors que le budget
    // interne n'était pas épuisé et qu'il restait de quoi répondre. Les deux bornes sont donc
    // séparées : trois refus n'enlèvent **jamais** une étape facturée au tour.
    const maxIterations = budget + web.budget + MAX_REFUSED_STEPS + 1;
    let refusals = 0;
    // raison d'un arrêt qui n'est ni « budget épuisé » ni un dernier refus de réponse :
    // le tour doit dire ce qui l'a arrêté
    let failureReason: string | undefined;

    for (let stepIndex = 1; stepIndex <= maxIterations && status === "pending"; stepIndex++) {
      const internalUsed = charged(doc.steps, "internal");
      const webUsed = charged(doc.steps, "web");
      // une seule source de vérité : le compteur web est **dérivé** des étapes facturées,
      // jamais incrémenté à la main (sinon un chemin d'erreur peut oublier de le faire, et
      // le budget web ne borne plus rien — ce que le test « trois lectures » a attrapé)
      web.used = webUsed;
      if (internalUsed >= budget && webUsed >= web.budget) break;
      if (refusals >= MAX_REFUSED_STEPS) {
        // trois refus d'affilée : le modèle n'écoute pas le motif qu'on vient de lui rendre,
        // et un tour qui n'avance plus doit se terminer (tracé), pas boucler
        failureReason = "refus_repete";
        break;
      }

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
          workspace: {
            enabled: ws.reader !== null,
            root: ws.reader?.root ?? null,
            reads: ws.reads,
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
            // (étape `invalid`), un échec silencieux serait pire. Le message de l'erreur
            // porte les issues de validation et la sortie brute tronquée (300 car.) —
            // le garder rend l'échec diagnostiquable depuis la trace, au lieu de deviner.
            doc.steps.push({
              index: stepIndex,
              action: "invalid",
              scope: "internal",
              input: {},
              added: [],
              observation: [],
              failure: "sortie_invalide",
              reason: e.message.slice(0, 500),
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
      // Le raisonnement est une liberté du modèle, pas une entrée bornée : un modèle qui
      // réfléchit longuement dépasse le plafond du champ libre et faisait rejeter TOUTE
      // l'action — mesuré sur le tour réel du 2026-10-01 (« Ca sert a quoi un LLM ? »,
      // 2 recherches réussies, puis `sortie_invalide` sur un dépassement de 4 000 car.).
      // Tronquer ici plutôt que valider strictement : ce champ n'est jamais lu ni persisté.
      if (action.reasoning && action.reasoning.length > 4_000) action.reasoning = action.reasoning.slice(0, 4_000);
      const outcome = await applyAction(action, {
        index,
        embedQuery: this.deps.embedQuery,
        stepIndex,
        pageSize,
        catalogueSize,
        catalogue: doc.catalogue,
        known,
        priorSteps: doc.steps,
        web,
        workspace: ws,
        internalUsed,
        internalBudget: budget,
        explorationBudget,
      });
      doc.steps.push(outcome.step);
      if (outcome.step.charged === false) refusals += 1;
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
      doc.failure = lastRefusal ?? failureReason ?? "step_budget_exhausted";
    }
    // **L'état terminal est écrit ici, une fois, quel que soit le chemin de sortie** — budget
    // épuisé, trois refus, ou sortie invalide. La version qui ne persistait que dans le cas
    // `pending` laissait la ligne `messages` en `pending` **à vie** quand la boucle sortait par
    // la branche « sortie invalide » (statut déjà `failed` en entrant ici) : `awaiting_reply`
    // restait vrai, l'écran sondait sans fin et le 409 verrouillait la conversation — un tour
    // perdu, sans trace. Défaut réel, trouvé par un tour réel du 2026-09-20 où le modèle a
    // rendu une sortie que le schéma refuse.
    persist(status);

    return {
      messageId: opts.messageId,
      status,
      steps: doc.steps.length,
      internalSteps: doc.internal_steps,
      webSteps: doc.web_steps,
      webUnlocked: doc.web_unlocked,
      webUnlockReason: doc.web_unlock_reason,
      workspaceReads: doc.workspace_reads.filter((r) => !r.failure).length,
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
    anchorRef: string | null,
    conversationId: string,
    catalogueSize: number
  ): {
    entries: CatalogueEntry[];
    synthesisText?: string | null;
    synthesisStale?: boolean;
    anchorMissing: boolean;
  } {
    const entries: CatalogueEntry[] = [];
    let synthesisText: string | null = null;
    let synthesisStale = false;
    let anchorMissing = false;
    const pushFragment = (id: string): void => {
      if (entries.length >= catalogueSize) return;
      if (entries.some((e) => e.fragment_id === id)) return; // un fragment n'entre qu'une fois
      const f = this.deps.fragments.getById(id);
      if (!f) return; // fragment disparu : sauté, jamais inventé (AC1)
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
    };
    if (anchorKind === "synthesis" && anchorRef) {
      const synthesis = this.deps.syntheses.getById(anchorRef);
      if (!synthesis) {
        anchorMissing = true;
      } else {
        synthesisText = synthesis.text;
        synthesisStale = synthesis.stale === 1;
        let evidenceIds: string[] = [];
        try {
          const parsed = JSON.parse(synthesis.evidence_fragment_ids) as unknown;
          if (Array.isArray(parsed)) evidenceIds = parsed.filter((x): x is string => typeof x === "string");
        } catch {
          evidenceIds = [];
        }
        for (const id of evidenceIds) pushFragment(id);
      }
    }
    // ── le multi-ancrage (v1.6 §14.5 AC5) ──────────────────────────────────
    // Les constructions posées sur les **tableaux ancrés** entrent dans le
    // catalogue de départ : leurs extraits (fragments de preuve) et les fragments
    // de leurs paires parentes (la suggestion 2A qui les a produites). Le plafond
    // du catalogue borne le tout ; l'ordre suit la collection (épinglés, position)
    // puis la position sur le plan — déterministe, rejouable à l'identique.
    for (const canvasId of this.deps.canvasLinks.listForConversation(conversationId)) {
      if (entries.length >= catalogueSize) break;
      const constructionRefs = (
        this.deps.db
          .prepare(
            `SELECT item_ref FROM canvas_items
             WHERE canvas_id = ? AND item_kind = 'construction'
             ORDER BY z ASC, rowid ASC`
          )
          .all(canvasId) as { item_ref: string }[]
      ).map((r) => r.item_ref);
      for (const ref of constructionRefs) {
        if (entries.length >= catalogueSize) break;
        const c = this.deps.db
          .prepare("SELECT suggestion_id FROM constructions WHERE id = ?")
          .get(ref) as { suggestion_id: string | null } | undefined;
        if (!c) continue; // orphelin : le dépôt de l'atelier purge, le tour n'attend pas
        // les extraits d'abord (les fragments de preuve de l'énoncé)
        const evidence = this.deps.db
          .prepare("SELECT evidence_fragment_ids FROM constructions WHERE id = ?")
          .get(ref) as { evidence_fragment_ids: string };
        try {
          const parsed = JSON.parse(evidence.evidence_fragment_ids) as unknown;
          if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === "string") pushFragment(id);
        } catch {
          // snapshot illisible : la construction entre par ses paires, sans extraits
        }
        // puis la paire parente (les deux fragments de la suggestion 2A)
        if (c.suggestion_id) {
          const sg = this.deps.db
            .prepare("SELECT fragment_a_id, fragment_b_id FROM suggestions WHERE id = ?")
            .get(c.suggestion_id) as { fragment_a_id: string; fragment_b_id: string } | undefined;
          if (sg) {
            pushFragment(sg.fragment_a_id);
            pushFragment(sg.fragment_b_id);
          }
        }
      }
    }
    return {
      entries,
      synthesisText,
      synthesisStale,
      anchorMissing,
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
 * une preuve — constat 5A, `looksStructural`).
 *
 * La transversalité (≥ 2 sources) reste la valeur du produit pour les **suggestions** —
 * mais pour répondre à une question, une source unique bien fournie **suffit** : mesuré
 * en réel (2026-10-01, « Ca sert a quoi un LLM ? »), 8 fragments pertinents d'UN document
 * (« Grand modèle de langage ») étaient sous les yeux du modèle, le serveur déclarait
 * « corpus insuffisant » parce qu'ils ne venaient pas de 2 sources, et le tour allait
 * chercher sur le web ce que le corpus tenait — deux refus `reponse_web_ignoree` avant
 * que le modèle n'obéisse. Le critère de suffisance devient donc la **masse** de preuves
 * utilisables, plus le nombre de sources qui les portent.
 */
export function usableEvidence(catalogue: CatalogueEntry[]): number {
  const pool = catalogue.filter((e) => !looksStructural(e.text, e.locator));
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
 *  5bis. **et le workspace répond au constat** (§13.5). Un tour dont la réponse s'appuie sur
 *     une lecture de fichier du tour n'a pas « ignoré » le constat : il est allé lire un
 *     document que l'utilisateur avait **désigné**. Mesuré sur le premier tour workspace réel
 *     (2026-09-20) : question sur `notes/protocole.md` d'un dossier pourtant configuré, le
 *     serveur a jugé le corpus insuffisant (1 fragment sur « calibration »), exposé le web,
 *     et refusé **deux fois** une réponse pourtant sourcée sur le fichier lu — le tour est
 *     mort à 0 affirmation alors qu'il avait la réponse sous les yeux. Le constat parle du
 *     **corpus** ; un fichier du workspace n'est pas une absence de source, c'est une source
 *     que l'utilisateur a nommée ;
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
 * **Et une lecture de fichier **citée** vaut exploration** (`readBeforeAnswer`) : la règle 1
 * demande qu'une lecture ait eu lieu, pas qu'elle porte sur le corpus. Mesuré sur le premier
 * tour workspace réel : le modèle a ouvert `notes/protocole.md` **avant** de chercher dans le
 * corpus — le geste juste pour une question qui nomme un fichier — et la réponse a été refusée
 * pour « reponse_sans_exploration », alors qu'il venait de lire. Le critère est donc « la
 * réponse s'appuie sur un document lu pendant ce tour », et la lecture du fichier compte
 * comme celle du corpus. Ce qui **ne** compte pas : avoir lu sans citer — un fichier ouvert
 * puis ignoré dans la réponse ne dispense de rien.
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
  /** Encodeur de requête pour la moitié sémantique du `search` (absent en tests). */
  embedQuery?: QueryEmbedder;
  stepIndex: number;
  pageSize: number;
  catalogueSize: number;
  catalogue: CatalogueEntry[];
  known: Set<string>;
  priorSteps: ConversationStep[];
  web: WebRuntime;
  workspace: WorkspaceRuntime;
  internalUsed: number;
  internalBudget: number;
  /** Plafond des explorations (`budget − 1`) : la réponse garde sa place. */
  explorationBudget: number;
}

/**
 * Découpe une **prose** en phrases et rattache à chaque phrase les sources déclarées qui
 * la recouvrent — **le serveur rattache, jamais le modèle** (mesure Phase 4, §11.3 : la
 * devinette laissée au modèle valait 0,27 de recouvrement sur une clause pourtant
 * correcte). Le recouvrement est lexical et asymétrique : une phrase « appuyée » par une
 * source si ses mots de contenu apparaissent dans la source — pas l'inverse, sinon une
 * phrase qui résume tout le fragment sans en partager les mots serait crue sourcée.
 *
 * Une phrase sans source reçue : les sources **de la réponse entière** si elle en a (une
 * phrase de transition au milieu d'une réponse sourcée n'est pas « non sourcée » pour
 * autant), sinon le marqueur `own_knowledge` du modèle. Ce n'est pas le jugement qu'une
 * phrase *implique* la source : c'est le rattachement de ce qui a été déclaré utilisé,
 * vérifiable en relisant la copie affichée.
 */
function claimsFromProse(
  answer: ConversationActionOutput,
  ctx: ActionContext
): ConversationClaim[] {
  const sentences = splitSentences(answer.prose ?? "");
  if (sentences.length === 0) return [];

  // Racines des sources déclarées, calculées une fois : le rattachement ne doit pas
  // re-tokeniser chaque fragment par phrase.
  const fragmentSources = (answer.citations ?? []).map((i) => {
    const entry = ctx.catalogue.find((e) => e.index === i) as CatalogueEntry;
    return { entry, stems: contentStems(entry.text) };
  });
  const webSources = (answer.web ?? []).map((i) => {
    const result = ctx.web.results.find((r) => r.index === i) as WebResult;
    return { result, stems: contentStems(result.text ?? "") };
  });
  const fileSources = (answer.files ?? []).map((i) => {
    const read = ctx.workspace.reads.find((r) => r.index === i) as WorkspaceRead;
    return { read, stems: contentStems(read.text ?? "") };
  });

  const claims: ConversationClaim[] = [];
  for (const sentence of sentences) {
    const words = contentStems(sentence);
    const attached: ClaimProvenance[] = [];
    for (const fs of fragmentSources) {
      if (coversSentence(fs.stems, words)) {
        const entry = fs.entry;
        attached.push({
          kind: "fragment",
          index: entry.index,
          fragment_id: entry.fragment_id,
          source_id: entry.source_id,
          source_title: entry.source_title,
          locator: entry.locator,
          text: entry.text,
        });
      }
    }
    for (const ws of webSources) {
      if (coversSentence(ws.stems, words)) {
        const result = ws.result;
        attached.push({
          kind: "url",
          index: result.index,
          url: result.url,
          title: result.title,
          retrieved_at: result.retrieved_at as string,
          excerpt: webExcerpt(result.text ?? ""),
        });
      }
    }
    for (const fs of fileSources) {
      if (coversSentence(fs.stems, words)) {
        const read = fs.read;
        attached.push({
          kind: "file",
          index: read.index,
          path: read.path,
          from_line: read.from_line,
          to_line: read.to_line,
          read_at: read.read_at,
          excerpt: workspaceExcerpt(read.text ?? ""),
        });
      }
    }
    // Une phrase sans rattachement direct est une phrase que le modèle **assume** :
    // transition, reformulation, connaissance externe. Elle porte le marqueur — l'écran
    // dit « connaissance du modèle » au lieu de la présenter comme sourcée. On n'hérite
    // PAS des sources déclarées : coller un fragment à une phrase qui n'en partage aucun
    // mot recrée exactement la fausse provenance que la mesure Phase 4 a condamnée.
    const ownKnowledge = attached.length === 0 || answer.own_knowledge === true;
    claims.push({
      text: sentence,
      ...(ownKnowledge ? { own_knowledge: true } : {}),
      provenance: attached,
    });
  }
  return claims;
}

/**
 * Racines de contenu d'un texte, **plus ses nombres** (normalisés : « 2,4 » → « 24 »,
 * « 15 % » → « 15 »). Une page web lue est souvent en anglais quand la prose est en
 * français (mesuré : arxiv 2405.21015 lu, prose rédigée en français) — les racines ne
 * traversent pas la langue (« coût » vs « cost »), mais les chiffres si : années,
 * pourcentages et facteurs sont les ancres les plus précises d'un rattachement.
 */
function contentStems(text: string): Set<string> {
  const stems = new Set(contentWords(text).map(stemOf));
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 2) stems.add(`#${digits}`);
  }
  return stems;
}

/**
 * La source recouvre-t-elle la phrase ? Asymétrique : assez de mots de la phrase doivent
 * se retrouver dans la source. Deux voies :
 *  - recouvrement lexical ≥ 0,30 — abaissé de 0,34 : une prose française appuyée sur une
 *    source anglaise perd des racines à la traduction (« modèle » vs « model » tombe, mais
 *    « salaires » vs « salaries » rate à une lettre) ; mesuré sur le tour réel du
 *    2026-10-01, 33 % de recouvrement réel était refusé et la claim finissait étiquetée
 *    « connaissance du modèle » alors qu'elle venait de la page lue ;
 *  - ancre numérique : un nombre partagé (année, pourcentage, facteur) et ≥ 0,15 de
 *    recouvrement — un chiffre est quasi-unique, il porte le rattachement à lui seul.
 */
function coversSentence(sourceStems: Set<string>, sentenceStems: Set<string>): boolean {
  if (sentenceStems.size === 0) return false;
  let hit = 0;
  let sharedNumbers = false;
  for (const s of sentenceStems) {
    if (!sourceStems.has(s)) continue;
    hit += 1;
    if (s.startsWith("#")) sharedNumbers = true;
  }
  const coverage = hit / sentenceStems.size;
  return coverage >= 0.3 || (sharedNumbers && coverage >= 0.15);
}

/**
 * Découpage en phrases : frontières `.!?` suivies d'un espace et d'une majuscule ou d'un
 * guillemet ouvrant, plus la fin de texte. Une troncature de provider peut casser une
 * phrase — elle est conservée telle quelle : c'est du texte affiché, pas du JSON.
 */
function splitSentences(prose: string): string[] {
  const text = prose.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?") {
      const next = text[i + 1];
      const after = text[i + 2];
      if (
        (next === " " && (after === undefined || /[A-ZÀ-ÖØ-Þ"«\d]/.test(after))) ||
        next === undefined
      ) {
        const s = text.slice(start, i + 1).trim();
        if (s) out.push(s);
        start = i + 1;
      }
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
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
      // Hybride (décision du 2026-10-01) : la moitié lexicale seule était aveugle aux
      // synonymes — « LLM » ne trouvait pas un corpus qui écrit « modèle de langage ».
      // La requête est encodée par le connecteur **local** (G3) et la moitié sémantique
      // est intercalée par rang derrière la lexicale ; sans encodeur (tests), le `search`
      // garde exactement le comportement lexical des phases 4/6.
      const lexical = index.search(action.query ?? "", pageSize * 2);
      const semantic = ctx.embedQuery
        ? await index.semanticSearch(action.query ?? "", pageSize * 2)
        : [];
      candidates = interleave(lexical, semantic, pageSize * 2);
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

  if (action.action === "read_file") {
    return applyFileAction(action, ctx);
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
  const raw = action.claims ?? [];
  // Une lecture de fichier **citée** vaut exploration (voir l'encadré) : le critère est
  // « la réponse s'appuie sur un document lu pendant ce tour », et un fichier du workspace
  // en est un. Un fichier lu mais non cité ne dispense de rien — sinon n'importe quelle
  // lecture décorative blanchirait une réponse rendue à partir de rien.
  const readBeforeAnswer =
    raw.some((c) =>
      (c.files ?? []).some((i) => ctx.workspace.reads.some((r) => r.index === i && !r.failure))
    ) ||
    (action.files ?? []).some((i) =>
      ctx.workspace.reads.some((r) => r.index === i && !r.failure)
    );
  const explored = priorSteps.some(
    (s) => (s.action === "search" || s.action === "expand") && !s.failure
  );
  if (!explored && !readBeforeAnswer) {
    step.refused = "reponse_sans_exploration";
    return { step };
  }

  const unknown = [
    ...raw.flatMap((c) => c.citations ?? []).filter((i) => !catalogue.some((e) => e.index === i)),
    ...raw
      .flatMap((c) => c.web ?? [])
      .filter((i) => !ctx.web.results.some((r) => r.index === i)),
    // un fichier **refusé** est traité comme un fichier inexistant : la lecture a échoué,
    // donc il n'y a rien à citer — et le dire « hors catalogue » est exact, l'indice ne
    // désigne aucune lecture citable
    ...raw
      .flatMap((c) => c.files ?? [])
      .filter((i) => !ctx.workspace.reads.some((r) => r.index === i && !r.failure)),
    ...(action.citations ?? []).filter((i) => !catalogue.some((e) => e.index === i)),
    ...(action.web ?? []).filter((i) => !ctx.web.results.some((r) => r.index === i)),
    ...(action.files ?? []).filter(
      (i) => !ctx.workspace.reads.some((r) => r.index === i && !r.failure)
    ),
  ];
  if (unknown.length > 0) {
    step.refused = "reponse_hors_catalogue";
    return { step };
  }

  const unread = [
    ...raw.flatMap((c) => c.web ?? []),
    ...(action.web ?? []),
  ].filter((i) => !ctx.web.results.find((r) => r.index === i)?.read);
  if (unread.length > 0) {
    step.refused = "reponse_web_non_lue";
    return { step };
  }

  // la prose parle du protocole (« le fragment [0] affirme que… ») : elle est réécrite ou
  // refusée, jamais affichée telle quelle — `messages.text` est l'union de ces textes
  if (
    raw.some((c) => mentionsProtocolReference(c.text ?? "")) ||
    (action.prose ? mentionsProtocolReference(action.prose) : false)
  ) {
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
  // …et le **workspace répond au constat** : un tour dont la réponse s'appuie sur un fichier
  // lu n'a pas ignoré le web, il a lu une source que l'utilisateur avait désignée (§13.5).
  // Défaut mesuré sur le premier tour workspace réel : réponse sourcée sur le fichier
  // demandé, refusée `reponse_web_ignoree` — le tour est mort à 0 affirmation, avec la
  // réponse sous les yeux. Le constat parle du **corpus**, pas de l'absence de sources.
  const webUntouched = !priorSteps.some((s) => s.scope === "web");
  if (ctx.web.unlocked && ctx.web.budget > 0 && webUntouched && !readBeforeAnswer) {
    step.refused = "reponse_web_ignoree";
    return { step };
  }

  // Deux contrats en parallèle (révision du 2026-10-01) : la sortie **prose** ("answer")
  // est découpée par le serveur et chaque phrase reçoit les sources déclarées qui la
  // recouvrent ; l'ancienne sortie **claims** reste acceptée telle quelle (rattrapage d'un
  // modèle qui suivrait l'ancien contrat, et tours persistés).
  const claims: ConversationClaim[] = action.prose
    ? claimsFromProse(action, ctx)
    : raw.map((c) => ({
        text: c.text.trim(),
        own_knowledge: c.citations?.length || c.web?.length || c.files?.length ? undefined : true,
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
          ...(c.files ?? []).map((i) => {
            const read = ctx.workspace.reads.find((r) => r.index === i) as WorkspaceRead;
            const provenance: ClaimProvenance = {
              kind: "file",
              index: read.index,
              path: read.path,
              from_line: read.from_line,
              to_line: read.to_line,
              read_at: read.read_at,
              // la copie conservée est celle du **serveur**, jamais un extrait recopié par le
              // modèle : c'est ce qui rend la relecture possible
              excerpt: workspaceExcerpt(read.text ?? ""),
            };
            return provenance;
          }),
        ],
      }));

  // Une réponse dont **aucune** affirmation n'est appuyée reste recevable **si** le modèle
  // assume son contenu comme connaissance propre (own_knowledge) : c'est le contrat v9 —
  // l'utilisateur a demandé ce que le modèle en pense, pas une radiographie du corpus.
  // Ce qui reste refusé : une réponse qui prétend rapporter des sources et n'en a aucune.
  if (
    claims.every((c) => c.provenance.length === 0) &&
    !(action.own_knowledge === true)
  ) {
    step.refused = "reponse_sans_aucune_preuve";
    return { step };
  }
  step.observation = claims.flatMap((c) =>
    c.provenance.filter((p) => p.kind === "fragment").map((p) => p.index)
  );
  step.web_observation = claims.flatMap((c) =>
    c.provenance.filter((p) => p.kind === "url").map((p) => p.index)
  );
  step.workspace_observation = claims.flatMap((c) =>
    c.provenance.filter((p) => p.kind === "file").map((p) => p.index)
  );
  return { step, claims };
}

/**
 * `read_file` (§13.5, AC3) — le seul outil **local** de l'agent. Quatre refus, et une seule
 * règle de facturation :
 *
 *  - `outil_workspace_indisponible` — aucune racine configurée (`WORKSPACE_ROOT` vide) :
 *    l'outil n'existe pas dans la liste exposée, et un appel direct n'aboutit à rien. Ce
 *    n'est pas une faute du modèle, donc ce n'est pas facturé ;
 *  - `budget_interne_epuise` — même réserve que `search`/`expand` : la réponse garde sa place
 *    dans le budget interne (`budget − 1`) ;
 *  - `plage_deja_lue` — la **même plage du même fichier**, déjà lue dans ce tour. Un modèle
 *    qui relit ce qu'il vient de lire n'apprend rien et consomme un appel LLM ;
 *  - les refus du confinement (`chemin_hors_racine`, `chemin_introuvable`, `fichier_binaire`,
 *    `plage_trop_longue`…) — rendus par le **lecteur**, pas par le service : une seule règle
 *    de confinement, celle de `lib/agent/workspace.ts`, et le motif remonte tel quel.
 *
 * **Ce qui est facturé : exactement ce qui a été lu.** Une lecture réussie est une étape
 * interne (`scope: "internal"`) : c'est du travail de l'agent, et un outil gratuit
 * s'appellerait en boucle. Un **refus**, lui, n'est jamais facturé : rien n'a été lu, rien
 * n'est sorti de la machine — même règle que les refus de réponse, jamais celle du web (où
 * une tentative *part* sur le réseau, et où c'est l'acte, pas le résultat, qui est compté).
 * Comme pour le web, les refus restent bornés par le nombre d'itérations du tour.
 *
 * Une lecture **refusée est enregistrée** (avec son motif) : la trace doit dire ce qui a été
 * tenté. Seule une lecture réussie est citable — le confinement est donc visible dans le tour
 * même, et pas seulement dans le journal du serveur.
 */
async function applyFileAction(
  action: ConversationActionOutput,
  ctx: ActionContext
): Promise<{ step: ConversationStep }> {
  const ws = ctx.workspace;
  const step: ConversationStep = {
    index: ctx.stepIndex,
    action: "read_file",
    scope: "internal",
    input: {
      path: (action.path ?? "").trim(),
      ...(action.from !== undefined ? { from: action.from } : {}),
      ...(action.to !== undefined ? { to: action.to } : {}),
    },
    added: [],
    observation: [],
    workspace_added: [],
  };
  const notPaid = (failure: string): { step: ConversationStep } => ({
    step: { ...step, failure, charged: false },
  });

  if (!ws.reader) return notPaid("outil_workspace_indisponible");
  if (ctx.internalUsed >= ctx.explorationBudget) return notPaid("budget_interne_epuise");

  const at = ws.now().toISOString();
  const index = ws.reads.length;
  let result: WorkspaceReadResult;
  try {
    result = ws.reader.read({
      path: step.input.path ?? "",
      from: action.from,
      to: action.to,
    });
  } catch (e) {
    const failure = e instanceof WorkspaceRefusalError ? e.refusal : "lecture_echec";
    // la tentative est enregistrée (donc affichée), l'étape n'est pas facturée
    ws.reads.push({
      index,
      path: step.input.path ?? "",
      from_line: action.from ?? 1,
      to_line: action.to ?? action.from ?? 1,
      read_at: at,
      failure,
    });
    return { step: { ...step, failure, charged: false, workspace_added: [index] } };
  }

  // redondance évaluée sur la **vérité résolue** (chemin réel + plage effective) : comparer
  // les chemins demandés obligerait à deviner les normalisations du modèle
  const already = ws.reads.find(
    (r) =>
      !r.failure &&
      r.path === result.path &&
      r.from_line === result.from_line &&
      r.to_line === result.to_line
  );
  if (already) return notPaid("plage_deja_lue");

  ws.reads.push({
    index,
    path: result.path,
    from_line: result.from_line,
    to_line: result.to_line,
    text: result.text,
    bytes: result.bytes,
    read_at: at,
  });
  step.workspace_added = [index];
  step.workspace_observation = [index];
  return { step };
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
