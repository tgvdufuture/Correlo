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
import { SummaryService } from "@/lib/ingest/summary-service";
import { DiscoveryService } from "@/lib/discover/discovery-service";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { SynthesisService, type SynthesisRunResult } from "@/lib/synth/synth-service";
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
  /** Kind synthesize (Phase 5A) — optionnel pour les tests existants. */
  synthesize?: SynthesisService;
  maxAttempts?: number;
  concurrency?: number;
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
      } else {
        const retryAfter =
          err instanceof LlmRateLimitError ? err.retryAfterSeconds : undefined;
        const nextRun = new Date(Date.now() + backoffDelayMs(row.attempts, retryAfter));
        this.deps.jobs.requeue(job.id, row.lease_token as string, nextRun.toISOString());
      }
    }
  }

  /** Job discover (Phase 2A) : pipeline complet, métadonnées de run dans progress_json. */
  private async runDiscover(job: ClaimedJob, discover: DiscoveryService): Promise<void> {
    const payload = JSON.parse(job.payload) as {
      run_id: string;
      source_ids: string[];
      sampler?: "diversified" | "top6";
      max_pairs?: number;
      max_pairs_per_source?: number;
      batch_size?: number;
      max_fragment_chars?: number;
      inter_batch_delay_ms?: number;
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
        sampler: payload.sampler ?? "diversified",
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
    const summary = {
      run_id: result.runId,
      corpus_hash: result.corpusHash,
      seed: result.seed,
      sampler: result.sampler,
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
  const ingestDeps: IngestDeps = {
    db,
    sources,
    fragments,
    jobs,
    embedder,
    chatModel: getChatModelName(),
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
  const synthesize = new SynthesisService({
    db,
    themes: createThemesRepo(db),
    syntheses: createSynthesesRepo(db),
    chat: llm,
    chatModel: getChatModelName(),
    chatSignature,
    promptCache,
  });
  return new Worker({ jobs, ingest, summary, discover, synthesize });
}