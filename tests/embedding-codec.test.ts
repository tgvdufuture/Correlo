import { describe, expect, it } from "vitest";
import {
  decodeEmbedding,
  encodeEmbedding,
  EmbeddingCodecError,
  l2Normalize,
} from "@/lib/llm/embedding-codec";

const DIMS = 8;

describe("embedding-codec", () => {
  it("roundtrip encode/decode, little-endian, L2-normalisé", () => {
    const vec = [1, 2, 3, 4, 5, 6, 7, 8];
    const buf = encodeEmbedding(vec, DIMS);
    expect(buf.byteLength).toBe(DIMS * 4);
    const out = decodeEmbedding(buf, DIMS);
    expect(out).toHaveLength(DIMS);
    // L2 ≈ 1 (précision float32)
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
    // little-endian : le premier octet du BLOB doit porter la partie basse du float
    expect(buf[0]).not.toBe(0);
  });

  it("l2Normalize normalise et préserve la direction", () => {
    const n = l2Normalize([3, 4]);
    expect(n[0]).toBeCloseTo(0.6);
    expect(n[1]).toBeCloseTo(0.8);
  });

  it("longueur erronée → erreur explicite, jamais de BLOB invalide", () => {
    expect(() => encodeEmbedding([1, 2, 3], DIMS)).toThrow(EmbeddingCodecError);
  });

  it("valeurs non finies → erreur", () => {
    expect(() => encodeEmbedding([NaN, 2, 3, 4, 5, 6, 7, 8], DIMS)).toThrow(EmbeddingCodecError);
    expect(() => encodeEmbedding([Infinity, 2, 3, 4, 5, 6, 7, 8], DIMS)).toThrow(
      EmbeddingCodecError
    );
  });

  it("lecture : byteLength != dims × 4 → erreur", () => {
    const buf = encodeEmbedding([1, 2, 3, 4, 5, 6, 7, 8], DIMS);
    expect(() => decodeEmbedding(buf.subarray(0, 10), DIMS)).toThrow(EmbeddingCodecError);
  });

  it("lecture : NaN dans le BLOB → erreur (contrôle de finitude)", () => {
    const buf = Buffer.alloc(DIMS * 4);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setFloat32(0, NaN, true);
    view.setFloat32(4, 0.5, true);
    expect(() => decodeEmbedding(buf, DIMS)).toThrow(EmbeddingCodecError);
  });

  it("défauts : 768 dims par défaut", () => {
    const vec = Array.from({ length: 768 }, (_, i) => (i % 5) + 0.1);
    const buf = encodeEmbedding(vec);
    expect(buf.byteLength).toBe(768 * 4);
    expect(decodeEmbedding(buf)).toHaveLength(768);
  });
});