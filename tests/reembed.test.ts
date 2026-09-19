import { describe, expect, it } from "vitest";
import {
  FakeLlm,
  makeFragment,
  makeFakeEmbedder,
  makeTestDb,
  makeTextSource,
} from "./helpers";
import { reembedCorpus } from "@/lib/ingest/reembed-service";
import { EmbeddingService, EmbeddingValidationError } from "@/lib/ingest/embedding-service";
import { encodeEmbedding } from "@/lib/llm/embedding-codec";
import { listCorpusSpaces } from "@/lib/llm/embedding-space";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createJobsRepo, idempotencyKey, type ClaimedJob } from "@/lib/repositories/jobs";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { IngestService } from "@/lib/ingest/ingest-service";
import { SummaryService } from "@/lib/ingest/summary-service";
import { Worker } from "@/lib/jobs/worker";

/**
 * Re-vectorisation : l'autre moitié du contrat d'espace vectoriel. Ce que ces tests
 * verrouillent, c'est ce qui rend la commande utilisable sur un vrai corpus —
 * l'idempotence (un fragment à jour n'est pas repayé), la reprise après interruption,
 * et le fait qu'un lot en échec n'écrit **rien**.
 */

const FOREIGN = { model: "autre-modele", dims: 8, version: "autre-v1" };

/** LLM factice qui compte les appels (pour prouver qu'un lot à jour n'est pas repayé). */
class CountingLlm extends FakeLlm {
  calls = 0;
  override async embedMany(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return super.embedMany(texts);
  }
}

function insertFragment(
  db: ReturnType<typeof makeTestDb>["db"],
  opts: { sourceId: string; chunkIndex: number; text: string; model: string; dims: number; version: string }
): string {
  const repo = createFragmentsRepo(db);
  const id = `frag-${opts.sourceId}-${opts.chunkIndex}`;
  repo.insert({
    id,
    source_id: opts.sourceId,
    chunk_index: opts.chunkIndex,
    locator: "[0,10)",
    text: opts.text,
    embedding: encodeEmbedding(Array.from({ length: opts.dims }, () => 0.25), opts.dims),
    embedding_model: opts.model,
    embedding_dimensions: opts.dims,
    embedding_version: opts.version,
    chunker_version: "chunker-v1",
  });
  return id;
}

function countingEmbedder(dims = 8) {
  const llm = new CountingLlm(dims);
  const service = new EmbeddingService(llm, { model: "test-model", dimensions: dims, version: "test-v1" });
  return { llm, service };
}

describe("re-vectorisation du corpus", () => {
  it("convertit les fragments d'un autre espace et met à jour leurs métadonnées", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    const b = makeTextSource(db, "B", "B");
    insertFragment(db, { sourceId: a, chunkIndex: 0, text: "texte a", ...FOREIGN });
    insertFragment(db, { sourceId: b, chunkIndex: 0, text: "texte b", ...FOREIGN });

    const { llm, service } = countingEmbedder(8);
    const result = await reembedCorpus(db, service, { batchSize: 10 });

    expect(result.candidates).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.batches).toBe(1);
    expect(result.from).toHaveLength(1);
    expect(llm.calls).toBe(1);
    const row = db.prepare("SELECT * FROM fragments WHERE id = ?").get("frag-" + a + "-0") as {
      text: string;
      embedding: Buffer;
      embedding_model: string;
      embedding_dimensions: number;
      embedding_version: string;
    };
    expect(row.embedding_model).toBe("test-model");
    expect(row.embedding_dimensions).toBe(8);
    expect(row.embedding_version).toBe("test-v1");
    // le BLOB est bien ré-encodé en Float32 LE sur la bonne longueur
    expect(row.embedding.byteLength).toBe(8 * 4);
    // et le texte n'est jamais touché par une re-vectorisation
    expect(row.text).toBe("texte a");
  });

  it("saute les fragments déjà dans l'espace actif : aucun appel réseau", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    makeFragment(db, { sourceId: a, text: "a1", chunkIndex: 0 });
    makeFragment(db, { sourceId: a, text: "a2", chunkIndex: 1 });

    const { llm, service } = countingEmbedder(8);
    const result = await reembedCorpus(db, service);

    expect(result.candidates).toBe(0);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(llm.calls).toBe(0);
  });

  it("ne paie que les fragments hors espace dans un corpus mixte", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    makeFragment(db, { sourceId: a, text: "à jour 1", chunkIndex: 0 });
    makeFragment(db, { sourceId: a, text: "à jour 2", chunkIndex: 1 });
    insertFragment(db, { sourceId: a, chunkIndex: 2, text: "à convertir", ...FOREIGN });

    const { llm, service } = countingEmbedder(8);
    const result = await reembedCorpus(db, service);

    expect(result.candidates).toBe(1);
    expect(result.skipped).toBe(2);
    expect(llm.calls).toBe(1);
  });

  it("force ré-encode même les fragments déjà à jour", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    makeFragment(db, { sourceId: a, text: "a1", chunkIndex: 0 });

    const { llm, service } = countingEmbedder(8);
    const result = await reembedCorpus(db, service, { force: true });

    expect(result.candidates).toBe(1);
    expect(result.skipped).toBe(0);
    expect(llm.calls).toBe(1);
  });

  /**
   * Une interruption (arrêt du worker, redémarrage, coupure réseau) laisse le corpus
   * exploitable — une transaction par lot — et la relance **termine** le travail au
   * lieu de le refaire : c'est ce qui distingue une reprise d'un simple rejeu.
   */
  it("interruption coopérative : le lot suivant ne part pas, la relance termine", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    for (let i = 0; i < 4; i++) {
      insertFragment(db, { sourceId: a, chunkIndex: i, text: `t${i}`, ...FOREIGN });
    }

    const { llm, service } = countingEmbedder(8);
    let batches = 0;
    const first = await reembedCorpus(db, service, {
      batchSize: 2,
      shouldStop: () => batches >= 1,
      onProgress: () => {
        batches += 1;
      },
    });
    expect(first.processed).toBe(2);
    expect(first.batches).toBe(1);
    expect(listCorpusSpaces(db)).toHaveLength(2);

    const second = await reembedCorpus(db, service, { batchSize: 2 });
    expect(second.candidates).toBe(2);
    expect(second.processed).toBe(2);
    expect(second.skipped).toBe(2);
    // 1 appel avant l'arrêt + 1 pour le lot restant : les deux fragments déjà
    // convertis n'ont pas été repayés
    expect(llm.calls).toBe(2);
    // un seul espace subsiste : l'invariant des runs tient de nouveau
    expect(listCorpusSpaces(db)).toHaveLength(1);
  });

  it("un vecteur de mauvaise longueur n'écrit rien dans le lot", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    insertFragment(db, { sourceId: a, chunkIndex: 0, text: "t", ...FOREIGN });
    // provider à 16 dims pour un espace annoncé à 8 : incohérence détectée avant écriture
    const bad = new EmbeddingService(new FakeLlm(16), {
      model: "test-model",
      dimensions: 8,
      version: "test-v1",
    });

    await expect(reembedCorpus(db, bad)).rejects.toBeInstanceOf(EmbeddingValidationError);
    const row = db.prepare("SELECT embedding_model, embedding_version FROM fragments").get() as {
      embedding_model: string;
      embedding_version: string;
    };
    expect(row.embedding_model).toBe(FOREIGN.model);
    expect(row.embedding_version).toBe(FOREIGN.version);
  });

  it("la portée --sources ne touche que les sources visées", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    const b = makeTextSource(db, "B", "B");
    insertFragment(db, { sourceId: a, chunkIndex: 0, text: "a", ...FOREIGN });
    insertFragment(db, { sourceId: b, chunkIndex: 0, text: "b", ...FOREIGN });

    const { service } = countingEmbedder(8);
    const result = await reembedCorpus(db, service, { sourceIds: [a] });

    expect(result.candidates).toBe(1);
    const rows = db.prepare("SELECT id, embedding_model FROM fragments ORDER BY id").all() as {
      id: string;
      embedding_model: string;
    }[];
    expect(rows.find((r) => r.id === `frag-${a}-0`)?.embedding_model).toBe("test-model");
    expect(rows.find((r) => r.id === `frag-${b}-0`)?.embedding_model).toBe(FOREIGN.model);
  });

  it("job reembed : le worker persiste la progression puis le diagnostic des espaces", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    insertFragment(db, { sourceId: a, chunkIndex: 0, text: "t0", ...FOREIGN });
    insertFragment(db, { sourceId: a, chunkIndex: 1, text: "t1", ...FOREIGN });

    const jobs = createJobsRepo(db);
    const { service } = countingEmbedder(8);
    const sources = createSourcesRepo(db);
    const fragments = createFragmentsRepo(db);
    const worker = new Worker({
      jobs,
      ingest: new IngestService({
        db,
        sources,
        fragments,
        jobs,
        embedder: makeFakeEmbedder(8),
        chatModel: "test-model",
      }),
      summary: new SummaryService({
        db,
        sources,
        jobs,
        llm: new FakeLlm(8),
        chatModel: "test-model",
        groqKeyMissing: false,
      }),
      reembed: { run: (opts) => reembedCorpus(db, service, opts) },
    });

    jobs.createJob({
      kind: "reembed",
      payload: { batch_size: 1 },
      sourceId: null,
      idempotencyKey: idempotencyKey(["reembed", "test"]),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    const job = jobs.getById(claimed.id);
    expect(job?.status).toBe("done");
    const progress = JSON.parse(job?.progress_json as string) as {
      processed: number;
      total: number;
      batches: number;
      from: { model: string }[];
      to: { model: string }[];
    };
    // `batch_size: 1` honoré : deux lots pour deux fragments
    expect(progress.processed).toBe(2);
    expect(progress.batches).toBe(2);
    expect(progress.from.map((s) => s.model)).toEqual([FOREIGN.model]);
    expect(progress.to.map((s) => s.model)).toEqual(["test-model"]);
    expect((JSON.parse(job?.checkpoint as string) as { done: boolean }).done).toBe(true);
  });
});
