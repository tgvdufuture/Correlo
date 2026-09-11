import { describe, expect, it } from "vitest";
import { makeFakeEmbedder, makeTestDb, makeTextSource, FakeLlm } from "./helpers";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createJobsRepo, idempotencyKey } from "@/lib/repositories/jobs";
import { IngestService } from "@/lib/ingest/ingest-service";
import { SummaryService, SUMMARY_PROMPT_VERSION } from "@/lib/ingest/summary-service";
import { Worker } from "@/lib/jobs/worker";
import { EmbeddingService } from "@/lib/ingest/embedding-service";
import { sha256Hex } from "@/lib/hash";

function build(db: ReturnType<typeof makeTestDb>["db"], groqKeyMissing = false) {
  const sources = createSourcesRepo(db);
  const fragments = createFragmentsRepo(db);
  const jobs = createJobsRepo(db);
  const llm = new FakeLlm(8);
  const summary = new SummaryService({ db, sources, jobs, llm, chatModel: "test-model", groqKeyMissing });
  const ingest = new IngestService({
    db,
    sources,
    fragments,
    jobs,
    embedder: makeFakeEmbedder(8),
    chatModel: "test-model",
  });
  return { sources, fragments, jobs, summary, ingest, llm };
}

function enqueueSummary(
  jobs: ReturnType<typeof createJobsRepo>,
  sourceId: string,
  contentHash: string
) {
  return jobs.createJob({
    kind: "summary",
    payload: { source_id: sourceId },
    sourceId,
    idempotencyKey: idempotencyKey(["summary", sourceId, contentHash, "test-model", SUMMARY_PROMPT_VERSION]),
  });
}

describe("résumé (summary)", () => {
  it("sans clé Groq : failed structuré missing_groq_api_key, 0 retry (US-10 AC3)", async () => {
    const { db } = makeTestDb();
    const { sources, jobs, summary } = build(db, true);
    const sourceId = makeTextSource(db, "Texte suffisamment long pour le résumé. ".repeat(20));
    enqueueSummary(jobs, sourceId, sha256Hex("Texte suffisamment long pour le résumé. ".repeat(20)));
    const [claimed] = jobs.claim(1);
    await summary.runSummary(claimed);

    const job = jobs.getById(claimed.id);
    expect(job?.status).toBe("failed");
    const err = JSON.parse(job?.error as string) as { code: string };
    expect(err.code).toBe("missing_groq_api_key");
    expect(sources.getById(sourceId)?.summary_status).toBe("failed");
    // 0 retry : le job n'a pas été repassé pending
    expect(jobs.claim(1)).toHaveLength(0);
  });

  it("succès : summary_status done + résumé stocké", async () => {
    const { db } = makeTestDb();
    const { sources, jobs, summary } = build(db);
    const raw = "Texte suffisamment long pour le résumé. ".repeat(20);
    const sourceId = makeTextSource(db, raw);
    enqueueSummary(jobs, sourceId, sha256Hex(raw));
    const [claimed] = jobs.claim(1);
    await summary.runSummary(claimed);

    expect(jobs.getById(claimed.id)?.status).toBe("done");
    const src = sources.getById(sourceId);
    expect(src?.summary_status).toBe("done");
    expect(src?.summary).toBe("Résumé de test.");
  });

  it("contenu trop court (URL en cours d'ingestion) : requeue sans consommer d'attempt", async () => {
    const { db } = makeTestDb();
    const { sources, jobs, summary } = build(db);
    const placeholder = sha256Hex("url:https://exemple.fr/lent");
    sources.create({
      id: "url-lent",
      type: "URL",
      title: "https://exemple.fr/lent",
      canonical_path: "https://exemple.fr/lent",
      raw_content: "",
      content_hash: placeholder,
    });
    enqueueSummary(jobs, "url-lent", placeholder);
    const [claimed] = jobs.claim(1);
    await summary.runSummary(claimed);

    const job = jobs.getById(claimed.id);
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(1); // le claim a incrémenté, pas le requeue
    expect(new Date(job?.next_run_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("worker : max 5 attempts puis failed visible", async () => {
    const { db } = makeTestDb();
    const { sources, fragments, jobs } = build(db);
    // embedder qui échoue toujours → ingestion impossible
    const failing = new IngestService({
      db,
      sources,
      fragments,
      jobs,
      embedder: new EmbeddingService(
        new (class extends FakeLlm {
          override async embed(): Promise<number[]> {
            throw new Error("Ollama down (simulé)");
          }
        })(8),
        { model: "test-model", dimensions: 8, version: "test-v1" }
      ),
      chatModel: "test-model",
    });
    const worker = new Worker({ jobs, ingest: failing, summary: build(db).summary });
    const sourceId = makeTextSource(db, "Texte assez long. ".repeat(100));
    jobs.createJob({
      kind: "ingest",
      payload: { source_id: sourceId },
      sourceId,
      idempotencyKey: "test-ingest-fail",
    });

    // 5 réclamations (avec horloge avancée pour dépasser le backoff)
    const future = () => new Date(Date.now() + 3600_000);
    for (let i = 0; i < 5; i++) {
      const [claimed] = jobs.claim(1, future());
      expect(claimed).toBeDefined();
      await worker.process(claimed);
    }
    const job = db.prepare("SELECT * FROM jobs WHERE idempotency_key = 'test-ingest-fail'").get() as {
      status: string;
      attempts: number;
      error: string;
    };
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(5);
    expect(JSON.parse(job.error).message).toContain("Ollama down");
  });
});