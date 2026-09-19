import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeFragment, makeFakeEmbedder, makeTestDb, makeTextSource } from "./helpers";
import type { LlmProvider } from "@/lib/llm/types";
import { DiscoveryService } from "@/lib/discover/discovery-service";
import { SynthesisService } from "@/lib/synth/synth-service";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { createThemesRepo } from "@/lib/repositories/themes";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import {
  assertSingleEmbeddingSpace,
  listCorpusSpaces,
  sameSpace,
  spaceLabel,
  EmbeddingSpaceMismatchError,
} from "@/lib/llm/embedding-space";
import { reembedCorpus } from "@/lib/ingest/reembed-service";
import { encodeEmbedding } from "@/lib/llm/embedding-codec";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { samplePairs } from "@/lib/discover/sampler";

/**
 * L'espace vectoriel est une propriété du corpus, pas du code : ces tests fixent les
 * deux moitiés du contrat — la **détection** (un run refuse un corpus multi-espaces)
 * et la **réparation** (`reembedCorpus` ramène tout dans l'espace actif).
 */

/** Fragment inséré avec un espace explicite (les helpers n'en connaissent qu'un). */
function makeFragmentInSpace(
  db: ReturnType<typeof makeTestDb>["db"],
  opts: { sourceId: string; text: string; chunkIndex: number; model: string; dims: number; version: string }
): string {
  const repo = createFragmentsRepo(db);
  const id = `frag-${opts.sourceId}-${opts.chunkIndex}`;
  repo.insert({
    id,
    source_id: opts.sourceId,
    chunk_index: opts.chunkIndex,
    locator: "[0,10)",
    text: opts.text,
    embedding: encodeEmbedding(Array.from({ length: opts.dims }, (_, i) => 0.1 + i * 0.01), opts.dims),
    embedding_model: opts.model,
    embedding_dimensions: opts.dims,
    embedding_version: opts.version,
    chunker_version: "chunker-v1",
  });
  return id;
}

describe("espace vectoriel du corpus", () => {
  it("liste les espaces présents avec leur poids (fragments et sources distinctes)", () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "Contenu A", "A");
    const b = makeTextSource(db, "Contenu B", "B");
    makeFragment(db, { sourceId: a, text: "a1", chunkIndex: 0 });
    makeFragment(db, { sourceId: a, text: "a2", chunkIndex: 1 });
    makeFragment(db, { sourceId: b, text: "b1", chunkIndex: 0 });
    makeFragmentInSpace(db, {
      sourceId: b,
      text: "b2",
      chunkIndex: 1,
      model: "autre-modele",
      dims: 16,
      version: "autre-v1",
    });

    const spaces = listCorpusSpaces(db);
    expect(spaces).toHaveLength(2);
    // trié par poids décroissant
    expect(spaces[0]).toMatchObject({ model: "test-model", dimensions: 8, version: "test-v1" });
    expect(spaces[0].fragments).toBe(3);
    expect(spaces[0].sources).toBe(2);
    expect(spaces[1]).toMatchObject({ model: "autre-modele", dimensions: 16, version: "autre-v1" });
    expect(spaces[1].sources).toBe(1);
  });

  it("renvoie null sur un corpus sans fragment (run vide, pas une erreur)", () => {
    const { db } = makeTestDb();
    const source = makeTextSource(db, "Vide", "Vide");
    expect(assertSingleEmbeddingSpace(db, [source], "test")).toBeNull();
  });

  it("accepte un corpus d'un seul espace", () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    makeFragment(db, { sourceId: a, text: "a1", chunkIndex: 0 });
    expect(assertSingleEmbeddingSpace(db, [a], "test")?.model).toBe("test-model");
  });

  it("refuse un corpus multi-espaces en nommant les deux espaces et la commande de réparation", () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    const b = makeTextSource(db, "B", "B");
    makeFragment(db, { sourceId: a, text: "a1", chunkIndex: 0 });
    makeFragmentInSpace(db, {
      sourceId: b,
      text: "b1",
      chunkIndex: 0,
      model: "nvidia/nemotron-3-embed-1b",
      dims: 2048,
      version: "nvidia-nemotron-3-embed-1b-v1",
    });

    let error: unknown;
    try {
      assertSingleEmbeddingSpace(db, [a, b], "run discover run-x");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EmbeddingSpaceMismatchError);
    const message = (error as Error).message;
    // les deux espaces sont nommés, avec leur poids : c'est ce qui rend le diagnostic possible
    expect(message).toContain(spaceLabel({ model: "test-model", dimensions: 8, version: "test-v1" }));
    expect(message).toContain("nvidia/nemotron-3-embed-1b (2048 dims, nvidia-nemotron-3-embed-1b-v1)");
    expect(message).toContain("run discover run-x");
    expect(message).toContain("npm run reembed");
  });

  it("ne filtre pas par les seules dimensions : deux modèles de même dimension restent deux espaces", () => {
    expect(sameSpace({ model: "a", dimensions: 768, version: "a-v1" }, { model: "b", dimensions: 768, version: "b-v1" })).toBe(false);
    expect(sameSpace({ model: "a", dimensions: 768, version: "a-v1" }, { model: "a", dimensions: 768, version: "a-v1" })).toBe(true);
  });

  /**
   * Le piège que le garde-fou ferme, mesuré ici plutôt que raconté : `samplePairs` ne
   * vérifie aucune dimension. Sur un corpus mixte il lit `dims` valeurs dans chaque
   * vecteur — soit les 768 premières d'un vecteur de 2048 — et rend des similarités
   * **fausses mais plausibles**. Ce test échouera si quelqu'un ajoute une vérification
   * au sampler (et il faudra alors décider où vit l'invariant).
   */
  it("le sampler ne proteste pas : c'est le rôle du garde-fou (démonstration du piège)", () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    const b = makeTextSource(db, "B", "B");
    makeFragment(db, { sourceId: a, text: "a1", chunkIndex: 0 });
    makeFragmentInSpace(db, { sourceId: b, text: "b1", chunkIndex: 0, model: "autre", dims: 16, version: "autre-v1" });

    const pairs = samplePairs({
      fragments: [
        { id: "f1", sourceId: a, chunkIndex: 0, embedding: new Float32Array(8).fill(0.5) },
        { id: "f2", sourceId: b, chunkIndex: 0, embedding: new Float32Array(16).fill(0.5) },
      ],
      seedHex: "0".repeat(64),
      sampler: "diversified",
    });
    // aucune exception : le couple est échantillonné et comparé sur une longueur tronquée
    expect(pairs.length).toBeGreaterThan(0);
  });

  /**
   * Le câblage du garde-fou, et non la règle : sans ces deux tests, retirer l'appel
   * `assertSingleEmbeddingSpace` des services laisserait toute la suite au vert — le
   * pipeline comparerait alors des vecteurs de longueurs différentes sans le dire.
   * Le LLM factice explose s'il est appelé : rien ne doit partir avant le refus.
   */
  it("un run discover sur un corpus mixte échoue avant le premier appel LLM", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    const b = makeTextSource(db, "B", "B");
    makeFragment(db, { sourceId: a, text: "a1", chunkIndex: 0 });
    makeFragmentInSpace(db, { sourceId: b, text: "b1", chunkIndex: 0, model: "autre", dims: 16, version: "autre-v1" });
    let calls = 0;
    // `chat()` sans paramètres : signatures compatibles, et le lint reste propre
    // (même forme que `OllamaProvider.chat` dans le code de production)
    const chat: LlmProvider = {
      async embed() {
        throw new Error("pas d'embedding ici");
      },
      async chat<T extends z.ZodType>(): Promise<z.infer<T>> {
        calls += 1;
        throw new Error("le modèle ne doit pas être appelé");
      },
    };
    const service = new DiscoveryService({
      db,
      suggestions: createSuggestionsRepo(db),
      chat,
      chatModel: "test-model",
    });

    await expect(
      service.run([a, b], { runId: "run-mixte", sampler: "diversified" })
    ).rejects.toBeInstanceOf(EmbeddingSpaceMismatchError);
    expect(calls).toBe(0);
  });

  it("un run synthesize sur un corpus mixte échoue de la même façon", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    const b = makeTextSource(db, "B", "B");
    makeFragment(db, { sourceId: a, text: "a1", chunkIndex: 0 });
    makeFragmentInSpace(db, { sourceId: b, text: "b1", chunkIndex: 0, model: "autre", dims: 16, version: "autre-v1" });
    const chat: LlmProvider = {
      async embed() {
        throw new Error("pas d'embedding ici");
      },
      async chat<T extends z.ZodType>(): Promise<z.infer<T>> {
        throw new Error("le modèle ne doit pas être appelé");
      },
    };
    const service = new SynthesisService({
      db,
      themes: createThemesRepo(db),
      syntheses: createSynthesesRepo(db),
      chat,
      chatModel: "test-model",
    });

    await expect(
      service.run([a, b], { runId: "synth-mixte" })
    ).rejects.toBeInstanceOf(EmbeddingSpaceMismatchError);
  });

  it("reembedCorpus remet le corpus dans l'espace actif, puis l'invariant tient", async () => {
    const { db } = makeTestDb();
    const a = makeTextSource(db, "A", "A");
    const b = makeTextSource(db, "B", "B");
    makeFragment(db, { sourceId: a, text: "a1", chunkIndex: 0 });
    makeFragmentInSpace(db, { sourceId: b, text: "b1", chunkIndex: 0, model: "autre", dims: 8, version: "autre-v1" });

    expect(() => assertSingleEmbeddingSpace(db, [a, b], "avant")).toThrow(EmbeddingSpaceMismatchError);

    // l'« espace actif » du test : test-model / 8 dims / test-v1
    const result = await reembedCorpus(db, makeFakeEmbedder(8));

    expect(result.candidates).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.from).toHaveLength(2);
    expect(result.to).toHaveLength(1);
    expect(result.to[0]).toMatchObject({ model: "test-model", dimensions: 8, version: "test-v1" });
    expect(assertSingleEmbeddingSpace(db, [a, b], "après")?.model).toBe("test-model");
  });
});
