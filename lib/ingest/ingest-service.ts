import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import { sha256Hex } from "@/lib/hash";
import type { SourcesRepo } from "@/lib/repositories/sources";
import type { FragmentsRepo } from "@/lib/repositories/fragments";
import { idempotencyKey, type JobRow, type JobsRepo } from "@/lib/repositories/jobs";
import { CHUNKER_VERSION, chunkText, buildLocator, type PageMapEntry, type HeadingMapEntry } from "@/lib/ingest/chunker";
import { extractUrlText } from "@/lib/ingest/parsers";
import type { EmbeddingService } from "@/lib/ingest/embedding-service";
import { SUMMARY_PROMPT_VERSION } from "@/lib/ingest/summary-service";

/** Le job a été réclamé ailleurs (lease repris) — ne plus écrire de statut. */
export class JobStolenError extends Error {
  constructor() {
    super("job repris par un autre lease");
    this.name = "JobStolenError";
  }
}

/** Erreur métier avec code structuré (affiché tel quel dans l'UI). */
export class IngestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

interface IngestPayload {
  source_id: string;
  url?: string;
  page_map?: PageMapEntry[];
}

export interface IngestDeps {
  db: Db;
  sources: SourcesRepo;
  fragments: FragmentsRepo;
  jobs: JobsRepo;
  embedder: EmbeddingService;
  chatModel: string;
  /** Injectable pour les tests (fetch + Readability réels par défaut). */
  fetchUrl?: typeof extractUrlText;
}

/**
 * Exécute un job d'ingestion : récupération du contenu (URL), découpage
 * chunker-v1, embeddings locaux, insertion des fragments avec checkpoint.
 * Transactions SQLite courtes et synchrones ; jamais d'await réseau dans une transaction.
 */
export class IngestService {
  private fetchUrl: typeof extractUrlText;

  constructor(private deps: IngestDeps) {
    this.fetchUrl = deps.fetchUrl ?? extractUrlText;
  }

  async runIngest(job: JobRow): Promise<void> {
    const payload = JSON.parse(job.payload) as IngestPayload;
    const source = this.deps.sources.getById(payload.source_id);
    if (!source) return; // source supprimée pendant le run : rien à faire

    let rawContent = source.raw_content;
    const pageMap: PageMapEntry[] | null = payload.page_map ?? null;
    let headings: HeadingMapEntry[] = [];

    if (source.type === "URL") {
      const url = payload.url as string;
      const extraction = await this.fetchUrl(url);
      const contentHash = sha256Hex(extraction.text);
      const dup = this.deps.sources.getByContentHash(contentHash);
      if (dup && dup.id !== source.id) {
        // doublon de contenu : rien n'a été créé (US-01 AC3) — la source placeholder
        // disparaît (CASCADE supprime aussi ses jobs).
        this.deps.sources.deleteById(source.id);
        return;
      }
      this.deps.sources.updateContent(source.id, {
        raw_content: extraction.text,
        content_hash: contentHash,
        title: extraction.title ?? source.title,
        canonical_path: url,
      });
      rawContent = extraction.text;
      headings = extraction.headings;
    }

    const chunks = chunkText(rawContent);
    const total = chunks.length;

    // Reprise au checkpoint : fragments déjà insérés non re-créés (0 doublon).
    let startIndex = 0;
    if (job.checkpoint) {
      const cp = JSON.parse(job.checkpoint) as { next_chunk_index?: number };
      if (typeof cp.next_chunk_index === "number") startIndex = cp.next_chunk_index;
    }

    // Embeddings par lots (8 fragments / appel Ollama) — beaucoup moins de
    // round-trips réseau ; transactions courtes et synchrones par lot.
    const BATCH = 8;
    for (let i = startIndex; i < total; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const embeddings = await this.deps.embedder.embedMany(
        batch.map((c) => rawContent.slice(c.start, c.end))
      );

      const commit = this.deps.db.transaction(() => {
        for (let k = 0; k < batch.length; k++) {
          const chunk = batch[k];
          this.deps.fragments.insert({
            id: randomUUID(),
            source_id: source.id,
            chunk_index: i + k,
            locator: buildLocator(source.type, chunk, pageMap ?? undefined, headings),
            text: rawContent.slice(chunk.start, chunk.end),
            embedding: embeddings[k],
            embedding_model: this.deps.embedder.meta.model,
            embedding_dimensions: this.deps.embedder.meta.dimensions,
            embedding_version: this.deps.embedder.meta.version,
            chunker_version: CHUNKER_VERSION,
          });
        }
        const next = i + batch.length;
        const written = this.deps.jobs.updateCheckpoint(
          job.id,
          job.lease_token as string,
          JSON.stringify({ next_chunk_index: next }),
          JSON.stringify({ processed: next, total })
        );
        this.deps.jobs.renewLease(job.id, job.lease_token as string);
        return written;
      });
      if (!commit()) throw new JobStolenError();
    }

    const completed = this.deps.jobs.complete(job.id, job.lease_token as string);
    if (!completed) throw new JobStolenError();

    // Chaînage : le résumé (routage, non citable) part après ingestion réussie.
    this.enqueueSummary(source.id);
  }

  private enqueueSummary(sourceId: string): void {
    const source = this.deps.sources.getById(sourceId);
    if (!source) return;
    this.deps.jobs.createJob({
      kind: "summary",
      payload: { source_id: sourceId },
      sourceId,
      idempotencyKey: idempotencyKey([
        "summary",
        sourceId,
        source.content_hash,
        this.deps.chatModel,
        SUMMARY_PROMPT_VERSION,
      ]),
    });
  }
}