import type { Db } from "@/lib/db/client";
import { nowIso } from "@/lib/db/client";

export type SourceType = "TEXT" | "PDF" | "URL";
export type JobStatus = "pending" | "running" | "done" | "failed";
export type SummaryStatus = "pending" | "done" | "failed";

export interface SourceRow {
  id: string;
  type: SourceType;
  title: string | null;
  canonical_path: string | null;
  raw_content: string;
  content_hash: string;
  summary: string | null;
  summary_status: SummaryStatus;
  created_at: string;
}

/** Source enrichie pour l'API bibliothèque (US-04). */
export interface SourceListItem extends Omit<SourceRow, "raw_content"> {
  fragment_count: number;
  ingest_status: JobStatus;
  ingest_error: string | null;
  ingest_job_id: string | null;
  summary_error: string | null;
  summary_job_id: string | null;
}

interface SourceListRow extends Omit<SourceRow, "raw_content"> {
  fragment_count: number;
  ingest_status: JobStatus | null;
  ingest_error: string | null;
  ingest_job_id: string | null;
  ingest_lease_until: string | null;
  summary_error: string | null;
  summary_job_id: string | null;
}

export interface NewSource {
  id: string;
  type: SourceType;
  title: string | null;
  canonical_path: string;
  raw_content: string;
  content_hash: string;
}

export interface SourcesRepo {
  create(s: NewSource): void;
  getById(id: string): SourceRow | null;
  getByContentHash(hash: string): SourceRow | null;
  list(): SourceListItem[];
  updateContent(
    id: string,
    patch: { raw_content: string; content_hash: string; title: string | null; canonical_path: string }
  ): void;
  setSummaryDone(id: string, summary: string): void;
  setSummaryFailed(id: string): void;
  deleteById(id: string): void;
}

const LIST_SQL = `
  SELECT s.id, s.type, s.title, s.canonical_path, s.content_hash, s.summary,
         s.summary_status, s.created_at,
    (SELECT COUNT(*) FROM fragments f WHERE f.source_id = s.id) AS fragment_count,
    j.status AS ingest_status, j.error AS ingest_error, j.id AS ingest_job_id,
    j.lease_until AS ingest_lease_until,
    js.error AS summary_error, js.id AS summary_job_id
  FROM sources s
  LEFT JOIN jobs j ON j.id = (
    SELECT id FROM jobs WHERE kind = 'ingest' AND source_id = s.id
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  )
  LEFT JOIN jobs js ON js.id = (
    SELECT id FROM jobs WHERE kind = 'summary' AND source_id = s.id
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  )
`;

export function createSourcesRepo(db: Db): SourcesRepo {
  const toListItem = (r: SourceListRow): SourceListItem => {
    // US-04 AC2 : dérivé des jobs ingest uniquement, le plus récent fait foi ;
    // lease expiré ⇒ pending (reprise au boot).
    let ingestStatus: JobStatus = r.ingest_status ?? "pending";
    if (
      ingestStatus === "running" &&
      r.ingest_lease_until &&
      r.ingest_lease_until < nowIso()
    ) {
      ingestStatus = "pending";
    }
    return {
      ...r,
      fragment_count: r.fragment_count,
      ingest_status: ingestStatus,
      ingest_error: r.ingest_error,
      ingest_job_id: r.ingest_job_id,
      summary_error: r.summary_error,
      summary_job_id: r.summary_job_id,
    };
  };

  return {
    create(s: NewSource) {
      db.prepare(
        `INSERT INTO sources (id, type, title, canonical_path, raw_content, content_hash, summary_status, created_at)
         VALUES (@id, @type, @title, @canonical_path, @raw_content, @content_hash, 'pending', @created_at)`
      ).run({ ...s, created_at: nowIso() });
    },

    getById(id: string): SourceRow | null {
      return (
        (db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined) ?? null
      );
    },

    getByContentHash(hash: string): SourceRow | null {
      return (
        (db.prepare("SELECT * FROM sources WHERE content_hash = ?").get(hash) as
          | SourceRow
          | undefined) ?? null
      );
    },

    list(): SourceListItem[] {
      return (db.prepare(`${LIST_SQL} ORDER BY s.created_at DESC`).all() as SourceListRow[]).map(
        toListItem
      );
    },

    updateContent(id, patch) {
      db.prepare(
        `UPDATE sources SET raw_content = @raw_content, content_hash = @content_hash,
           title = @title, canonical_path = @canonical_path WHERE id = @id`
      ).run({ id, ...patch });
    },

    setSummaryDone(id, summary) {
      db.prepare("UPDATE sources SET summary = ?, summary_status = 'done' WHERE id = ?").run(
        summary,
        id
      );
    },

    setSummaryFailed(id) {
      // l'erreur structurée est portée par le job summary (dernier fait foi dans list())
      db.prepare("UPDATE sources SET summary_status = 'failed' WHERE id = ?").run(id);
    },

    deleteById(id) {
      db.prepare("DELETE FROM sources WHERE id = ?").run(id);
    },
  };
}