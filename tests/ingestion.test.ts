import { describe, expect, it } from "vitest";
import { makeFakeEmbedder, makeTestDb, makeTextSource, FlakyLlm } from "./helpers";
import { EmbeddingService } from "@/lib/ingest/embedding-service";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createJobsRepo, idempotencyKey } from "@/lib/repositories/jobs";
import { IngestService } from "@/lib/ingest/ingest-service";
import { CHUNKER_VERSION, chunkText } from "@/lib/ingest/chunker";
import { decodeEmbedding } from "@/lib/llm/embedding-codec";
import { sha256Hex } from "@/lib/hash";

function makeIngest(deps: Partial<Parameters<typeof buildIngest>[0]> = {}) {
  const { db } = makeTestDb();
  return buildIngest({ db, ...deps });
}

function buildIngest(deps: {
  db: ReturnType<typeof makeTestDb>["db"];
  embedder?: ReturnType<typeof makeFakeEmbedder>;
  fetchUrl?: typeof import("@/lib/ingest/parsers").extractUrlText;
}) {
  const sources = createSourcesRepo(deps.db);
  const fragments = createFragmentsRepo(deps.db);
  const jobs = createJobsRepo(deps.db);
  const ingest = new IngestService({
    db: deps.db,
    sources,
    fragments,
    jobs,
    embedder: deps.embedder ?? makeFakeEmbedder(8),
    chatModel: "test-model",
    fetchUrl: deps.fetchUrl,
  });
  return { db: deps.db, sources, fragments, jobs, ingest };
}

function longText(): string {
  // ~30 paragraphes → ~10-11 chunks (> 1 lot de 8, pour tester crash au 2e lot)
  return Array.from({ length: 30 }, (_, i) => `Paragraphe ${i + 1}. `.repeat(40)).join("\n\n");
}

function enqueueIngest(
  jobs: ReturnType<typeof createJobsRepo>,
  sourceId: string,
  contentHash: string,
  extra: Record<string, unknown> = {}
) {
  return jobs.createJob({
    kind: "ingest",
    payload: { source_id: sourceId, ...extra },
    sourceId,
    idempotencyKey: idempotencyKey(["ingest", sourceId, contentHash, CHUNKER_VERSION]),
  });
}

describe("ingestion (intégration)", () => {
  it("TEXT : fragments chunkés, embeddings valides, job done, summary chaîné", async () => {
    const { db, fragments, jobs, ingest } = makeIngest();
    const raw = longText();
    const sourceId = makeTextSource(db, raw, "Article de test");
    enqueueIngest(jobs, sourceId, sha256Hex(raw));
    const [claimed] = jobs.claim(1);
    await ingest.runIngest(claimed);

    const done = jobs.getById(claimed.id);
    expect(done?.status).toBe("done");

    const expected = chunkText(raw).length;
    const rows = fragments.listBySource(sourceId);
    expect(rows).toHaveLength(expected);
    expect(fragments.countBySource(sourceId)).toBe(expected);

    for (const row of rows) {
      // locator : le slice re-produit exactement le texte (AC2 offsets UTF-16)
      const m = row.locator.match(/\[(\d+),(\d+)\)$/);
      expect(m).not.toBeNull();
      expect(raw.slice(Number(m?.[1]), Number(m?.[2]))).toBe(row.text);
      // embeddings : Float32 LE, L2-normalisés, dims du modèle
      expect(row.embedding.byteLength).toBe(8 * 4);
      const vec = decodeEmbedding(row.embedding, 8);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
      expect(row.embedding_model).toBe("test-model");
      expect(row.embedding_dimensions).toBe(8);
      expect(row.embedding_version).toBe("test-v1");
      expect(row.chunker_version).toBe(CHUNKER_VERSION);
      // chunk_index séquentiel sans trou
      expect(row.chunk_index).toBeGreaterThanOrEqual(0);
    }
    expect(rows.map((r) => r.chunk_index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: expected }, (_, i) => i)
    );

    // summary chaîné à la fin de l'ingestion
    const summaryJobs = db
      .prepare("SELECT * FROM jobs WHERE kind = 'summary'")
      .all() as { status: string }[];
    expect(summaryJobs).toHaveLength(1);
    expect(summaryJobs[0].status).toBe("pending");
  });

  it("crash/reprise : checkpoint respecté, 0 fragment en double", async () => {
    const { db, sources, fragments, jobs } = makeIngest();
    const raw = longText();
    const sourceId = makeTextSource(db, raw);

    // 1er run : panne de l'embedder au début du 2e lot (lots de 8)
    const flaky = new IngestService({
      db,
      sources,
      fragments,
      jobs,
      embedder: new EmbeddingService(new FlakyLlm(9, 8), {
        model: "test-model",
        dimensions: 8,
        version: "test-v1",
      }),
      chatModel: "test-model",
    });
    enqueueIngest(jobs, sourceId, sha256Hex(raw));
    const [claimed1] = jobs.claim(1);
    await expect(flaky.runIngest(claimed1)).rejects.toThrow("Ollama injoignable");
    // lot 1 (8 fragments) committé atomiquement, checkpoint à 8, job running
    expect(fragments.countBySource(sourceId)).toBe(8);
    const mid = jobs.getById(claimed1.id);
    expect(mid?.status).toBe("running");
    expect(JSON.parse(mid?.checkpoint as string)).toEqual({ next_chunk_index: 8 });

    // reboot : lease expiré → recovery → nouveau claim
    jobs.recoverExpiredLeases(new Date(Date.now() + 120_000));
    const { ingest } = makeIngest({ db, embedder: makeFakeEmbedder(8) });
    const [claimed2] = jobs.claim(1);
    expect(claimed2.lease_token).not.toBe(claimed1.lease_token);
    await ingest.runIngest(claimed2);

    const expected = chunkText(raw).length;
    expect(fragments.countBySource(sourceId)).toBe(expected); // pas de doublons
    expect(jobs.getById(claimed1.id)?.status).toBe("done");
  });

  it("URL : fetch stub → fragments avec locators #heading, hash réel en DB", async () => {
    const { sources, fragments, jobs, ingest } = makeIngest({
      fetchUrl: async () => ({
        text: longText(),
        title: "Article web",
        headings: [
          { offset: 0, text: "Intro" },
          { offset: 1500, text: "Analyse" },
        ],
      }),
    });
    const placeholder = sha256Hex("url:https://exemple.fr/article");
    sources.create({
      id: "url-1",
      type: "URL",
      title: "https://exemple.fr/article",
      canonical_path: "https://exemple.fr/article",
      raw_content: "",
      content_hash: placeholder,
    });
    enqueueIngest(jobs, "url-1", placeholder, { url: "https://exemple.fr/article" });
    const [claimed] = jobs.claim(1);
    await ingest.runIngest(claimed);

    expect(jobs.getById(claimed.id)?.status).toBe("done");
    const src = sources.getById("url-1");
    expect(src?.content_hash).toBe(sha256Hex(longText()));
    expect(src?.raw_content).toBe(longText());
    const rows = fragments.listBySource("url-1");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.locator).toMatch(/^#(Intro|Analyse);\[\d+,\d+\)$/);
    }
  });

  it("URL doublon de contenu : source supprimée, rien n'est créé", async () => {
    const { db, sources, fragments, jobs, ingest } = makeIngest({
      fetchUrl: async () => ({ text: longText(), title: null, headings: [] }),
    });
    // source existante avec ce contenu
    const existing = makeTextSource(db, longText(), "Déjà importé");
    // source URL placeholder
    const placeholder = sha256Hex("url:https://exemple.fr/dup");
    sources.create({
      id: "url-dup",
      type: "URL",
      title: "https://exemple.fr/dup",
      canonical_path: "https://exemple.fr/dup",
      raw_content: "",
      content_hash: placeholder,
    });
    enqueueIngest(jobs, "url-dup", placeholder, { url: "https://exemple.fr/dup" });
    const [claimed] = jobs.claim(1);
    await ingest.runIngest(claimed);

    // la source placeholder a disparu (avec ses jobs, en CASCADE)
    expect(sources.getById("url-dup")).toBeNull();
    expect(fragments.countBySource("url-dup")).toBe(0);
    expect(jobs.getById(claimed.id)).toBeNull();
    expect(sources.getById(existing)).not.toBeNull();
  });

  it("PDF : page_map du payload → locators p.N", async () => {
    const { sources, fragments, jobs, ingest } = makeIngest();
    const page1 = "Première page. ".repeat(90); // ~1 440 chars
    const page2 = "Deuxième page. ".repeat(90);
    const raw = `${page1}\n\n${page2}`;
    // source PDF (la route /api/sources calcule la page_map à la requête)
    const sourceId = "pdf-src-1";
    sources.create({
      id: sourceId,
      type: "PDF",
      title: "Rapport.pdf",
      canonical_path: `data/sources/${sourceId}.pdf`,
      raw_content: raw,
      content_hash: sha256Hex(raw),
    });
    const pageMap = [
      { offset: 0, page_num: 1 },
      { offset: page1.length + 2, page_num: 2 },
    ];
    enqueueIngest(jobs, sourceId, sha256Hex(raw), { page_map: pageMap });
    const [claimed] = jobs.claim(1);
    await ingest.runIngest(claimed);

    const rows = fragments.listBySource(sourceId);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.locator).toMatch(/^p\.\d+;\[\d+,\d+\)$/);
      const page = Number(row.locator.match(/^p\.(\d+)/)?.[1]);
      expect(page === 1 || page === 2).toBe(true);
    }
  });
});