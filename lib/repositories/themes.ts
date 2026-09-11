import { randomUUID } from "node:crypto";
import { nowIso, type Db } from "@/lib/db/client";
import { encodeEmbedding } from "@/lib/llm/embedding-codec";

export interface ThemeRow {
  id: string;
  run_id: string;
  corpus_hash: string;
  seed: string;
  label: string;
  centroid: Buffer;
  centroid_dimensions: number;
  size: number;
  sampler_version: string;
  created_at: string;
}

export interface NewTheme {
  runId: string;
  corpusHash: string;
  seed: string;
  label: string;
  /** Centroïde L2-normalisé (même codec que les embeddings de fragments). */
  centroid: Float32Array | number[];
  size: number;
  samplerVersion: string;
}

export interface ThemesRepo {
  /** Insère les thèmes d'un run (transaction) ; renvoie les ids dans l'ordre d'entrée. */
  createMany(themes: NewTheme[]): string[];
  listByRun(runId: string): ThemeRow[];
  countByRun(runId: string): number;
  /**
   * Supprime les thèmes d'un run (CASCADE sur leurs synthèses) — à appeler
   * explicitement avant de rejouer un run : rejouer ne doit pas laisser
   * les synthèses d'une tentative précédente rattachées à de nouveaux thèmes.
   */
  deleteByRun(runId: string): number;
}

export function createThemesRepo(db: Db): ThemesRepo {
  return {
    createMany(themes: NewTheme[]): string[] {
      const insert = db.prepare(
        `INSERT INTO themes (id, run_id, corpus_hash, seed, label, centroid,
           centroid_dimensions, size, sampler_version, created_at)
         VALUES (@id, @run_id, @corpus_hash, @seed, @label, @centroid,
           @centroid_dimensions, @size, @sampler_version, @created_at)`
      );
      const run = db.transaction((rows: NewTheme[]) =>
        rows.map((t) => {
          const id = randomUUID();
          const dims = t.centroid.length;
          insert.run({
            id,
            run_id: t.runId,
            corpus_hash: t.corpusHash,
            seed: t.seed,
            label: t.label,
            centroid: encodeEmbedding(Array.from(t.centroid), dims),
            centroid_dimensions: dims,
            size: t.size,
            sampler_version: t.samplerVersion,
            created_at: nowIso(),
          });
          return id;
        })
      );
      return run(themes);
    },

    listByRun(runId: string): ThemeRow[] {
      return db
        .prepare("SELECT * FROM themes WHERE run_id = ? ORDER BY rowid")
        .all(runId) as ThemeRow[];
    },

    countByRun(runId: string): number {
      const row = db.prepare("SELECT COUNT(*) AS n FROM themes WHERE run_id = ?").get(runId) as {
        n: number;
      };
      return row.n;
    },

    deleteByRun(runId: string): number {
      return db.prepare("DELETE FROM themes WHERE run_id = ?").run(runId).changes;
    },
  };
}
