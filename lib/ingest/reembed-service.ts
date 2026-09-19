import type { Db } from "@/lib/db/client";
import type { EmbeddingService } from "@/lib/ingest/embedding-service";
import {
  listCorpusSpaces,
  sameSpace,
  type CorpusSpace,
  type EmbeddingSpace,
} from "@/lib/llm/embedding-space";

/**
 * Re-vectorisation du corpus dans l'espace **actif**.
 *
 * Un vecteur n'a de sens que dans l'espace qui l'a produit : changer
 * `EMBED_PROVIDER` (Ollama ↔ connecteur API) sans re-vectoriser laisse deux espaces
 * incomparables en base, et la comparaison silencieuse de ceux-ci produirait des
 * similarités fausses mais plausibles. Cette unité est l'autre moitié du contrat :
 * `assertSingleEmbeddingSpace` refuse le mélange, `reembedCorpus` le résout.
 *
 * Trois propriétés qui font qu'elle est utilisable sur un vrai corpus (3 849
 * fragments sur le corpus réel) :
 *   - **par lots** : un appel réseau pour N textes (le connecteur API accepte 32 en
 *     2,7 s), et une transaction par lot — un corpus reste exploitable entre deux lots,
 *     il n'y a jamais de BLOB à moitié écrit ;
 *   - **reprise naturelle** : sans `force`, un fragment déjà dans l'espace actif est
 *     sauté. Relancer le job après une coupure (429, redémarrage) termine le travail
 *     au lieu de le refaire ;
 *   - **même encodage que l'ingestion** : le passage par `EmbeddingService` garantit
 *     que la longueur du vecteur est celle de l'espace annoncé et que le BLOB est
 *     Float32 LE L2-normalisé — jamais d'écriture directe.
 */
export interface ReembedProgress {
  processed: number;
  total: number;
  batches: number;
}

export interface ReembedOptions {
  /** Textes par appel d'embeddings (l'ingestion et le connecteur API tolèrent 32). */
  batchSize?: number;
  /** Re-vectorise aussi les fragments déjà dans l'espace actif (défaut : non). */
  force?: boolean;
  /** Limite la re-vectorisation à ces sources (par défaut : tout le corpus). */
  sourceIds?: string[];
  onProgress?: (p: ReembedProgress) => void;
  /** Arrêt coopératif : le lot en cours se termine, les suivants ne partent pas. */
  shouldStop?: () => boolean;
}

export interface ReembedResult {
  space: EmbeddingSpace;
  /** Espaces présents avant le travail (le diagnostic de la bascule). */
  from: CorpusSpace[];
  /** Espaces présents après : un seul, celui de l'espace actif, si tout a abouti. */
  to: CorpusSpace[];
  /** Fragments à re-vectoriser dans cette exécution. */
  candidates: number;
  processed: number;
  batches: number;
  /** Fragments de l'espace actif sautés (déjà à jour). */
  skipped: number;
}

export async function reembedCorpus(
  db: Db,
  embedder: EmbeddingService,
  opts: ReembedOptions = {}
): Promise<ReembedResult> {
  const space = embedder.meta;
  const batchSize = Math.max(1, opts.batchSize ?? 32);
  const from = listCorpusSpaces(db, opts.sourceIds);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    conditions.push(`source_id IN (${opts.sourceIds.map(() => "?").join(",")})`);
    params.push(...opts.sourceIds);
  }
  if (!opts.force) {
    // Un fragment déjà dans l'espace actif n'a rien à faire ici. Le filtre porte sur
    // l'identité complète (modèle, dimensions, version) : deux modèles de même
    // dimension produisent deux espaces différents.
    conditions.push(
      "NOT (embedding_model = ? AND embedding_dimensions = ? AND embedding_version = ?)"
    );
    params.push(space.model, space.dimensions, space.version);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT id, text FROM fragments ${where} ORDER BY rowid`)
    .all(...params) as { id: string; text: string }[];

  const totalInSpace = opts.force
    ? 0
    : from
        .filter((s) => sameSpace(s, space))
        .reduce((n, s) => n + s.fragments, 0);

  const update = db.prepare(
    `UPDATE fragments
     SET embedding = @embedding, embedding_model = @model,
         embedding_dimensions = @dims, embedding_version = @version
     WHERE id = @id`
  );
  const writeBatch = db.transaction(
    (batch: { id: string; embedding: Buffer }[]): void => {
      for (const row of batch) {
        update.run({
          id: row.id,
          embedding: row.embedding,
          model: space.model,
          dims: space.dimensions,
          version: space.version,
        });
      }
    }
  );

  let processed = 0;
  let batches = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    if (opts.shouldStop?.()) break;
    const slice = rows.slice(i, i + batchSize);
    // `embedMany` valide (longueur = dimensions de l'espace, valeurs finies) puis
    // encode : une réponse incohérente du provider fait échouer le lot **avant**
    // qu'un seul BLOB ne soit écrit.
    const embeddings = await embedder.embedMany(slice.map((r) => r.text));
    writeBatch(slice.map((r, k) => ({ id: r.id, embedding: embeddings[k] })));
    processed += slice.length;
    batches += 1;
    opts.onProgress?.({ processed, total: rows.length, batches });
  }

  return {
    space,
    from,
    to: listCorpusSpaces(db, opts.sourceIds),
    candidates: rows.length,
    processed,
    batches,
    skipped: totalInSpace,
  };
}
