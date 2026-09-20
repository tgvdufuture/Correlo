import { getConfig } from "@/lib/config/env";
import { getDb } from "@/lib/db/client";
import {
  getChatModelName,
  getChatSignature,
  getLlm,
  isGroqKeyMissing,
  embeddingMeta,
} from "@/lib/llm/llm";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { backoffDelayMs, MAX_ATTEMPTS, type ClaimedJob, type JobsRepo, createJobsRepo } from "@/lib/repositories/jobs";
import { IngestService, JobStolenError, type IngestDeps } from "@/lib/ingest/ingest-service";
import { EmbeddingService } from "@/lib/ingest/embedding-service";
import { reembedCorpus, type ReembedOptions, type ReembedResult } from "@/lib/ingest/reembed-service";
import { SummaryService } from "@/lib/ingest/summary-service";
import { DiscoveryService } from "@/lib/discover/discovery-service";
import { SAMPLER_VERSION } from "@/lib/discover/sampler";
import { DISCOVERY_PROMPT_VERSION } from "@/lib/discover/prompts";
import { createDiscoverRunsRepo, type DiscoverRunsRepo } from "@/lib/repositories/discover-runs";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { SynthesisService, type SynthesisRunResult } from "@/lib/synth/synth-service";
import { InvestigationService } from "@/lib/agent/investigation-service";
import {
  ConversationService,
  type ConversationRunResult,
} from "@/lib/agent/conversation-service";
import { createInvestigationsRepo } from "@/lib/repositories/investigations";
import { createWebTools } from "@/lib/agent/web-tools";
import { createConversationsRepo } from "@/lib/repositories/conversations";
import { createThemesRepo } from "@/lib/repositories/themes";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import { createPromptCache } from "@/lib/repositories/llm-cache";
import { LlmRateLimitError } from "@/lib/llm/errors";

/** Fréquence de récupération des jobs dont le lease a expiré. */
const LEASE_REAP_INTERVAL_MS = 30_000;

export interface WorkerDeps {
  jobs: JobsRepo;
  ingest: IngestService;
  summary: SummaryService;
  /** Kind discover (Phase 2A) — optionnel pour les tests existants. */
  discover?: DiscoveryService;
  /** Métadonnées de run discover (Phase 2B, AC1) — optionnel : sans lui, le run
   *  n'est décrit que par `progress_json` (comportement d'avant la 005). */
  discoverRuns?: DiscoverRunsRepo;
  /** Kind synthesize (Phase 5A) — optionnel pour les tests existants. */
  synthesize?: SynthesisService;
  /** Kind reembed (re-vectorisation du corpus) — optionnel pour les tests existants. */
  reembed?: ReembedRunner;
  /** Kind investigation (Phase 4, US-09) — optionnel pour les tests existants. */
  investigation?: InvestigationService;
  /** Kind conversation (Phase 6) — optionnel pour les tests existants. */
  conversation?: ConversationService;
  maxAttempts?: number;
  concurrency?: number;
}

/**
 * Capacité de re-vectorisation telle que le worker la consomme.
 *
 * Une interface (et non l'appel direct à `reembedCorpus`) pour que le worker reste
 * testable sans base ni réseau : un test fournit un objet qui expose `run`. Le vrai
 * câblage est dans `createWorker`. 
 */
export interface ReembedRunner {
  run(opts: ReembedOptions): Promise<ReembedResult>;
}

/**
 * Worker de jobs : concurrence 1–2, lease + token, backoff + jitter,
 * Retry-After respecté (429), max 5 attempts puis failed visible.
 */
export class Worker {
  private stopped = false;

  constructor(private deps: WorkerDeps) {}

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    const concurrency = this.deps.concurrency ?? 2;
    // Reaper de leases : sans lui, un job `running` dont le lease expire (process tué,
    // worker recyclé par HMR, machine en veille) reste bloqué jusqu'au prochain boot.
    // Le timer est indépendant de la boucle de claim, qui peut être retenue par un job.
    const reapTimer = setInterval(() => {
      try {
        const n = this.deps.jobs.recoverExpiredLeases();
        if (n > 0) console.warn(`[worker] ${n} job(s) au lease expiré remis en file`);
      } catch (e) {
        console.error(`[worker] reaper : ${(e as Error).message}`);
      }
    }, LEASE_REAP_INTERVAL_MS);
    try {
      while (!this.stopped) {
        const claimed = this.deps.jobs.claim(concurrency);
        if (claimed.length === 0) {
          await sleep(1000);
          continue;
        }
        await Promise.all(claimed.map((j) => this.process(j)));
      }
    } finally {
      clearInterval(reapTimer);
    }
  }

  /** Exécute un job réclamé (public pour les tests). */
  async process(job: ClaimedJob): Promise<void> {
    try {
      if (job.kind === "ingest") await this.deps.ingest.runIngest(job);
      else if (job.kind === "summary") await this.deps.summary.runSummary(job);
      else if (job.kind === "discover") {
        if (!this.deps.discover) throw new Error("kind discover non câblé");
        await this.runDiscover(job, this.deps.discover);
      } else if (job.kind === "synthesize") {
        if (!this.deps.synthesize) throw new Error("kind synthesize non câblé");
        await this.runSynthesize(job, this.deps.synthesize);
      } else if (job.kind === "reembed") {
        if (!this.deps.reembed) throw new Error("kind reembed non câblé");
        await this.runReembed(job, this.deps.reembed);
      } else if (job.kind === "investigation") {
        if (!this.deps.investigation) throw new Error("kind investigation non câblé");
        await this.runInvestigation(job, this.deps.investigation);
      } else if (job.kind === "conversation") {
        if (!this.deps.conversation) throw new Error("kind conversation non câblé");
        await this.runConversation(job, this.deps.conversation);
      } else throw new Error(`kind de job inconnu : ${job.kind}`);
    } catch (err) {
      if (err instanceof JobStolenError) return; // lease repris ailleurs : ne rien écrire
      const row = this.deps.jobs.getById(job.id);
      if (!row) return;
      // observabilité : les échecs sont visibles en DB et dans le log serveur
      console.error(`[worker] job ${job.kind}/${job.id} : ${(err as Error).message}`);
      const errorJson = serializeError(err);
      const maxAttempts = this.deps.maxAttempts ?? MAX_ATTEMPTS;
      if (row.attempts >= maxAttempts) {
        this.deps.jobs.fail(job.id, row.lease_token as string, errorJson);
        // résumé définitivement échoué ⇒ summary_status visible (US-04)
        if (job.kind === "summary") {
          const payload = JSON.parse(job.payload) as { source_id: string };
          this.deps.summary.markSourceSummaryFailed(payload.source_id);
        }
        // run discover épuisé : son identité reste consultable avec l'erreur. Une
        // simple reprise (tentatives restantes) ne le marque PAS : il reste
        // reprenable au checkpoint, donc `running`.
        if (job.kind === "discover") {
          const runId = runIdOf(job.payload);
          if (runId) this.deps.discoverRuns?.failRun(runId, (err as Error).message);
        }
      } else {
        const retryAfter =
          err instanceof LlmRateLimitError ? err.retryAfterSeconds : undefined;
        const nextRun = new Date(Date.now() + backoffDelayMs(row.attempts, retryAfter));
        this.deps.jobs.requeue(job.id, row.lease_token as string, nextRun.toISOString());
      }
    }
  }

  /**
   * Job discover (Phase 2A → 2B) : pipeline complet, identité du run persistée
   * dans `discover_runs` (migration 005) **et** compteurs repris par le checkpoint.
   */
  private async runDiscover(job: ClaimedJob, discover: DiscoveryService): Promise<void> {
    const payload = JSON.parse(job.payload) as {
      run_id: string;
      source_ids: string[];
      sampler?: "diversified" | "top6";
      focus_source_ids?: string[];
      max_pairs?: number;
      max_pairs_per_source?: number;
      batch_size?: number;
      max_fragment_chars?: number;
      inter_batch_delay_ms?: number;
      /** Seed imposée (rejeu d'un run archivé sous un identifiant neuf). */
      seed?: string;
    };
    if (!Array.isArray(payload.source_ids) || payload.source_ids.length === 0) {
      throw new Error("payload discover invalide : source_ids requis");
    }
    // reprise au checkpoint : un run interrompu ne rejoue pas les batchs déjà traités
    // et récupère les compteurs cumulés de la tentative précédente (rapport complet)
    let startBatch = 0;
    if (job.checkpoint) {
      const cp = JSON.parse(job.checkpoint) as { done_batches?: number };
      if (typeof cp.done_batches === "number") startBatch = cp.done_batches;
    }
    type ResumeCounters = {
      created_ids?: string[];
      batch_calls?: number;
      batch_calls_from_cache?: number;
      skipped?: Record<string, number>;
    };
    let resume: ResumeCounters | undefined;
    if (startBatch > 0 && job.progress_json) {
      const prev = JSON.parse(job.progress_json) as ResumeCounters;
      resume = {
        created_ids: prev.created_ids ?? [],
        batch_calls: prev.batch_calls ?? 0,
        batch_calls_from_cache: prev.batch_calls_from_cache ?? 0,
        skipped: prev.skipped ?? {},
      };
    }
    // lease renouvelé pendant tout le run (LEASE_MS=60 s, run=15-25 min) :
    // sans cela un job long reste running à vie si le process est redémarré
    const leaseTimer = setInterval(() => {
      this.deps.jobs.renewLease(job.id, job.lease_token as string);
    }, 30_000);
    let result: Awaited<ReturnType<DiscoveryService["run"]>>;
    try {
      result = await discover.run(payload.source_ids, {
        runId: payload.run_id,
        seed: payload.seed,
        sampler: payload.sampler ?? "diversified",
        focusSources: payload.focus_source_ids,
        maxPairs: payload.max_pairs,
        maxPairsPerSource: payload.max_pairs_per_source,
        batchSize: payload.batch_size,
        maxFragmentChars: payload.max_fragment_chars,
        // fenêtre ITPM du provider (Groq free = 7 000 tokens/min) : 65 s par défaut,
        // réglable (ex. 35 s avec troncature → 2 batchs/min)
        interBatchDelayMs: payload.inter_batch_delay_ms ?? 65_000,
        startBatch,
        resume: resume
          ? {
              createdIds: resume.created_ids,
              batchCalls: resume.batch_calls,
              batchCallsFromCache: resume.batch_calls_from_cache,
              skipped: resume.skipped,
            }
          : undefined,
        // identité du run (corpus_hash, seed, versions) publiée avant le premier
        // appel LLM : c'est la ligne que la Phase 2B exige de retrouver en base
        onStarted: (info) => {
          this.deps.discoverRuns?.startRun({
            runId: info.runId,
            jobId: job.id,
            sampler: info.sampler,
            samplerVersion: info.samplerVersion,
            corpusHash: info.corpusHash,
            seed: info.seed,
            promptVersion: info.promptVersion,
            chatModel: info.chatModel,
            sourceIds: info.sourceIds,
          });
        },
        onProgress: (info) => {
          this.deps.jobs.updateCheckpoint(
            job.id,
            job.lease_token as string,
            JSON.stringify({ done_batches: info.processed, total_pairs: info.total }),
            JSON.stringify({
              processed: info.processed,
              total: info.total,
              created: info.created,
              created_ids: info.createdIds,
              batch_calls: info.batchCalls,
              batch_calls_from_cache: info.batchCallsFromCache,
              skipped: info.skipped,
            })
          );
        },
      });
    } finally {
      clearInterval(leaseTimer);
    }
    // sortie du run persistée (identité + compteurs) : `discover_runs` devient la
    // source de vérité, `progress_json` n'en est plus qu'une copie de commodité
    this.deps.discoverRuns?.finishRun(result.runId, {
      pairs: result.pairsTotal,
      batchCalls: result.batchCalls,
      batchCallsFromCache: result.batchCallsFromCache,
      createdIds: result.createdIds,
      skipped: result.skipped,
    });
    const summary = {
      run_id: result.runId,
      corpus_hash: result.corpusHash,
      seed: result.seed,
      sampler: result.sampler,
      sampler_version: result.samplerVersion,
      pairs: result.pairsTotal,
      batch_calls: result.batchCalls,
      batch_calls_from_cache: result.batchCallsFromCache,
      created: result.createdIds.length,
      created_ids: result.createdIds,
      skipped: result.skipped,
    };
    this.deps.jobs.updateCheckpoint(
      job.id,
      job.lease_token as string,
      JSON.stringify({ done: true }),
      JSON.stringify(summary)
    );
    if (!this.deps.jobs.complete(job.id, job.lease_token as string)) {
      throw new JobStolenError();
    }
  }

  /**
   * Job synthesize (Phase 5A) : thèmes → preuves → 1 appel LLM par thème.
   *
   * En mode `baseline`, rien n'est persisté en base : les énoncés sont renvoyés
   * dans `progress_json.baseline_items` pour que le CLI les écrive hors base.
   */
  private async runSynthesize(job: ClaimedJob, synth: SynthesisService): Promise<void> {
    const payload = JSON.parse(job.payload) as {
      run_id: string;
      source_ids: string[];
      mode?: "synthesis" | "baseline";
      max_seeds?: number;
      max_seeds_per_source?: number;
      min_evidence?: number;
      max_evidence?: number;
      max_syntheses_per_seed?: number;
      max_evidence_chars?: number;
      inter_seed_delay_ms?: number;
    };
    if (!Array.isArray(payload.source_ids) || payload.source_ids.length === 0) {
      throw new Error("payload synthesize invalide : source_ids requis");
    }
    // reprise au checkpoint : un run interrompu reprend à la graine suivante, avec
    // les compteurs cumulés de la tentative précédente (rapport complet)
    let startSeed = 0;
    if (job.checkpoint) {
      const cp = JSON.parse(job.checkpoint) as { done_seeds?: number };
      if (typeof cp.done_seeds === "number") startSeed = cp.done_seeds;
    }
    type ResumeCounters = {
      created_ids?: string[];
      llm_calls?: number;
      llm_calls_from_cache?: number;
      skipped?: Record<string, number>;
      rejected_by_reason?: Record<string, number>;
      /** Baseline : énoncés déjà calculés, sans quoi une reprise les perdrait. */
      baseline_items?: SynthesisRunResult["syntheses"];
    };
    let resume: ResumeCounters | undefined;
    if (startSeed > 0 && job.progress_json) {
      const prev = JSON.parse(job.progress_json) as ResumeCounters;
      resume = {
        created_ids: prev.created_ids ?? [],
        llm_calls: prev.llm_calls ?? 0,
        llm_calls_from_cache: prev.llm_calls_from_cache ?? 0,
        skipped: prev.skipped ?? {},
        rejected_by_reason: prev.rejected_by_reason ?? {},
        baseline_items: prev.baseline_items ?? [],
      };
    }
    // lease renouvelé pendant tout le run (LEASE_MS = 60 s, run de plusieurs minutes)
    const leaseTimer = setInterval(() => {
      this.deps.jobs.renewLease(job.id, job.lease_token as string);
    }, 30_000);
    let result: Awaited<ReturnType<SynthesisService["run"]>>;
    try {
      result = await synth.run(payload.source_ids, {
        runId: payload.run_id,
        mode: payload.mode ?? "synthesis",
        startSeed,
        // `max_seeds` est le plafond **du run** : le service construit exactement ce
        // nombre de graines et traite [startSeed, total]. Une reprise (429, 503,
        // redémarrage) ne peut donc pas dépasser le plafond (constaté avant
        // correction : `--max-themes=12` avait traité 24 thèmes).
        totalSeeds: payload.max_seeds,
        maxSeedsPerSource: payload.max_seeds_per_source,
        minEvidence: payload.min_evidence,
        maxEvidence: payload.max_evidence,
        maxSynthesesPerSeed: payload.max_syntheses_per_seed,
        maxEvidenceChars: payload.max_evidence_chars,
        // même fenêtre de quota qu'en 2A : 1 appel/min par défaut (prompt ~3,5 k tokens)
        interSeedDelayMs: payload.inter_seed_delay_ms ?? 65_000,
        resume: resume
          ? {
              createdIds: resume.created_ids,
              llmCalls: resume.llm_calls,
              llmCallsFromCache: resume.llm_calls_from_cache,
              skipped: resume.skipped,
              rejectedByReason: resume.rejected_by_reason,
              baselineItems: resume.baseline_items,
            }
          : undefined,
        onProgress: (info) => {
          this.deps.jobs.updateCheckpoint(
            job.id,
            job.lease_token as string,
            JSON.stringify({ done_seeds: info.processed, total_seeds: info.total }),
            JSON.stringify({
              processed: info.processed,
              total: info.total,
              created: info.created,
              created_ids: info.createdIds,
              llm_calls: info.llmCalls,
              llm_calls_from_cache: info.llmCallsFromCache,
              skipped: info.skipped,
              // un baseline n'existe nulle part ailleurs : le checkpoint le transporte,
              // sinon une reprise repart sans les résumés déjà calculés
              baseline_items: info.baselineItems,
            })
          );
        },
      });
    } finally {
      clearInterval(leaseTimer);
    }
    const summary = {
      run_id: result.runId,
      mode: result.mode,
      corpus_hash: result.corpusHash,
      seed: result.seed,
      seeds_total: result.seedsTotal,
      seed_ids: result.seedIds,
      llm_calls: result.llmCalls,
      llm_calls_from_cache: result.llmCallsFromCache,
      created: result.createdIds.length,
      created_ids: result.createdIds,
      skipped: result.skipped,
      rejected_by_reason: result.rejectedByReason,
      // un baseline n'écrit rien en base : ses énoncés sont transportés ici
      baseline_items: result.mode === "baseline" ? result.syntheses : undefined,
    };
    this.deps.jobs.updateCheckpoint(
      job.id,
      job.lease_token as string,
      JSON.stringify({ done: true }),
      JSON.stringify(summary)
    );
    if (!this.deps.jobs.complete(job.id, job.lease_token as string)) {
      throw new JobStolenError();
    }
  }

  /**
   * Job investigation (Phase 4, US-09) : un agent, ≤ 5 étapes, citations vérifiées.
   *
   * Pas de checkpoint : le run est **court** (≤ 5 appels) et le cache de prompt rend un
   * rejeu gratuit et identique — la reprise au checkpoint existe en 2A/5A parce que ces
   * runs durent des dizaines de minutes, ce qui n'est pas le cas ici. L'`id` de
   * l'investigation est celui du job : un rejeu met à jour la ligne au lieu d'en créer
   * une seconde (colonne `job_id` inexistante dans le schéma verrouillé).
   */
  private async runInvestigation(job: ClaimedJob, service: InvestigationService): Promise<void> {
    const payload = JSON.parse(job.payload) as {
      suggestion_id: string;
      max_steps?: number;
      page_size?: number;
      catalogue_size?: number;
      max_fragment_chars?: number;
    };
    if (!payload.suggestion_id) {
      throw new Error("payload investigation invalide : suggestion_id requis");
    }
    // lease renouvelé : même court, le run enchaîne plusieurs appels LLM lents
    const leaseTimer = setInterval(() => {
      this.deps.jobs.renewLease(job.id, job.lease_token as string);
    }, 30_000);
    let result: Awaited<ReturnType<InvestigationService["run"]>>;
    try {
      result = await service.run(payload.suggestion_id, {
        investigationId: job.id,
        maxSteps: payload.max_steps,
        pageSize: payload.page_size,
        catalogueSize: payload.catalogue_size,
        maxFragmentChars: payload.max_fragment_chars,
      });
    } finally {
      clearInterval(leaseTimer);
    }
    const summary = {
      investigation_id: result.investigationId,
      suggestion_id: payload.suggestion_id,
      status: result.status,
      steps: result.steps,
      llm_calls: result.llmCalls,
      llm_calls_from_cache: result.llmCallsFromCache,
      citations: result.citations,
      failure: result.failure,
    };
    this.deps.jobs.updateCheckpoint(
      job.id,
      job.lease_token as string,
      JSON.stringify({ done: true }),
      JSON.stringify(summary)
    );
    // Une enquête qui n'a pas conclu est un résultat, pas une panne : le job est
    // `done` et le statut réel vit dans `investigations.status` (l'erreur du job,
    // elle, est réservée aux pannes — suggestion disparue, provider en échec).
    if (!this.deps.jobs.complete(job.id, job.lease_token as string)) {
      throw new JobStolenError();
    }
  }

  /**
   * Job reembed : re-vectorise le corpus dans l'espace **actif** (bascule de
   * connecteur d'embeddings Ollama ↔ API).
   *
   * Les compteurs vont dans `progress_json` (ce que suit `npm run reembed`) et le
   * **diagnostic** — espaces avant/après, fragments sautés — dans le résumé final :
   * c'est lui qui distingue « le corpus est passé à 2 048 dims » de « le job a
   * tourné mais le provider a rendu autre chose ». Un échec au milieu laisse le
   * corpus exploitable (une transaction par lot) et le job reprend au lot suivant
   * grâce au filtre de saut, sans intervention.
   */
  private async runReembed(job: ClaimedJob, reembed: ReembedRunner): Promise<void> {
    const payload = JSON.parse(job.payload) as {
      force?: boolean;
      source_ids?: string[];
      batch_size?: number;
    };
    // lease renouvelé : une re-vectorisation du corpus complet dure plusieurs minutes
    const leaseTimer = setInterval(() => {
      this.deps.jobs.renewLease(job.id, job.lease_token as string);
    }, 30_000);
    let result: ReembedResult;
    try {
      result = await reembed.run({
        force: payload.force === true,
        sourceIds: payload.source_ids,
        batchSize: payload.batch_size,
        shouldStop: () => this.stopped,
        onProgress: (info) => {
          this.deps.jobs.updateCheckpoint(
            job.id,
            job.lease_token as string,
            JSON.stringify({ done_batches: info.batches }),
            JSON.stringify({
              processed: info.processed,
              total: info.total,
              batches: info.batches,
            })
          );
        },
      });
    } finally {
      clearInterval(leaseTimer);
    }
    const summary = {
      space: result.space,
      from: result.from,
      to: result.to,
      candidates: result.candidates,
      processed: result.processed,
      batches: result.batches,
      skipped: result.skipped,
    };
    this.deps.jobs.updateCheckpoint(
      job.id,
      job.lease_token as string,
      JSON.stringify({ done: true }),
      JSON.stringify(summary)
    );
    if (!this.deps.jobs.complete(job.id, job.lease_token as string)) {
      throw new JobStolenError();
    }
  }

  /**
   * Job conversation (Phase 6) : un tour, ≤ 5 étapes internes, réponse **assemblée par
   * le serveur** à partir des affirmations du modèle.
   *
   * Pas de checkpoint, même raison que l'investigation : le tour fait au plus 5 appels et
   * le cache de prompt rend un rejeu gratuit et identique, donc une reprise au milieu
   * n'apporterait rien qu'un second chemin de code. L'`id` de la réponse est celui du job :
   * un rejeu met à jour la même ligne au lieu d'empiler une seconde réponse.
   *
   * Un tour qui n'a pas répondu est un **résultat**, pas une panne : la ligne `messages`
   * passe `failed` avec son motif, et le job reste `done`. L'erreur du job est réservée aux
   * vraies pannes (conversation disparue, provider en échec).
   */
  private async runConversation(job: ClaimedJob, service: ConversationService): Promise<void> {
    const payload = JSON.parse(job.payload) as {
      conversation_id: string;
      question_message_id: string;
      question: string;
      max_steps?: number;
      page_size?: number;
      catalogue_size?: number;
      max_fragment_chars?: number;
      history_messages?: number;
    };
    if (!payload.conversation_id || !payload.question_message_id || !payload.question) {
      throw new Error(
        "payload conversation invalide : conversation_id, question_message_id et question requis"
      );
    }
    // lease renouvelé : le tour enchaîne plusieurs appels LLM lents
    const leaseTimer = setInterval(() => {
      this.deps.jobs.renewLease(job.id, job.lease_token as string);
    }, 30_000);
    let result: ConversationRunResult;
    try {
      result = await service.run(payload.conversation_id, {
        messageId: job.id,
        questionMessageId: payload.question_message_id,
        question: payload.question,
        maxSteps: payload.max_steps,
        pageSize: payload.page_size,
        catalogueSize: payload.catalogue_size,
        maxFragmentChars: payload.max_fragment_chars,
        historyMessages: payload.history_messages,
      });
    } finally {
      clearInterval(leaseTimer);
    }
    const summary = {
      message_id: result.messageId,
      conversation_id: payload.conversation_id,
      status: result.status,
      steps: result.steps,
      // budgets séparés (AC5′) : un tour se juge sur ce qu'il a consommé de chaque côté
      internal_steps: result.internalSteps,
      web_steps: result.webSteps,
      web_unlocked: result.webUnlocked,
      web_unlock_reason: result.webUnlockReason,
      llm_calls: result.llmCalls,
      llm_calls_from_cache: result.llmCallsFromCache,
      claims: result.claims,
      unsourced: result.unsourced,
      failure: result.failure,
    };
    this.deps.jobs.updateCheckpoint(
      job.id,
      job.lease_token as string,
      JSON.stringify({ done: true }),
      JSON.stringify(summary)
    );
    if (!this.deps.jobs.complete(job.id, job.lease_token as string)) {
      throw new JobStolenError();
    }
  }
}

/** `run_id` d'un payload discover (payload illisible ⇒ undefined, jamais d'exception ici). */
function runIdOf(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { run_id?: string };
    return parsed.run_id;
  } catch {
    return undefined;
  }
}

function serializeError(err: unknown): string {
  if (err instanceof LlmRateLimitError) {
    return JSON.stringify({ code: "rate_limited", message: err.message });
  }
  const e = err as { code?: string; message?: string };
  return JSON.stringify({
    code: e?.code ?? "error",
    message: e?.message ?? String(err),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Câblage complet avec le vrai LLM (env) — utilisé au boot du serveur. */
export function createWorker(): Worker {
  const db = getDb();
  const sources = createSourcesRepo(db);
  const fragments = createFragmentsRepo(db);
  const jobs = createJobsRepo(db);
  const llm = getLlm();
  const embedder = new EmbeddingService(llm, embeddingMeta());
  const config = getConfig();
  const ingestDeps: IngestDeps = {
    db,
    sources,
    fragments,
    jobs,
    embedder,
    chatModel: getChatModelName(),
    // Découverte automatique après dépôt : l'ingestion d'un fichier rend ses liens
    // possibles, donc c'est elle qui déclenche le run — focalisé sur le fichier.
    discover: {
      enabled: config.AUTO_DISCOVER === "on",
      chatModel: getChatModelName(),
      samplerVersion: SAMPLER_VERSION,
      promptVersion: DISCOVERY_PROMPT_VERSION,
      maxPairs: config.AUTO_DISCOVER_MAX_PAIRS,
      maxPairsPerSource: config.AUTO_DISCOVER_MAX_PAIRS_PER_SOURCE,
      batchSize: config.AUTO_DISCOVER_BATCH_SIZE,
      maxFragmentChars: config.AUTO_DISCOVER_MAX_FRAGMENT_CHARS,
      interBatchDelayMs: config.AUTO_DISCOVER_INTER_BATCH_DELAY_MS,
    },
  };
  const ingest = new IngestService(ingestDeps);
  const summary = new SummaryService({
    db,
    sources,
    jobs,
    llm,
    chatModel: getChatModelName(),
    groqKeyMissing: isGroqKeyMissing(),
  });
  // Cache de prompt persisté : c'est ce qui rend un rejeu de run reproductible
  // (le modèle ne reformule pas la même question), donc ce qui permet à la dédup
  // `content_sig` de tenir l'exigence « rejouer un run n'insère 0 nouvelle synthèse ».
  const promptCache = createPromptCache(db);
  const chatSignature = getChatSignature();
  const discover = new DiscoveryService({
    db,
    suggestions: createSuggestionsRepo(db),
    chat: llm,
    chatModel: getChatModelName(),
    chatSignature,
    promptCache,
  });
  // Métadonnées de run (Phase 2B, AC1) : la base porte l'identité des runs discover,
  // rejouables à l'identique (PRIMARY KEY run_id, upsert au rejeu).
  const discoverRuns = createDiscoverRunsRepo(db);
  // Dépôt des synthèses partagé : le moteur de la 5A l'écrit, la conversation (Phase 6)
  // lit les preuves de la synthèse ancrée — une seule instance, une seule lecture.
  const syntheses = createSynthesesRepo(db);
  const synthesize = new SynthesisService({
    db,
    themes: createThemesRepo(db),
    syntheses,
    chat: llm,
    chatModel: getChatModelName(),
    chatSignature,
    promptCache,
  });
  // Investigation (Phase 4) : même cache de prompt que 2A/5A — un rejeu de la même
  // question ne rappelle pas le modèle, donc les étapes enregistrées restent celles
  // du premier passage (et non une reformulation).
  const investigation = new InvestigationService({
    db,
    investigations: createInvestigationsRepo(db),
    suggestions: createSuggestionsRepo(db),
    fragments,
    sources,
    chat: llm,
    chatModel: getChatModelName(),
    chatSignature,
    promptCache,
  });
  // Outils web (Phase 6, §13.4) : assemblés **une fois**, depuis les réglages. Sans
  // connecteur ou avec `WEB_ACCESS=off`, l'objet existe quand même (`enabled: false`) : le
  // tour enregistre alors *pourquoi* le web n'a pas été exposé, au lieu de laisser un
  // `false` muet que personne ne peut interpréter.
  const webTools = createWebTools({
    access: config.WEB_ACCESS,
    provider: config.SEARCH_PROVIDER,
    exaApiKey: config.EXA_API_KEY,
    maxSteps: config.WEB_MAX_STEPS,
    unlockMinEvidence: config.WEB_UNLOCK_MIN_EVIDENCE,
    searchResults: config.WEB_SEARCH_RESULTS,
  });
  // Conversation (Phase 6) : même cache de prompt que les autres kinds — le rejeu d'un
  // tour (reprise après un 503, `POST` rejoué) ne rappelle pas le modèle, donc la réponse
  // enregistrée reste celle du premier passage.
  const conversation = new ConversationService({
    db,
    conversations: createConversationsRepo(db),
    syntheses,
    fragments,
    sources,
    chat: llm,
    chatModel: getChatModelName(),
    chatSignature,
    promptCache,
    web: webTools,
  });
  // Re-vectorisation : le worker porte le même `embedder` que l'ingestion, donc la
  // bascule se fait dans l'espace exact que les prochains dépôts utiliseront.
  const reembed: ReembedRunner = {
    run: (opts) =>
      reembedCorpus(db, embedder, {
        batchSize: config.NVIDIA_EMBED_BATCH_SIZE,
        ...opts,
      }),
  };
  return new Worker({
    jobs,
    ingest,
    summary,
    discover,
    discoverRuns,
    synthesize,
    reembed,
    investigation,
    conversation,
  });
}