import type { Db } from "@/lib/db/client";

export interface FragmentRow {
  id: string;
  source_id: string;
  chunk_index: number;
  locator: string;
  text: string;
  embedding: Buffer;
  embedding_model: string;
  embedding_dimensions: number;
  embedding_version: string;
  chunker_version: string;
}

export interface NewFragment {
  id: string;
  source_id: string;
  chunk_index: number;
  locator: string;
  text: string;
  embedding: Buffer;
  embedding_model: string;
  embedding_dimensions: number;
  embedding_version: string;
  chunker_version: string;
}

export interface FragmentsRepo {
  insert(f: NewFragment): void;
  countBySource(sourceId: string): number;
  listBySource(sourceId: string): FragmentRow[];
  getById(id: string): FragmentRow | null;
}

export function createFragmentsRepo(db: Db): FragmentsRepo {
  return {
    insert(f: NewFragment) {
      db.prepare(
        `INSERT INTO fragments (id, source_id, chunk_index, locator, text, embedding,
           embedding_model, embedding_dimensions, embedding_version, chunker_version)
         VALUES (@id, @source_id, @chunk_index, @locator, @text, @embedding,
           @embedding_model, @embedding_dimensions, @embedding_version, @chunker_version)`
      ).run(f);
    },

    countBySource(sourceId: string): number {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM fragments WHERE source_id = ?")
        .get(sourceId) as { n: number };
      return row.n;
    },

    listBySource(sourceId: string): FragmentRow[] {
      return db
        .prepare("SELECT * FROM fragments WHERE source_id = ? ORDER BY chunk_index ASC")
        .all(sourceId) as FragmentRow[];
    },

    getById(id: string): FragmentRow | null {
      return (
        (db.prepare("SELECT * FROM fragments WHERE id = ?").get(id) as FragmentRow | undefined) ??
        null
      );
    },
  };
}