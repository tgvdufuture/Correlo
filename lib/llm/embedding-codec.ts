/**
 * Codec d'embeddings (PRD §3.3 / F1.3) :
 * Float32 little-endian en BLOB (DataView.setFloat32(offset, value, true)),
 * L2-normalisé, lectures contrôlées (byteLength == dims × 4, valeurs finies).
 */

export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_VERSION = "nomic-embed-text-v1";

export class EmbeddingCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingCodecError";
  }
}

export function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingCodecError("Vecteur non normalisable (norme 0 ou non finie)");
  }
  return vec.map((v) => v / norm);
}

/** Vérifie la conformité (longueur, finitude) puis encode en Float32 LE. */
export function encodeEmbedding(vec: number[], dims: number = EMBEDDING_DIMENSIONS): Buffer {
  if (!Array.isArray(vec) || vec.length !== dims) {
    throw new EmbeddingCodecError(`Longueur d'embedding ${vec.length} != ${dims}`);
  }
  for (const v of vec) {
    if (!Number.isFinite(v)) {
      throw new EmbeddingCodecError("Valeur non finie dans le vecteur d'embedding");
    }
  }
  const normalized = l2Normalize(vec);
  const buf = Buffer.alloc(dims * 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < dims; i++) {
    view.setFloat32(i * 4, normalized[i], true); // little-endian
  }
  return buf;
}

/** Lecture de contrôle : byteLength exact + valeurs finies ; renvoie le vecteur. */
export function decodeEmbedding(buf: Buffer, dims: number = EMBEDDING_DIMENSIONS): number[] {
  if (buf.byteLength !== dims * 4) {
    throw new EmbeddingCodecError(`byteLength ${buf.byteLength} != dims × 4 (${dims * 4})`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Array<number>(dims);
  for (let i = 0; i < dims; i++) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) {
      throw new EmbeddingCodecError("Valeur non finie lue dans le BLOB");
    }
    out[i] = v;
  }
  return out;
}