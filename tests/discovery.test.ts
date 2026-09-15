import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { makeFragment, makeTestDb, makeTextSource, makeFakeEmbedder } from "./helpers";
import { LlmTransientError } from "@/lib/llm/errors";
import { DiscoveryService } from "@/lib/discover/discovery-service";
import { DISCOVERY_PROMPT_VERSION } from "@/lib/discover/prompts";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createJobsRepo, idempotencyKey, type ClaimedJob } from "@/lib/repositories/jobs";
import { IngestService } from "@/lib/ingest/ingest-service";
import { SummaryService } from "@/lib/ingest/summary-service";
import { Worker } from "@/lib/jobs/worker";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";

/**
 * Claims factices distincts et valides au regard de la barrière déterministe
 * (sinon le service les rejetterait et les tests de comptage n'auraient plus de sens).
 */
/**
 * Claim factice déterministe à partir du CONTENU de la paire : une même paire doit
 * donner le même claim (sinon la reprise au checkpoint ne produirait plus de doublons),
 * et deux paires différentes des claims bien distincts (sinon la barrière
 * quasi-doublon les fusionnerait et les comptages de tests n'auraient plus de sens).
 */
export function fakeClaimFromPair(aText: string, bText: string): string {
  // suffixe dérivé du contenu : chaque paire obtient ses propres termes, donc
  // deux paires distinctes ne peuvent pas tomber sous le seuil de quasi-doublon
  const h = createHash("sha256").update(`${aText}|${bText}`).digest("hex");
  return (
    `Le mecanisme${h.slice(0, 6)} contredit le dispositif${h.slice(6, 12)} ` +
    `sur le principe${h.slice(12, 18)}.`
  );
}

/** LLM factice : une suggestion par candidate_id du batch (aucun réseau). */
class FakeDiscoveryLlm implements LlmProvider {
  calls = 0;
  /** Dernier batch produit (index = candidate_id) — utilisé par les assertions. */
  lastBatchClaims: string[] = [];
  async embed(): Promise<number[]> {
    throw new Error("pas d'embedding dans le pipeline de découverte");
  }
  async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    this.calls += 1;
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const count = (user.match(/--- Paire /g) ?? []).length;
    const fragments = [...user.matchAll(/<fragment>\n([\s\S]*?)\n<\/fragment>/g)].map((m) => m[1]);
    const results = [];
    const claims: string[] = [];
    for (let i = 0; i < count; i++) {
      const isCause = i % 3 === 2;
      const claim = fakeClaimFromPair(fragments[2 * i] ?? "", fragments[2 * i + 1] ?? "");
      claims.push(claim);
      results.push({
        candidate_id: i,
        claim,
        relation_type: isCause ? "cause" : i % 2 === 0 ? "analogy" : "contradiction",
        tier: "medium",
        // candidate 2 : FACT proposé alors que le claim n'est pas dans les fragments → rétrogradé
        epistemic_status: i === 2 ? "FACT" : "INFERENCE",
        // candidate 5 : cause sans cause_fragment (oubli du modèle) → ignorée par le service
        cause_fragment: i === 5 ? undefined : isCause ? "a" : undefined,
      });
    }
    this.lastBatchClaims = claims;
    return schema.parse({ results });
  }
}

/** Corpus : 2 sources × 6 fragments, embeddings déterministes diversifiés. */
function buildCorpus(db: ReturnType<typeof makeTestDb>["db"]): string[] {
  const s1 = makeTextSource(db, "Source un.", "Source un");
  const s2 = makeTextSource(db, "Source deux.", "Source deux");
  for (let i = 0; i < 6; i++) {
    makeFragment(db, {
      sourceId: s1,
      chunkIndex: i,
      text: `Fragment un ${i}. `.repeat(30),
      vector: [0.9 - i * 0.02, 0.1 + i * 0.01, 0, 0, 0, 0, 0, 0],
    });
    makeFragment(db, {
      sourceId: s2,
      chunkIndex: i,
      text: `Fragment deux ${i}. `.repeat(30),
      vector: [0.1, 0.8 - i * 0.02, 0, 0, 0, 0, 0, 0],
    });
  }
  return [s1, s2];
}

function makeDiscovery() {
  const { db } = makeTestDb();
  const sourceIds = buildCorpus(db);
  const llm = new FakeDiscoveryLlm();
  const service = new DiscoveryService({
    db,
    suggestions: createSuggestionsRepo(db),
    chat: llm,
    chatModel: "test-model",
  });
  return { db, sourceIds, llm, service };
}

describe("découverte (pipeline Phase 2A)", () => {
  it("run complet : paires → batch → suggestions cross-source, statut normalisé, métadonnées", async () => {
    const { db, sourceIds, llm, service } = makeDiscovery();
    const result = await service.run(sourceIds, {
      runId: "run-1",
      sampler: "diversified",
      maxPairs: 8,
      batchSize: 10,
    });

    expect(result.pairsTotal).toBe(8);
    expect(result.created).toHaveLength(7); // candidate 5 : cause sans sens → ignorée
    expect(result.batchCalls).toBe(1); // 8 paires → 1 batch de 10
    expect(llm.calls).toBe(1);
    expect(result.skipped).toEqual({
      duplicate: 0,
      blocked: 0,
      intraSource: 0,
      fragmentMissing: 0,
      causeSideMissing: 1,
      invalidEntry: 0,
      claimRejected: 0,
      claimAnchored: 0,
      claimJuxtaposed: 0,
      nearDuplicate: 0,
    });

    // toutes les suggestions : paires cross-source, métadonnées complètes
    const rows = db
      .prepare(
        `SELECT s.*, fa.source_id AS sa, fb.source_id AS sb
         FROM suggestions s
         JOIN fragments fa ON fa.id = s.fragment_a_id
         JOIN fragments fb ON fb.id = s.fragment_b_id`
      )
      .all() as { sa: string; sb: string; epistemic_status: string; prompt_version: string; chat_model: string }[];
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(r.sa).not.toBe(r.sb);
      expect(r.prompt_version).toBe(DISCOVERY_PROMPT_VERSION);
      expect(r.chat_model).toBe("test-model");
    }
    // candidate 2 : FACT proposé, claim absent → INFERENCE en DB
    const row = db
      .prepare("SELECT epistemic_status FROM suggestions WHERE claim = ?")
      .get(llm.lastBatchClaims[2]) as {
      epistemic_status: string;
    };
    expect(row.epistemic_status).toBe("INFERENCE");
  });

  it("re-run à l'identique : 0 nouvelle suggestion (dédup UNIQUE), batchs rejoués", async () => {
    const { db, sourceIds, service } = makeDiscovery();
    await service.run(sourceIds, { runId: "run-1", sampler: "diversified", maxPairs: 8, batchSize: 10 });
    const second = await service.run(sourceIds, {
      runId: "run-1",
      sampler: "diversified",
      maxPairs: 8,
      batchSize: 10,
    });
    expect(second.created).toHaveLength(0);
    expect(second.skipped.duplicate).toBe(7);
    const count = db.prepare("SELECT COUNT(*) AS n FROM suggestions").get() as { n: number };
    expect(count.n).toBe(7);
  });

  it("cache de prompts : batch identique servi sans appel réseau", async () => {
    const { sourceIds, llm, service } = makeDiscovery();
    const cache = new Map<string, unknown>();
    const first = await service.run(sourceIds, {
      runId: "run-cache",
      sampler: "diversified",
      maxPairs: 8,
      batchSize: 10,
      promptCache: cache,
    });
    const callsAfterFirst = llm.calls;
    expect(first.batchCalls).toBe(1);
    const second = await service.run(sourceIds, {
      runId: "run-cache",
      sampler: "diversified",
      maxPairs: 8,
      batchSize: 10,
      promptCache: cache,
    });
    expect(llm.calls).toBe(callsAfterFirst); // aucun nouvel appel
    expect(second.batchCalls).toBe(0);
    expect(second.batchCallsFromCache).toBe(1);
    expect(second.created).toHaveLength(0); // déjà en DB
  });

  it("reprise au checkpoint : startBatch saute les paires déjà traitées", async () => {
    const { sourceIds, llm, service } = makeDiscovery();
    const full = await service.run(sourceIds, {
      runId: "run-reprise",
      sampler: "diversified",
      maxPairs: 12,
      batchSize: 10,
    });
    expect(full.created).toHaveLength(11); // candidate 5 ignorée (cause sans sens)
    const callsAfter = llm.calls;
    // re-run en reprenant au batch 1 (10 paires traitées) : seules les 2 dernières repartent
    const resumed = await service.run(sourceIds, {
      runId: "run-reprise",
      sampler: "diversified",
      maxPairs: 12,
      batchSize: 10,
      startBatch: 10,
    });
    expect(llm.calls).toBe(callsAfter + 1); // un seul batch (2 paires)
    expect(resumed.batchCalls).toBe(1);
    expect(resumed.created).toHaveLength(0); // déjà en DB
    expect(resumed.skipped.duplicate).toBe(2);
  });

  it("reprise au checkpoint : les compteurs cumulés ne repartent pas de zéro", async () => {
    const { sourceIds, service } = makeDiscovery();
    const progress: { processed: number; created: number; createdIds: string[] }[] = [];
    await service.run(sourceIds, {
      runId: "run-cumul",
      sampler: "diversified",
      maxPairs: 12,
      batchSize: 10,
      onProgress: (i) =>
        progress.push({ processed: i.processed, created: i.created, createdIds: i.createdIds }),
    });
    const afterBatch0 = progress[0];
    expect(afterBatch0.processed).toBe(10);
    expect(afterBatch0.created).toBeGreaterThan(0);

    // reprise après coupure : le batch 0 est déjà en DB, ses créations doivent
    // rester dans le rapport (sinon un run repris sous-estime son propre travail)
    const resumed = await service.run(sourceIds, {
      runId: "run-cumul",
      sampler: "diversified",
      maxPairs: 12,
      batchSize: 10,
      startBatch: 10,
      resume: { createdIds: afterBatch0.createdIds, batchCalls: 1 },
    });
    expect(resumed.created).toHaveLength(0); // batch 1 déjà en DB → doublons
    expect(resumed.createdIds).toEqual(afterBatch0.createdIds);
    expect(resumed.createdIds).toHaveLength(afterBatch0.created);
    expect(resumed.batchCalls).toBe(2); // tentative précédente (1) + batch rejoué (1)
  });

  it("baseline top6 : même budget (paires × batchs), ordre cosine", async () => {
    const { sourceIds, service } = makeDiscovery();
    const result = await service.run(sourceIds, {
      runId: "run-baseline",
      sampler: "top6",
      maxPairs: 8,
      batchSize: 10,
    });
    expect(result.pairsTotal).toBe(8);
    expect(result.batchCalls).toBe(1); // même budget que diversified
  });

  it("barrière qualité : rejette les claims génériques et les quasi-doublons inter-paires", async () => {
    const { db } = makeTestDb();
    const sourceIds = buildCorpus(db);
    const llm = new (class extends FakeDiscoveryLlm {
      async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
        this.calls += 1;
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        const count = (user.match(/--- Paire /g) ?? []).length;
        const results = [];
        for (let i = 0; i < count; i++) {
          const claim = [
            // 0 : générique (« les deux auteurs… »)
            "Les deux auteurs accordent une importance centrale à l'observation.",
            // 1 : repère technique du prompt
            "Texte 1 soutient que la méthode expérimentale progresse par le doute systématique.",
            // 2 : claim valide
            "Le frottement contredit la thèse du granulation.",
            // 3 : reformulation du claim 2 (quasi-doublon)
            "Le frottement contredit, dans les deux cas, la thèse du granulation.",
            // 4 : anglais
            "The two authors share a common view of the experimental method and of doubt.",
            // 5 : claim valide et distinct
            "L'hydration prolonge la thèse du lixiviation.",
          ][i] ?? fakeClaimFromPair(`p${i}`, `q${i}`);
          results.push({
            candidate_id: i,
            claim,
            relation_type: "analogy",
            tier: "medium",
            epistemic_status: "INFERENCE",
          });
        }
        return schema.parse({ results });
      }
    })();
    const service = new DiscoveryService({
      db,
      suggestions: createSuggestionsRepo(db),
      chat: llm,
      chatModel: "test-model",
    });
    const result = await service.run(sourceIds, {
      runId: "run-barriere",
      sampler: "diversified",
      maxPairs: 6,
      batchSize: 6,
    });

    // 3 refus de forme (générique, placeholder, anglais) + 1 quasi-doublon, 2 retenus
    expect(result.skipped.claimRejected).toBe(3);
    expect(result.skipped.nearDuplicate).toBe(1);
    expect(result.skipped.claimAnchored).toBe(0);
    expect(result.skipped.claimJuxtaposed).toBe(0);
    expect(result.created).toHaveLength(2);
    const stored = db.prepare("SELECT COUNT(*) AS n FROM suggestions").get() as { n: number };
    expect(stored.n).toBe(2);
  });

  /**
   * Ancrage lexical (défaut 2, mesuré par `measure-2a-v2` : 13/39 suggestions du run
   * du 2026-09-14). Le modèle fabrique le mot-clé qui relie les deux textes — la
   * connexion devient trouvable par recherche par mots-clés, donc évidente au sens
   * de Q22. La règle est celle de l'évaluateur (`lib/quality/lexical-anchor.ts`).
   */
  it("barrière d'ancrage lexical : rejette une connexion portée par un mot rare partagé", async () => {
    const { db } = makeTestDb();
    // une seule racine (« recommand ») des deux côtés, sous deux formes distinctes :
    // la v1 (termes rares *identiques*) ne voit rien, la v2 (racine) si
    const s1 = makeTextSource(db, "Maitre et eleve.", "Source un");
    const s2 = makeTextSource(db, "Lettres et professeur.", "Source deux");
    for (let i = 0; i < 6; i++) {
      makeFragment(db, {
        sourceId: s1,
        chunkIndex: i,
        text: `Le maitre recommande un nouvel eleve ${i} au professeur. `.repeat(20),
        vector: [0.9 - i * 0.02, 0.1 + i * 0.01, 0, 0, 0, 0, 0, 0],
      });
      makeFragment(db, {
        sourceId: s2,
        chunkIndex: i,
        text: `Des lettres de recommandations ${i} arrivent pour le professeur. `.repeat(20),
        vector: [0.1, 0.8 - i * 0.02, 0, 0, 0, 0, 0, 0],
      });
    }

    const anchored = "Un eleve est confie sur recommandation au maitre de la classe.";
    const llm = new (class extends FakeDiscoveryLlm {
      async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
        this.calls += 1;
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        const count = (user.match(/--- Paire /g) ?? []).length;
        const fragments = [...user.matchAll(/<fragment>\n([\s\S]*?)\n<\/fragment>/g)].map(
          (m) => m[1]
        );
        const results = [];
        for (let i = 0; i < count; i++) {
          results.push({
            candidate_id: i,
            claim:
              i === 0
                ? anchored
                : fakeClaimFromPair(fragments[2 * i] ?? "", fragments[2 * i + 1] ?? ""),
            relation_type: "analogy",
            tier: "medium",
            epistemic_status: "INFERENCE",
          });
        }
        return schema.parse({ results });
      }
    })();
    const service = new DiscoveryService({
      db,
      suggestions: createSuggestionsRepo(db),
      chat: llm,
      chatModel: "test-model",
    });
    const result = await service.run([s1, s2], {
      runId: "run-ancre",
      sampler: "diversified",
      maxPairs: 6,
      batchSize: 6,
    });

    expect(result.skipped.claimAnchored).toBe(1);
    expect(result.created).toHaveLength(5);
    const stored = db
      .prepare("SELECT COUNT(*) AS n FROM suggestions WHERE claim = ?")
      .get(anchored) as { n: number };
    expect(stored.n).toBe(0);
  });

  /**
   * Juxtaposition (défaut 1, mesuré sur `discovery-v4` : le patron dominant de la
   * production était « X dit A, tandis que Y dit B », que les marqueurs génériques
   * ne capturaient pas). La barrière doit couper la coordination vide avant
   * l'insertion, comme pour l'ancrage.
   */
  it("barrière de juxtaposition : rejette deux attributions coordonnées sans relation", async () => {
    const { db } = makeTestDb();
    const s1 = makeTextSource(db, "Methode experimentale.", "Source un");
    const s2 = makeTextSource(db, "Discours et geometrie.", "Source deux");
    for (let i = 0; i < 6; i++) {
      makeFragment(db, {
        sourceId: s1,
        chunkIndex: i,
        text: `Le vivisection du vivant ${i} etablit le determinisme experimental. `.repeat(20),
        vector: [0.9 - i * 0.02, 0.1 + i * 0.01, 0, 0, 0, 0, 0, 0],
      });
      makeFragment(db, {
        sourceId: s2,
        chunkIndex: i,
        text: `La geometrie et l algebre eclairent la physique ${i} du mouvement. `.repeat(20),
        vector: [0.1, 0.8 - i * 0.02, 0, 0, 0, 0, 0, 0],
      });
    }

    const juxtaposed =
      "Bernard considere la vivisection comme methode du vivant, tandis que Descartes examine le mecanisme du mouvement par la geometrie.";
    const llm = new (class extends FakeDiscoveryLlm {
      async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
        this.calls += 1;
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        const count = (user.match(/--- Paire /g) ?? []).length;
        const fragments = [...user.matchAll(/<fragment>\n([\s\S]*?)\n<\/fragment>/g)].map(
          (m) => m[1]
        );
        const results = [];
        for (let i = 0; i < count; i++) {
          results.push({
            candidate_id: i,
            claim:
              i === 0
                ? juxtaposed
                : fakeClaimFromPair(fragments[2 * i] ?? "", fragments[2 * i + 1] ?? ""),
            relation_type: "analogy",
            tier: "medium",
            epistemic_status: "INFERENCE",
          });
        }
        return schema.parse({ results });
      }
    })();
    const service = new DiscoveryService({
      db,
      suggestions: createSuggestionsRepo(db),
      chat: llm,
      chatModel: "test-model",
    });
    const result = await service.run([s1, s2], {
      runId: "run-juxtaposition",
      sampler: "diversified",
      maxPairs: 6,
      batchSize: 6,
    });

    expect(result.skipped.claimJuxtaposed).toBe(1);
    expect(result.created).toHaveLength(5);
    const stored = db
      .prepare("SELECT COUNT(*) AS n FROM suggestions WHERE claim = ?")
      .get(juxtaposed) as { n: number };
    expect(stored.n).toBe(0);
  });

  /**
   * Incident réel (2026-09-14, NVIDIA NIM) : sur un run de validation de 12 batchs,
   * un `503 Service temporarily overloaded` et un timeout 300 s ont consommé **2 des
   * 5 tentatives du job en 4 batchs** — le run ne pouvait pas finir. Un incident
   * passager du provider ne doit coûter ni une paire, ni une tentative de job : il se
   * réessaie au niveau de l'appel (même principe que le 429 déjà géré).
   */
  it("incident passager du provider : le batch est réessayé, aucune paire perdue", async () => {
    const { db } = makeTestDb();
    const sourceIds = buildCorpus(db);
    class FlakyLlm extends FakeDiscoveryLlm {
      failuresLeft = 2;
      async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
        if (this.failuresLeft > 0) {
          this.failuresLeft -= 1;
          throw new LlmTransientError("HTTP 503 — Service temporarily overloaded");
        }
        return super.chat(messages, schema);
      }
    }
    const llm = new FlakyLlm();
    const service = new DiscoveryService({
      db,
      suggestions: createSuggestionsRepo(db),
      chat: llm,
      chatModel: "test-model",
    });

    // les réessais sont espacés (backoff ~2 s puis ~4 s) : horloge simulée, sinon le
    // test paierait réellement l'attente
    vi.useFakeTimers();
    let result: Awaited<ReturnType<DiscoveryService["run"]>>;
    try {
      const pending = service.run(sourceIds, {
        runId: "run-instabilite",
        sampler: "diversified",
        maxPairs: 8,
        batchSize: 8,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      result = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(llm.failuresLeft).toBe(0); // les deux incidents ont bien eu lieu
    expect(result.created).toHaveLength(7); // candidate 5 : cause sans sens → ignorée
    // un seul batch réellement facturé : les réessais ne comptent pas comme des appels
    expect(result.batchCalls).toBe(1);
  });
});

describe("worker : job discover", () => {
  it("process() : progress_json rempli (created_ids) puis done", async () => {
    const { db } = makeTestDb();
    const sourceIds = buildCorpus(db);
    const sources = createSourcesRepo(db);
    const fragments = createFragmentsRepo(db);
    const jobs = createJobsRepo(db);
    const llm = new FakeDiscoveryLlm();
    const discover = new DiscoveryService({
      db,
      suggestions: createSuggestionsRepo(db),
      chat: llm,
      chatModel: "test-model",
    });
    const worker = new Worker({
      jobs,
      ingest: new IngestService({
        db,
        sources,
        fragments,
        jobs,
        embedder: makeFakeEmbedder(8),
        chatModel: "test-model",
      }),
      summary: new SummaryService({
        db,
        sources,
        jobs,
        llm: llm as unknown as LlmProvider,
        chatModel: "test-model",
        groqKeyMissing: false,
      }),
      discover,
    });

    const job = jobs.createJob({
      kind: "discover",
      payload: { run_id: "run-worker", source_ids: sourceIds, sampler: "diversified", max_pairs: 8, batch_size: 10 },
      sourceId: null,
      idempotencyKey: idempotencyKey(["discover", "run-worker"]),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    const done = jobs.getById(job.id);
    expect(done?.status).toBe("done");
    const summary = JSON.parse(done?.progress_json as string);
    expect(summary.run_id).toBe("run-worker");
    expect(summary.created).toBe(7); // candidate 5 ignorée (cause sans sens)
    expect(summary.created_ids).toHaveLength(7);
    expect(summary.pairs).toBe(8);
  });
});