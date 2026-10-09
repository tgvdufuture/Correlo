import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { z } from "zod";
import { createDb, type Db } from "@/lib/db/client";
import type { ChatMessage, EmbedBatcher, LlmProvider } from "@/lib/llm/types";
import { EmbeddingService } from "@/lib/ingest/embedding-service";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { encodeEmbedding } from "@/lib/llm/embedding-codec";
import { sha256Hex } from "@/lib/hash";

export function makeTestDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "correlo-test-"));
  return { db: createDb(path.join(dir, "test.db")), dir };
}

export function makeFakeEmbedder(dims = 8): EmbeddingService {
  return new EmbeddingService(new FakeLlm(dims), {
    model: "test-model",
    dimensions: dims,
    version: "test-v1",
  });
}

/** LLM déterministe pour les tests (aucun réseau). */
export class FakeLlm implements LlmProvider, EmbedBatcher {
  constructor(private dims = 8) {}

  async embed(text: string): Promise<number[]> {
    const base = 0.1 + ((text.length + text.charCodeAt(0) || 0) % 9) * 0.01;
    return Array.from({ length: this.dims }, (_, i) => base + i * 0.001);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async chat<T extends z.ZodType>(_messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    return schema.parse({ summary: "Résumé de test." });
  }
}

/** Échoue sur le Nième appel d'embed (simule une panne Ollama / un crash). */
export class FlakyLlm extends FakeLlm {
  private calls = 0;
  constructor(
    private failOn: number,
    dims = 8
  ) {
    super(dims);
  }

  override async embed(text: string): Promise<number[]> {
    this.calls += 1;
    if (this.calls === this.failOn) throw new Error("Ollama injoignable (test)");
    return super.embed(text);
  }
}

/** Crée une source TEXT directement en base. */
export function makeTextSource(db: Db, rawContent: string, title = "Source de test"): string {
  const repo = createSourcesRepo(db);
  const id = `src-${sha256Hex(rawContent).slice(0, 12)}`;
  repo.create({
    id,
    type: "TEXT",
    title,
    canonical_path: `data/sources/${id}.txt`,
    raw_content: rawContent,
    content_hash: sha256Hex(rawContent),
  });
  return id;
}

/** Insère un fragment (embedding codé Float32 LE, dims 8) — renvoie son id. */
export function makeFragment(
  db: Db,
  opts: {
    sourceId: string;
    text: string;
    chunkIndex?: number;
    vector?: number[];
    id?: string;
  }
): string {
  const repo = createFragmentsRepo(db);
  const id = opts.id ?? `frag-${sha256Hex(opts.text + String(opts.chunkIndex ?? "")).slice(0, 12)}`;
  repo.insert({
    id,
    source_id: opts.sourceId,
    chunk_index: opts.chunkIndex ?? 0,
    locator: "[0,10)",
    text: opts.text,
    embedding: encodeEmbedding(opts.vector ?? [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], 8),
    embedding_model: "test-model",
    embedding_dimensions: 8,
    embedding_version: "test-v1",
    chunker_version: "chunker-v1",
  });
  return id;
}