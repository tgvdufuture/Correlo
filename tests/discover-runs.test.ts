import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { createDiscoverRunsRepo } from "@/lib/repositories/discover-runs";

/**
 * Phase 2B, AC1 : l'identité d'un run discover est une **entité persistante**.
 * Avant la migration 005, elle ne survivait que dans `jobs.progress_json` — remis à
 * zéro au moindre upsert d'idempotency_key — et dans un fichier écrit par le CLI.
 */
function startInput(over: Partial<Parameters<ReturnType<typeof createDiscoverRunsRepo>["startRun"]>[0]> = {}) {
  return {
    runId: "run-1",
    jobId: "job-1",
    sampler: "diversified" as const,
    samplerVersion: "sampler-v1",
    corpusHash: "a".repeat(64),
    seed: "b".repeat(64),
    promptVersion: "discovery-v4",
    chatModel: "test-model",
    sourceIds: ["s1", "s2"],
    ...over,
  };
}

describe("repository discover_runs (Phase 2B, AC1)", () => {
  it("persiste run_id, corpus_hash, seed et sampler_version, puis la sortie du run", () => {
    const { db } = makeTestDb();
    const repo = createDiscoverRunsRepo(db);

    repo.startRun(startInput());
    const opened = repo.getByRun("run-1");
    expect(opened).toMatchObject({
      run_id: "run-1",
      job_id: "job-1",
      status: "running",
      sampler: "diversified",
      sampler_version: "sampler-v1",
      corpus_hash: "a".repeat(64),
      seed: "b".repeat(64),
      prompt_version: "discovery-v4",
      chat_model: "test-model",
      source_ids: JSON.stringify(["s1", "s2"]),
      created: 0,
      completed_at: null,
    });

    expect(
      repo.finishRun("run-1", {
        pairs: 48,
        batchCalls: 12,
        batchCallsFromCache: 0,
        createdIds: ["x1", "x2"],
        skipped: { duplicate: 3 },
      })
    ).toBe(true);
    const done = repo.getByRun("run-1");
    expect(done).toMatchObject({ status: "done", pairs: 48, batch_calls: 12, created: 2 });
    expect(JSON.parse(done?.created_ids as string)).toEqual(["x1", "x2"]);
    expect(JSON.parse(done?.skipped as string)).toEqual({ duplicate: 3 });
    expect(done?.completed_at).not.toBeNull();
  });

  /**
   * Cœur de l'AC1 : rejouer un run ne crée pas un run de plus. `run_id` est la clé
   * primaire, donc un rejeu met à jour **sa** ligne — l'historique ne peut pas
   * confondre deux tentatives avec deux runs.
   */
  it("un rejeu met à jour la même ligne et repart de compteurs nuls", () => {
    const { db } = makeTestDb();
    const repo = createDiscoverRunsRepo(db);
    repo.startRun(startInput());
    repo.finishRun("run-1", {
      pairs: 48,
      batchCalls: 12,
      batchCallsFromCache: 0,
      createdIds: ["x1", "x2"],
      skipped: { duplicate: 3 },
    });

    repo.startRun(startInput({ jobId: "job-1" }));
    const reopened = repo.getByRun("run-1");
    expect(reopened).toMatchObject({ status: "running", created: 0, pairs: 0, completed_at: null });
    expect(JSON.parse(reopened?.created_ids as string)).toEqual([]);
    expect(repo.list()).toHaveLength(1);
  });

  it("failRun conserve l'identité et l'erreur d'un run épuisé", () => {
    const { db } = makeTestDb();
    const repo = createDiscoverRunsRepo(db);
    repo.startRun(startInput());
    expect(repo.failRun("run-1", "HTTP 503")).toBe(true);
    expect(repo.getByRun("run-1")).toMatchObject({
      status: "failed",
      error: "HTTP 503",
      sampler_version: "sampler-v1",
      seed: "b".repeat(64),
    });
    expect(repo.list().map((r) => r.run_id)).toEqual(["run-1"]);
  });

  it("la migration 005 impose les valeurs de statut et de sampler", () => {
    const { db } = makeTestDb();
    const insert = (status: string, sampler: string) =>
      db
        .prepare(
          `INSERT INTO discover_runs (run_id, status, sampler, sampler_version, corpus_hash,
             seed, prompt_version, chat_model, source_ids, started_at)
           VALUES (?, ?, ?, 'sampler-v1', 'c', 'd', 'discovery-v4', 'test-model', '[]', '2026-09-15T00:00:00.000Z')`
        )
        .run(`r-${status}-${sampler}`, status, sampler);
    expect(() => insert("pending", "diversified")).toThrow(/CHECK constraint failed/);
    expect(() => insert("done", "aleatoire")).toThrow(/CHECK constraint failed/);
    expect(() => insert("done", "top6")).not.toThrow();
  });
});
