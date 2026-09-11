import type { EmbedBatcher, LlmProvider } from "@/lib/llm/types";
import { encodeEmbedding } from "@/lib/llm/embedding-codec";

/** Vecteur non conforme (taille ou valeurs) — job échoue avec erreur explicite (F1.3 AC2). */
export class EmbeddingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingValidationError";
  }
}

export interface EmbeddingMeta {
  model: string;
  dimensions: number;
  version: string;
}

/**
 * Encapsule l'appel d'embedding : validation (longueur == dims, valeurs finies)
 * puis encodage Float32 LE L2-normalisé. Jamais de BLOB invalide en DB.
 */
export class EmbeddingService {
  constructor(
    private provider: LlmProvider,
    readonly meta: EmbeddingMeta
  ) {}

  async embed(text: string): Promise<Buffer> {
    const [buf] = await this.embedMany([text]);
    return buf;
  }

  /**
   * Embeddings par lot (un seul appel réseau si le provider le permet,
   * sinon séquentiel) — validation + encodage de chaque vecteur.
   */
  async embedMany(texts: string[]): Promise<Buffer[]> {
    if (texts.length === 0) return [];
    let vectors: number[][];
    const batcher = (this.provider as Partial<EmbedBatcher>).embedMany;
    if (batcher) {
      vectors = await batcher.call(this.provider, texts);
    } else {
      vectors = [];
      for (const t of texts) vectors.push(await this.provider.embed(t));
    }
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new EmbeddingValidationError(
        `Embeddings non reçus (${vectors?.length ?? 0}/${texts.length})`
      );
    }
    return vectors.map((vec) => this.validateAndEncode(vec));
  }

  private validateAndEncode(vec: number[]): Buffer {
    if (!Array.isArray(vec) || vec.length !== this.meta.dimensions) {
      throw new EmbeddingValidationError(
        `Longueur d'embedding ${vec?.length} != ${this.meta.dimensions} (${this.meta.model})`
      );
    }
    for (const v of vec) {
      if (!Number.isFinite(v)) {
        throw new EmbeddingValidationError("Valeur non finie dans l'embedding");
      }
    }
    return encodeEmbedding(vec, this.meta.dimensions);
  }
}