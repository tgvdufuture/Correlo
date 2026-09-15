import type { Db } from "@/lib/db/client";
import { nowIso } from "@/lib/db/client";

export type DiscoverRunStatus = "running" | "done" | "failed";
export type SamplerMode = "diversified" | "top6";

/**
 * Identité persistée d'un run `discover` (Phase 2B, AC1).
 *
 * Avant la migration 005, `run_id` / `corpus_hash` / `seed` ne vivaient que dans
 * `jobs.progress_json` (écrasé au moindre upsert) et dans un fichier écrit par le
 * CLI : rejouer « le même » run dépendait donc d'un payload de job, pas de la base.
 */
export interface DiscoverRunRow {
  run_id: string;
  job_id: string | null;
  status: DiscoverRunStatus;
  sampler: SamplerMode;
  sampler_version: string;
  corpus_hash: string;
  seed: string;
  prompt_version: string;
  chat_model: string;
  /** JSON (uuid[]) — corpus figé du run. */
  source_ids: string;
  pairs: number;
  batch_calls: number;
  batch_calls_from_cache: number;
  created: number;
  /** JSON (uuid[]) — sortie du run (rattachée aussi lors d'un rejeu identique). */
  created_ids: string;
  /** JSON — compteurs de rejets. */
  skipped: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface StartRunInput {
  runId: string;
  jobId?: string | null;
  sampler: SamplerMode;
  samplerVersion: string;
  corpusHash: string;
  seed: string;
  promptVersion: string;
  chatModel: string;
  sourceIds: string[];
}

export interface FinishRunInput {
  pairs: number;
  batchCalls: number;
  batchCallsFromCache: number;
  /** Sortie du run (rejeu inclus) — `created` en est dérivé. */
  createdIds: string[];
  skipped: unknown;
}

export interface DiscoverRunsRepo {
  /**
   * Ouverture du run : upsert par `run_id`, compteurs remis à zéro.
   * Un rejeu met donc à jour **sa** ligne — il ne crée pas un run de plus.
   */
  startRun(input: StartRunInput): void;
  finishRun(runId: string, input: FinishRunInput): boolean;
  /** Run épuisé (max attempts) — l'identité reste consultable avec son erreur. */
  failRun(runId: string, error: string): boolean;
  getByRun(runId: string): DiscoverRunRow | null;
  list(): DiscoverRunRow[];
}

export function createDiscoverRunsRepo(db: Db): DiscoverRunsRepo {
  const start = db.prepare(
    `INSERT INTO discover_runs (run_id, job_id, status, sampler, sampler_version,
       corpus_hash, seed, prompt_version, chat_model, source_ids,
       pairs, batch_calls, batch_calls_from_cache, created, created_ids, skipped,
       error, started_at, completed_at)
     VALUES (@run_id, @job_id, 'running', @sampler, @sampler_version,
       @corpus_hash, @seed, @prompt_version, @chat_model, @source_ids,
       0, 0, 0, 0, '[]', '{}', NULL, @started_at, NULL)
     ON CONFLICT(run_id) DO UPDATE SET
       job_id = excluded.job_id,
       status = 'running',
       sampler = excluded.sampler,
       sampler_version = excluded.sampler_version,
       corpus_hash = excluded.corpus_hash,
       seed = excluded.seed,
       prompt_version = excluded.prompt_version,
       chat_model = excluded.chat_model,
       source_ids = excluded.source_ids,
       pairs = 0,
       batch_calls = 0,
       batch_calls_from_cache = 0,
       created = 0,
       created_ids = '[]',
       skipped = '{}',
       error = NULL,
       started_at = excluded.started_at,
       completed_at = NULL`
  );

  return {
    startRun(input: StartRunInput): void {
      start.run({
        run_id: input.runId,
        job_id: input.jobId ?? null,
        sampler: input.sampler,
        sampler_version: input.samplerVersion,
        corpus_hash: input.corpusHash,
        seed: input.seed,
        prompt_version: input.promptVersion,
        chat_model: input.chatModel,
        source_ids: JSON.stringify(input.sourceIds),
        started_at: nowIso(),
      });
    },

    finishRun(runId, input): boolean {
      const res = db
        .prepare(
          `UPDATE discover_runs SET status = 'done', pairs = ?, batch_calls = ?,
             batch_calls_from_cache = ?, created = ?, created_ids = ?, skipped = ?,
             error = NULL, completed_at = ?
           WHERE run_id = ?`
        )
        .run(
          input.pairs,
          input.batchCalls,
          input.batchCallsFromCache,
          input.createdIds.length,
          JSON.stringify(input.createdIds),
          JSON.stringify(input.skipped ?? {}),
          nowIso(),
          runId
        );
      return res.changes === 1;
    },

    failRun(runId, error): boolean {
      const res = db
        .prepare(
          `UPDATE discover_runs SET status = 'failed', error = ?, completed_at = ?
           WHERE run_id = ?`
        )
        .run(error, nowIso(), runId);
      return res.changes === 1;
    },

    getByRun(runId) {
      return (
        (db.prepare("SELECT * FROM discover_runs WHERE run_id = ?").get(runId) as
          | DiscoverRunRow
          | undefined) ?? null
      );
    },

    list() {
      return db
        .prepare("SELECT * FROM discover_runs ORDER BY started_at, rowid")
        .all() as DiscoverRunRow[];
    },
  };
}
