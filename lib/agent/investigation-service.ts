import type { Db } from "@/lib/db/client";
import { sha256Hex } from "@/lib/hash";
import { LlmOutputError } from "@/lib/llm/errors";
import { MAX_PROVIDER_ATTEMPTS, providerRetryDelayMs } from "@/lib/llm/retry";
import { assertSingleEmbeddingSpace } from "@/lib/llm/embedding-space";
import type { LlmProvider, PromptCache } from "@/lib/llm/types";
import { buildCorpusIndex, type CorpusIndex, type IndexedFragment } from "@/lib/agent/retrieval";
import {
  DEFAULT_AGENT_CATALOGUE_SIZE,
  DEFAULT_AGENT_PAGE_SIZE,
  INVESTIGATION_STEP_BUDGET,
  type CatalogueEntry,
  type InvestigationDocument,
  type InvestigationStatus,
  type InvestigationStep,
} from "@/lib/agent/types";
import { INVESTIGATION_ACTION_SCHEMA, type InvestigationActionOutput } from "@/lib/agent/schema";
import { buildInvestigationPrompt, INVESTIGATION_PROMPT_VERSION } from "@/lib/agent/prompts";
import {
  CONCLUSION_JUX_RULE_VERSION,
  CONCLUSION_RULE_VERSION,
  judgeConclusion,
  type ConclusionRejection,
} from "@/lib/quality/conclusion";
import { toCatalogueEntry } from "@/lib/agent/citations";
import type { InvestigationsRepo } from "@/lib/repositories/investigations";
import type { SuggestionsRepo } from "@/lib/repositories/suggestions";
import type { FragmentsRepo } from "@/lib/repositories/fragments";
import type { SourcesRepo } from "@/lib/repositories/sources";

/**
 * Phase 4 — investigation menée par **un seul agent** (US-09, AC1).
 *
 * Une seule boucle séquentielle, un seul appel LLM par étape, au plus 5 étapes —
 * la conclusion comprise. À chaque tour le modèle choisit **une** action parmi
 * `search`, `expand`, `conclude` ; le serveur l'exécute lui-même (recherche
 * lexicale ou voisinage vectoriel, cf. `retrieval.ts`), enrichit le catalogue, puis
 * redonne la main. Il n'y a donc jamais d'agent parallèle ni de sous-agent, et le
 * modèle ne dispose d'**aucun outil réseau** : AC3 (aucune vérification web) est
 * vrai par construction, pas par consigne.
 *
 * Le modèle ne voit jamais d'identifiant de fragment : il cite des **indices** de
 * catalogue, le serveur rattache (`AC2`, même règle qu'en 2A/5A).
 */

export interface InvestigationRunOptions {
  /**
   * Identifiant de l'investigation — c'est celui du **job** (`jobs.id`), donc un
   * rejeu met à jour la même ligne au lieu d'empiler les enquêtes.
   */
  investigationId: string;
  /** Plafond d'actions demandé ; plafonné dur à INVESTIGATION_STEP_BUDGET. */
  maxSteps?: number;
  /** Fragments ajoutés au catalogue par action d'exploration. */
  pageSize?: number;
  /** Taille maximale du catalogue (borne le prompt et le document persisté). */
  catalogueSize?: number;
  /** Troncature des fragments **dans le prompt** (la copie persistée reste intégrale). */
  maxFragmentChars?: number;
  /** Cache de prompt (worker) ou en mémoire (tests) — surchargeable par run. */
  promptCache?: PromptCache;
  onProgress?: (info: {
    step: number;
    budget: number;
    status: InvestigationStatus;
    llmCalls: number;
    stepsFromCache: number;
  }) => void;
}

export interface InvestigationRunResult {
  investigationId: string;
  status: InvestigationStatus;
  steps: number;
  llmCalls: number;
  llmCallsFromCache: number;
  /** Citations de la conclusion (0 si l'enquête n'a pas conclu). */
  citations: number;
  failure?: string;
}

export class InvestigationService {
  constructor(
    private deps: {
      db: Db;
      investigations: InvestigationsRepo;
      suggestions: SuggestionsRepo;
      fragments: FragmentsRepo;
      sources: SourcesRepo;
      chat: LlmProvider;
      chatModel: string;
      /**
       * Signature du **réglage** du chat (modèle + effort de raisonnement + budget).
       * Entre dans la clé du cache : un même prompt n'a pas la même réponse selon
       * que le modèle raisonne ou non (défaut mesuré en Phase 5A).
       */
      chatSignature?: string;
      promptCache?: PromptCache;
      /** Index du corpus déjà construit (tests) — sinon il est construit par le run. */
      index?: CorpusIndex;
    }
  ) {}

  async run(suggestionId: string, opts: InvestigationRunOptions): Promise<InvestigationRunResult> {
    const suggestion = this.deps.suggestions.getById(suggestionId);
    if (!suggestion) {
      // rien à écrire : `investigations.suggestion_id` est une FK (le schéma v1.2
      // interdit une enquête orpheline) — l'erreur est portée par le job
      throw new Error(`investigation : suggestion introuvable (${suggestionId})`);
    }
    // Invariant de la maison : on ne compare que des vecteurs du même espace. Ici le
    // risque est réel — `dotProduct` lit `dims` valeurs, donc un corpus mixte
    // produirait des voisinages faux mais plausibles.
    assertSingleEmbeddingSpace(this.deps.db, [], `investigation ${opts.investigationId}`);
    const index = this.deps.index ?? buildCorpusIndex(this.deps.db);

    const budget = Math.min(opts.maxSteps ?? INVESTIGATION_STEP_BUDGET, INVESTIGATION_STEP_BUDGET);
    const pageSize = opts.pageSize ?? DEFAULT_AGENT_PAGE_SIZE;
    const catalogueSize = opts.catalogueSize ?? DEFAULT_AGENT_CATALOGUE_SIZE;

    const catalogue = this.seedCatalogue(suggestion.fragment_a_id, suggestion.fragment_b_id);
    if (catalogue.length === 0) {
      throw new Error(`investigation : aucun fragment disponible pour la suggestion ${suggestionId}`);
    }
    const doc: InvestigationDocument = {
      prompt_version: INVESTIGATION_PROMPT_VERSION,
      chat_model: this.deps.chatModel,
      conclusion_rule_version: CONCLUSION_RULE_VERSION,
      juxtaposition_rule_version: CONCLUSION_JUX_RULE_VERSION,
      step_budget: budget,
      llm_calls: 0,
      steps_from_cache: 0,
      catalogue,
      steps: [],
    };
    const persist = (status: InvestigationStatus, failure?: string): void => {
      if (failure) doc.failure = failure;
      this.deps.investigations.upsert({
        id: opts.investigationId,
        suggestionId,
        status,
        document: doc,
      });
    };
    // la ligne existe **avant** le premier appel LLM : un échec du provider laisse
    // une enquête consultable (avec son catalogue de départ) au lieu d'un trou
    persist("running");

    let status: InvestigationStatus = "running";
    let failure: string | undefined;
    // Dernier refus **récupérable** (le modèle peut se reprendre dans le budget) : s'il
    // n'y a pas de conclusion valide à la fin, c'est cette raison-là qui décrit le run —
    // « budget épuisé » serait vrai mais ne dirait rien de ce qui a échoué.
    let lastRefusal: string | undefined;
    const promptCache = opts.promptCache ?? this.deps.promptCache;

    for (let stepIndex = 1; stepIndex <= budget && status === "running"; stepIndex++) {
      const messages = buildInvestigationPrompt(
        {
          claim: suggestion.claim,
          relationType: suggestion.relation_type,
          catalogue: doc.catalogue,
          steps: doc.steps,
          stepBudget: budget,
        },
        { maxFragmentChars: opts.maxFragmentChars }
      );
      const cacheKey = sha256Hex(
        JSON.stringify([
          this.deps.chatSignature ?? this.deps.chatModel,
          INVESTIGATION_PROMPT_VERSION,
          messages,
        ])
      );
      const cached = promptCache?.get(cacheKey);
      let action: InvestigationActionOutput;
      if (cached !== undefined) {
        // un rejeu de la même question ne rappelle pas le modèle : le prompt est une
        // fonction pure de (suggestion, catalogue, étapes), donc la clé est stable
        action = cached as InvestigationActionOutput;
        doc.steps_from_cache += 1;
      } else {
        try {
          action = await this.callChat(messages);
          doc.llm_calls += 1;
          promptCache?.set(cacheKey, action);
        } catch (e) {
          if (e instanceof LlmOutputError) {
            // sortie inexploitable après le retry de correction : la trace est
            // écrite (étape `invalid`) — un échec silencieux serait pire
            doc.steps.push({
              index: stepIndex,
              action: "invalid",
              input: {},
              added: [],
              observation: [],
              failed: true,
              failure: "sortie_invalide",
            });
            status = "failed";
            failure = "sortie_invalide";
            break;
          }
          throw e;
        }
      }

      const known = new Set(doc.catalogue.map((e) => e.fragment_id));
      const step = applyAction(action, {
        index,
        stepIndex,
        pageSize,
        catalogueSize,
        catalogue: doc.catalogue,
        known,
        priorSteps: doc.steps,
        claim: suggestion.claim,
      });
      doc.steps.push(step);
      if (step.action === "conclude") {
        if (!step.failed) {
          status = "done";
        } else if (RETRYABLE_CONCLUSION_FAILURES.has(step.failure ?? "")) {
          // conclusion refusée mais réparable dans le budget restant : le modèle voit
          // le refus et sa raison dans la transcription à l'étape suivante
          lastRefusal = step.failure;
        } else {
          status = "failed";
          failure = step.failure;
        }
      }
      persist(status, failure);
      opts.onProgress?.({
        step: stepIndex,
        budget,
        status,
        llmCalls: doc.llm_calls,
        stepsFromCache: doc.steps_from_cache,
      });
    }

    if (status === "running") {
      // budget épuisé sans conclusion exploitable : c'est un échec au sens du
      // protocole (le prompt le dit — « une enquête sans conclusion est un échec ») et
      // la trace des actions reste consultable
      status = "failed";
      failure = lastRefusal ?? "step_budget_exhausted";
    }
    const conclusion = [...doc.steps].reverse().find((s) => s.action === "conclude" && !s.failed);
    const result: InvestigationRunResult = {
      investigationId: opts.investigationId,
      status,
      steps: doc.steps.length,
      llmCalls: doc.llm_calls,
      llmCallsFromCache: doc.steps_from_cache,
      citations: conclusion?.citations?.length ?? 0,
      failure,
    };
    persist(status, failure);
    return result;
  }

  /** Catalogue de départ : les deux preuves de la suggestion (origin `seed`). */
  private seedCatalogue(aId: string, bId: string): CatalogueEntry[] {
    const entries: CatalogueEntry[] = [];
    for (const id of [aId, bId]) {
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
    return entries;
  }

  /**
   * Un appel chat par étape, avec réessai des incidents **passagers** du provider
   * (429/503/timeout/ECONNRESET, même politique qu'en 2A/5A). Une sortie invalide
   * n'est pas un incident passager : elle remonte tout de suite pour être tracée
   * comme étape `invalid`.
   */
  private async callChat(messages: Parameters<LlmProvider["chat"]>[0]): Promise<InvestigationActionOutput> {
    for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        const out = await this.deps.chat.chat(messages, INVESTIGATION_ACTION_SCHEMA);
        console.log(`[investigation] action LLM : ${Date.now() - startedAt} ms`);
        return out as InvestigationActionOutput;
      } catch (e) {
        const delay = providerRetryDelayMs(e, attempt);
        if (delay === null || attempt === MAX_PROVIDER_ATTEMPTS - 1) throw e;
        console.warn(
          `[investigation] incident provider — tentative ${attempt + 1}/${MAX_PROVIDER_ATTEMPTS} ` +
            `dans ${Math.round(delay / 1000)}s : ${(e as Error).message.slice(0, 140)}`
        );
        await sleep(delay);
      }
    }
    throw new Error("étape d'investigation sans résultat après tentatives");
  }
}

/**
 * Exécute une action et renvoie l'étape correspondante.
 *
 * Les actions d'exploration ajoutent des fragments au catalogue (l'`observation`
 * d'une étape, ce sont les indices qu'elle vient d'ouvrir) ; une action `expand`
 * qui vise un indice absent est une étape **failed** — le modèle peut alors se
 * reprendre à l'étape suivante, c'est le budget qui borne l'essai.
 *
 * Les refus de conclusion viennent de deux endroits, séparés par nature :
 *  1. **le run** — `conclusion_sans_exploration` : le modèle a conclu dès la première
 *     action, à partir des seules deux graines. Une exploration **réussie**
 *     (search/expand non échouée) est exigée avant toute conclusion. C'est une
 *     propriété de la trace, pas du texte, donc elle vit ici ;
 *  2. **le texte** — `judgeConclusion` (`lib/quality/conclusion.ts`) : forme, langue,
 *     **juxtaposition en prose**, reprise de la question. La barrière est un module pur,
 *     partagé avec le validateur et les tests : ce que le serveur filtre est exactement
 *     ce que l'évaluateur juge. Le service n'en réimplémente aucune règle — la première
 *     version de la règle de juxtaposition a dû être corrigée précisément parce qu'elle
 *     n'était mesurée que d'un côté.
 *
 * Une conclusion refusée consomme son étape et reste visible dans la trace : le modèle
 * peut se reprendre dans le budget restant (`failed` + raison), et l'enquête échoue au
 * bout du budget si elle n'a rien produit de recevable — jamais un énoncé creux.
 */
function applyAction(
  action: InvestigationActionOutput,
  ctx: {
    index: CorpusIndex;
    stepIndex: number;
    pageSize: number;
    catalogueSize: number;
    catalogue: CatalogueEntry[];
    known: Set<string>;
    /** Étapes déjà effectuées : ce qui a été exploré, et ce qui a été refusé. */
    priorSteps: InvestigationStep[];
    /** L'énoncé de départ — la conclusion ne peut pas le recopier. */
    claim: string;
  }
): InvestigationStep {
  const { index, stepIndex, pageSize, catalogueSize, catalogue, known, priorSteps, claim } = ctx;

  if (action.action === "search" || action.action === "expand") {
    const step: InvestigationStep = {
      index: stepIndex,
      action: action.action,
      input:
        action.action === "search"
          ? { query: action.query ?? "" }
          : { fragment: action.fragment as number },
      added: [],
      observation: [],
      failed: false,
    };
    let candidates: IndexedFragment[];
    if (action.action === "expand") {
      const base = catalogue.find((e) => e.index === action.fragment);
      if (!base) {
        step.failed = true;
        step.failure = "indice_hors_catalogue";
        return step;
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
    return step;
  }

  if (action.action === "conclude") {
    const citations = action.citations ?? [];
    const base = {
      index: stepIndex,
      action: "conclude" as const,
      input: {},
      added: [],
      observation: [],
      answer: action.answer,
      citations,
    };
    // AC2 d'abord : citer un fragment jamais montré est une citation invalide. L'étape
    // est marquée failed et sa conclusion n'est **jamais** présentée comme une preuve.
    const unknown = citations.filter((i) => !catalogue.some((e) => e.index === i));
    if (unknown.length > 0) {
      return { ...base, failed: true, failure: "citation_hors_catalogue" };
    }
    // Règle **de run** : rien n'a été exploré — le corpus n'a pas été regardé au-delà des graines
    const explored = priorSteps.some(
      (s) => !s.failed && (s.action === "search" || s.action === "expand")
    );
    if (!explored) return { ...base, failed: true, failure: "conclusion_sans_exploration" };
    // Règles de texte : forme, langue, juxtaposition en prose, reprise de la question.
    // Le motif rendu est celui de la barrière partagée — celui que le validateur recalcule.
    const verdict = judgeConclusion({ answer: action.answer ?? "", claim });
    if (!verdict.ok) return { ...base, failed: true, failure: verdict.reason };
    return { ...base, failed: false };
  }

  // inatteignable : le schéma Zod n'accepte que les trois actions ci-dessus
  return {
    index: stepIndex,
    action: "invalid",
    input: {},
    added: [],
    observation: [],
    failed: true,
    failure: "action_inconnue",
  };
}

/**
 * Refus de conclusion que le modèle peut corriger dans le budget restant : il consomme
 * l'étape, mais ne termine pas l'enquête. À l'inverse, une citation invalide (AC2) est
 * terminale : la conclusion portait sur un fragment jamais montré.
 *
 * La liste couvre **tous** les motifs de `judgeConclusion` (`conclusion-v2`) : un motif
 * qui n'y figure pas tuerait l'enquête au premier refus, alors que le prompt promet au
 * modèle qu'il peut se reprendre — et un refus non terminal est ce qui fait la valeur
 * de la règle (elle instruit, elle ne jette pas).
 */
const RETRYABLE_CONCLUSION_FAILURES: ReadonlySet<string> = new Set<
  ConclusionRejection | "conclusion_sans_exploration"
>([
  "conclusion_sans_exploration",
  "conclusion_recopie_la_question",
  "conclusion_juxtaposition",
  "conclusion_generique",
  "conclusion_langue",
  "conclusion_hors_format",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
