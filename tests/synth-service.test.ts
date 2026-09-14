import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeFakeEmbedder, makeFragment, makeTestDb, makeTextSource } from "./helpers";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";
import { createThemesRepo } from "@/lib/repositories/themes";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createJobsRepo, idempotencyKey, type ClaimedJob } from "@/lib/repositories/jobs";
import { IngestService } from "@/lib/ingest/ingest-service";
import { SummaryService } from "@/lib/ingest/summary-service";
import { Worker } from "@/lib/jobs/worker";
import {
  SynthesisService,
  SeedRunConflictError,
  type SynthesisRunOptions,
} from "@/lib/synth/synth-service";
import { SYNTHESIS_PROMPT_VERSION } from "@/lib/synth/prompts";

/** Provider scripté : la Nième réponse est choisie par le test, sans réseau. */
class ScriptedChat implements LlmProvider {
  readonly calls: ChatMessage[][] = [];
  constructor(private reply: (call: number) => unknown) {}

  async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    this.calls.push(messages);
    return schema.parse(this.reply(this.calls.length - 1)) as z.infer<T>;
  }

  async embed(): Promise<number[]> {
    return [];
  }
}

const answer = (text: string) => ({
  synthesis: text,
  relation_kind: "combination",
  evidence: [0, 1],
  confidence: "medium",
  epistemic_status: "INFERENCE",
});

/** Énoncés disjoints : aucun ne reformule l'autre (anti-quasi-doublon inter-thèmes). */
const SYNTHESIS_TEXTS = [
  "Rendre visible la contrainte qui pese sur un ouvrage releve moins du calcul que d'un choix de mise en scene.",
  "Deux regimes d'ecriture opposent la mesure chiffree a l'appreciation qualitative du phenomene observe.",
  "La fidelite d'un temoignage depend davantage de sa coherence interne que de la precision des faits rapportes.",
  "Une hierarchie invisible organise le travail avant que la regle explicite ne vienne la nommer.",
];

interface Entry {
  text: string;
  vector: number[];
  title: string;
}

/** 4 groupes orthogonaux de 2 fragments, chaque fragment dans sa propre source. */
const CORPUS: Entry[] = [
  {
    text: "Le beton brut affirme la charge portee par la facade.",
    vector: [1, 0, 0, 0, 0, 0, 0, 0],
    title: "Architecture un",
  },
  {
    text: "L'ossature exprime la trame sans ornement ajoute.",
    vector: [0.9, 0.44, 0, 0, 0, 0, 0, 0],
    title: "Architecture deux",
  },
  {
    text: "L'amortissement fiscal etale la depense sur plusieurs exercices.",
    vector: [0, 1, 0, 0, 0, 0, 0, 0],
    title: "Comptabilite un",
  },
  {
    text: "Le bilan comptable differe la reconnaissance du cout engage.",
    vector: [0, 0.9, 0.44, 0, 0, 0, 0, 0],
    title: "Comptabilite deux",
  },
  {
    text: "La mitochondrie fournit l'energie necessaire a la cellule.",
    vector: [0, 0, 1, 0, 0, 0, 0, 0],
    title: "Biologie un",
  },
  {
    text: "Le neurone transmet un signal electrique par synapse.",
    vector: [0, 0, 0.9, 0.44, 0, 0, 0, 0],
    title: "Biologie deux",
  },
  {
    text: "Le droit romain distingue la propriete de la possession.",
    vector: [0, 0, 0, 1, 0, 0, 0, 0],
    title: "Droit un",
  },
  {
    text: "La coutume locale prime sur la regle generale dans cette province.",
    vector: [0, 0, 0, 0.9, 0.44, 0, 0, 0],
    title: "Droit deux",
  },
];

function makeSetup(opts: { entries?: Entry[]; reply?: (call: number) => unknown } = {}) {
  const entries = opts.entries ?? CORPUS;
  const reply = opts.reply;
  const { db } = makeTestDb();
  const sourceIds = entries.map((e) => {
    const sourceId = makeTextSource(db, `${e.title} — ${e.text}`, e.title);
    makeFragment(db, { sourceId, text: e.text, vector: e.vector });
    return sourceId;
  });
  const themes = createThemesRepo(db);
  const syntheses = createSynthesesRepo(db);
  const chat = new ScriptedChat(
    reply ?? ((call) => answer(SYNTHESIS_TEXTS[call % SYNTHESIS_TEXTS.length]))
  );
  const service = new SynthesisService({ db, themes, syntheses, chat, chatModel: "test-chat" });
  return { db, sourceIds, themes, syntheses, chat, service };
}

const RUN: SynthesisRunOptions = { runId: "run-5a", totalSeeds: 1 };

const countSyntheses = (db: ReturnType<typeof makeTestDb>["db"]): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM syntheses").get() as { n: number }).n;

describe("service de synthèse (Phase 5A étape 4)", () => {
  it("produit une synthèse multi-sources traçable, avec provenance des fragments réels", async () => {
    const { db, sourceIds, themes, syntheses, chat, service } = makeSetup();

    // 4 graines : les 4 paires de fragments sémantiquement proches (cosinus 0,9)
    const result = await service.run(sourceIds, { ...RUN, totalSeeds: 4 });

    expect(result.seedsTotal).toBe(4);
    expect(result.seedIds).toHaveLength(4);
    expect(themes.countByRun("run-5a")).toBe(4);
    expect(result.llmCalls).toBe(4);
    expect(result.syntheses).toHaveLength(4);
    expect(result.skipped).toMatchObject({ rejected: 0, intraSource: 0, noEvidence: 0 });

    const created = result.syntheses[0];
    expect(new Set(created.evidence.map((e) => e.sourceId)).size).toBe(2);
    expect(created.relationKind).toBe("combination");
    expect(created.epistemicStatus).toBe("INFERENCE");

    // le prompt ne contient que des indices de preuves, jamais d'ID de fragment
    const userMessage = chat.calls[0][1].content;
    expect(userMessage).toContain("--- Preuve 0");
    for (const id of created.evidence.map((e) => e.fragmentId)) {
      expect(userMessage).not.toContain(id);
    }

    const row = db.prepare("SELECT * FROM syntheses WHERE id = ?").get(created.id) as {
      parent_source_ids: string;
      evidence_fragment_ids: string;
      provenance_snapshot: string;
      prompt_version: string;
      chat_model: string;
      state: string;
      stale: number;
      theme_id: string;
    };
    // les sources parentes sont dérivées des fragments, pas de la déclaration du modèle
    expect((JSON.parse(row.parent_source_ids) as string[]).sort()).toEqual(
      created.evidence.map((e) => e.sourceId).sort()
    );
    expect(JSON.parse(row.evidence_fragment_ids)).toEqual(
      created.evidence.map((e) => e.fragmentId)
    );
    expect(row.prompt_version).toBe(SYNTHESIS_PROMPT_VERSION);
    expect(row.chat_model).toBe("test-chat");
    expect(row.state).toBe("proposed");
    expect(row.stale).toBe(0);

    const snapshot = JSON.parse(row.provenance_snapshot) as {
      source_id: string;
      source_title: string | null;
      content_hash: string;
      locator: string;
      text: string;
    }[];
    expect(snapshot).toHaveLength(2);
    for (const entry of snapshot) {
      expect(entry.source_id).toBeTruthy();
      expect(entry.source_title).toBeTruthy();
      expect(entry.content_hash).toHaveLength(64);
      expect(entry.locator).toContain("[");
      expect(entry.text.length).toBeGreaterThan(0);
    }
    expect(syntheses.listByTheme(row.theme_id)).toHaveLength(1);
  });

  it("rejoue le même run sans insérer de nouvelle synthèse (graines réutilisées)", async () => {
    // même prompt ⇒ même réponse du modèle : c'est le cas d'un rejeu réel
    const { db, sourceIds, themes, service } = makeSetup({
      reply: () => answer(SYNTHESIS_TEXTS[0]),
    });
    const first = await service.run(sourceIds, RUN);
    expect(first.syntheses).toHaveLength(1);

    const second = await service.run(sourceIds, {
      ...RUN,
      resume: { createdIds: first.createdIds },
    });

    expect(second.syntheses).toHaveLength(0);
    expect(second.createdIds).toEqual(first.createdIds);
    // un run = un jeu de graines : rejouer ne duplique pas l'ancrage
    expect(themes.countByRun("run-5a")).toBe(1);
    expect(countSyntheses(db)).toBe(1);
    // l'énoncé existant est reconnu comme quasi-doublon (couvert par le run)
    expect(second.skipped.nearDuplicate).toBe(1);
  });

  it("refuse un énoncé générique par la barrière déterministe (0 insertion)", async () => {
    const { db, sourceIds, service } = makeSetup({
      reply: () => answer("Les deux documents accordent une importance centrale a la structure."),
    });

    const result = await service.run(sourceIds, RUN);

    expect(result.syntheses).toHaveLength(0);
    expect(result.skipped.rejected).toBe(1);
    expect(result.rejectedByReason.generic).toBe(1);
    expect(countSyntheses(db)).toBe(0);
  });

  it("n'apparie jamais deux quasi-doublons : une graine ne vaut que par deux documents distincts", async () => {
    // le 2ᵉ fragment du dernier groupe est quasi identique au 1ᵉʳ (cosinus 0,99) :
    // les rapprocher ne produirait rien qu'un seul ne dit déjà (filtre de la graine)
    const entries = CORPUS.map((e, i) =>
      i === 7 ? { ...e, vector: [0, 0, 0, 0.99, 0.14, 0, 0, 0] } : e
    );
    const { db, sourceIds, chat, service } = makeSetup({ entries });

    const result = await service.run(sourceIds, { runId: "run-5a", totalSeeds: 4 });

    // la paire quasi identique est écartée, remplacée par un autre rapprochement :
    // le run reste complet (4 graines, 4 énoncés)
    expect(result.seedsTotal).toBe(4);
    expect(result.syntheses).toHaveLength(4);
    expect(countSyntheses(db)).toBe(4);
    for (const call of chat.calls) {
      const content = call[1].content;
      expect(content.includes(entries[6].text) && content.includes(entries[7].text)).toBe(false);
    }
  });

  it("ne formule pas deux fois la même idée sur des graines différentes", async () => {
    // même réponse pour toutes les graines : seule la première est retenue
    const { db, sourceIds, service } = makeSetup({ reply: () => answer(SYNTHESIS_TEXTS[0]) });

    const result = await service.run(sourceIds, { runId: "run-5a", totalSeeds: 4 });

    expect(result.syntheses).toHaveLength(1);
    expect(result.skipped.nearDuplicate).toBe(3);
    expect(countSyntheses(db)).toBe(1);
  });

  it("refuse de rejouer un runId déjà persisté avec un autre corpus", async () => {
    const { sourceIds, service } = makeSetup();
    await service.run(sourceIds, RUN);
    await expect(service.run([sourceIds[0]], RUN)).rejects.toBeInstanceOf(SeedRunConflictError);
  });

  it("respecte la capacité d'une graine (déjà synthétisée) sur un rejeu", async () => {
    const { sourceIds, service } = makeSetup();
    const first = await service.run(sourceIds, RUN);
    expect(first.syntheses).toHaveLength(1);

    const second = await service.run(sourceIds, {
      ...RUN,
      maxSynthesesPerSeed: 1,
      resume: { createdIds: first.createdIds },
    });

    expect(second.syntheses).toHaveLength(0);
    expect(second.skipped.capacity).toBe(1);
  });
});

const countRows = (db: ReturnType<typeof makeTestDb>["db"], table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("baseline « résumé » (protocole Q25)", () => {
  it("ne persiste rien, garde le même budget, et n'est pas filtré par la barrière", async () => {
    // énoncé refusé par la barrière (formule générique) : c'est le contrôle à budget
    // égal, un résumé doit pouvoir être générique sans être écarté
    const { db, sourceIds, chat, service } = makeSetup({
      reply: () => answer("Les deux documents accordent une importance centrale a la structure."),
    });

    const baseline = await service.run(sourceIds, {
      runId: "run-base",
      totalSeeds: 1,
      mode: "baseline",
    });

    expect(baseline.mode).toBe("baseline");
    expect(baseline.syntheses).toHaveLength(1);
    expect(baseline.syntheses[0].id).toContain("baseline:");
    expect(baseline.syntheses[0].evidence.length).toBeGreaterThanOrEqual(2);
    expect(baseline.createdIds).toEqual([]);
    expect(baseline.skipped.rejected).toBe(0);
    // rien n'est écrit : ni ancrage, ni synthèses
    expect(countRows(db, "themes")).toBe(0);
    expect(countRows(db, "syntheses")).toBe(0);

    const synthesis = await service.run(sourceIds, { runId: "run-syn", totalSeeds: 1 });
    expect(synthesis.mode).toBe("synthesis");
    expect(synthesis.syntheses).toHaveLength(0);
    expect(synthesis.skipped.rejected).toBe(1);
    expect(synthesis.rejectedByReason.generic).toBe(1);
    expect(countRows(db, "syntheses")).toBe(0);

    // budget égal : un appel LLM par graine dans les deux modes
    expect(baseline.llmCalls).toBe(1);
    expect(synthesis.llmCalls).toBe(1);
    expect(chat.calls).toHaveLength(2);
    // et la consigne change bien (résumer vs ajouter)
    expect(chat.calls[0][0].content).toContain("résumes");
    expect(chat.calls[0][0].content).not.toContain("TEST DE LA SOUSTRACTION");
    expect(chat.calls[1][0].content).toContain("TEST DE LA SOUSTRACTION");
  });
});

describe("worker : job synthesize", () => {
  it("process() : rapport dans progress_json puis done (mode synthesis)", async () => {
    const { db } = makeTestDb();
    const entries = CORPUS;
    const sourceIds = entries.map((e) => {
      const sourceId = makeTextSource(db, `${e.title} — ${e.text}`, e.title);
      makeFragment(db, { sourceId, text: e.text, vector: e.vector });
      return sourceId;
    });
    const sources = createSourcesRepo(db);
    const fragments = createFragmentsRepo(db);
    const jobs = createJobsRepo(db);
    const chat = new ScriptedChat((call) => answer(SYNTHESIS_TEXTS[call % SYNTHESIS_TEXTS.length]));
    const synthesize = new SynthesisService({
      db,
      themes: createThemesRepo(db),
      syntheses: createSynthesesRepo(db),
      chat,
      chatModel: "test-chat",
    });
    const worker = new Worker({
      jobs,
      ingest: new IngestService({
        db,
        sources,
        fragments,
        jobs,
        embedder: makeFakeEmbedder(8),
        chatModel: "test-chat",
      }),
      summary: new SummaryService({
        db,
        sources,
        jobs,
        llm: chat,
        chatModel: "test-chat",
        groqKeyMissing: false,
      }),
      synthesize,
    });

    const job = jobs.createJob({
      kind: "synthesize",
      // délai inter-graine à 0 : le défaut du worker (65 s) est une fenêtre de
      // quota, pas quelque chose qu'un test doit attendre
      payload: {
        run_id: "run-worker-5a",
        source_ids: sourceIds,
        max_seeds: 2,
        inter_seed_delay_ms: 0,
      },
      sourceId: null,
      idempotencyKey: idempotencyKey(["synthesize", "run-worker-5a"]),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    const done = jobs.getById(job.id);
    expect(done?.status).toBe("done");
    const summary = JSON.parse(done?.progress_json as string);
    expect(summary.run_id).toBe("run-worker-5a");
    expect(summary.mode).toBe("synthesis");
    expect(summary.seeds_total).toBe(2);
    expect(summary.created).toBe(2);
    expect(summary.created_ids).toHaveLength(2);
    expect(summary.llm_calls).toBe(2);
    // un run de production ne transporte pas d'énoncés hors base
    expect(summary.baseline_items).toBeUndefined();
  });

  /**
   * Constaté en réel le 2026-09-13 : un run lancé avec `--max-themes=12` a traité
   * 24 thèmes. Un 429 avait provoqué une reprise au checkpoint, et le plafond était
   * réappliqué comme **taille de fenêtre** (12 de plus) au lieu d'un plafond du run.
   * `max_seeds` borne désormais le run entier : le service construit exactement ce
   * nombre de graines et traite `[startSeed, total]`.
   */
  it("process() : une reprise au checkpoint respecte le plafond du run (pas de fenêtre supplémentaire)", async () => {
    const { db } = makeTestDb();
    const sourceIds = CORPUS.map((e) => {
      const sourceId = makeTextSource(db, `${e.title} — ${e.text}`, e.title);
      makeFragment(db, { sourceId, text: e.text, vector: e.vector });
      return sourceId;
    });
    const jobs = createJobsRepo(db);
    const chat = new ScriptedChat(() => answer(SYNTHESIS_TEXTS[0]));
    const worker = new Worker({
      jobs,
      ingest: new IngestService({
        db,
        sources: createSourcesRepo(db),
        fragments: createFragmentsRepo(db),
        jobs,
        embedder: makeFakeEmbedder(8),
        chatModel: "test-chat",
      }),
      summary: new SummaryService({
        db,
        sources: createSourcesRepo(db),
        jobs,
        llm: chat,
        chatModel: "test-chat",
        groqKeyMissing: false,
      }),
      synthesize: new SynthesisService({
        db,
        themes: createThemesRepo(db),
        syntheses: createSynthesesRepo(db),
        chat,
        chatModel: "test-chat",
      }),
    });

    const job = jobs.createJob({
      kind: "synthesize",
      payload: { run_id: "run-cap", source_ids: sourceIds, max_seeds: 2, inter_seed_delay_ms: 0 },
      sourceId: null,
      idempotencyKey: idempotencyKey(["synthesize", "run-cap"]),
    });
    // la tentative précédente avait traité les 2 graines autorisées puis échoué
    db.prepare("UPDATE jobs SET checkpoint = ?, progress_json = ? WHERE id = ?").run(
      JSON.stringify({ done_seeds: 2, total_seeds: 2 }),
      JSON.stringify({ created_ids: [], llm_calls: 2, llm_calls_from_cache: 0 }),
      job.id
    );
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    const done = jobs.getById(job.id);
    expect(done?.status).toBe("done");
    const summary = JSON.parse(done?.progress_json as string);
    expect(summary.created).toBe(0);
    expect(summary.llm_calls).toBe(2); // compteurs cumulés, aucun appel de plus
    expect(chat.calls).toHaveLength(0);
  });

  it("process() : un baseline transporte ses énoncés hors base (baseline_items)", async () => {
    const { db } = makeTestDb();
    const sourceIds = CORPUS.map((e) => {
      const sourceId = makeTextSource(db, `${e.title} — ${e.text}`, e.title);
      makeFragment(db, { sourceId, text: e.text, vector: e.vector });
      return sourceId;
    });
    const sources = createSourcesRepo(db);
    const fragments = createFragmentsRepo(db);
    const jobs = createJobsRepo(db);
    const chat = new ScriptedChat((call) => answer(SYNTHESIS_TEXTS[call % SYNTHESIS_TEXTS.length]));
    const synthesize = new SynthesisService({
      db,
      themes: createThemesRepo(db),
      syntheses: createSynthesesRepo(db),
      chat,
      chatModel: "test-chat",
    });
    const worker = new Worker({
      jobs,
      ingest: new IngestService({
        db,
        sources,
        fragments,
        jobs,
        embedder: makeFakeEmbedder(8),
        chatModel: "test-chat",
      }),
      summary: new SummaryService({
        db,
        sources,
        jobs,
        llm: chat,
        chatModel: "test-chat",
        groqKeyMissing: false,
      }),
      synthesize,
    });

    const job = jobs.createJob({
      kind: "synthesize",
      payload: {
        run_id: "run-worker-base",
        source_ids: sourceIds,
        mode: "baseline",
        max_seeds: 1,
        inter_seed_delay_ms: 0,
      },
      sourceId: null,
      idempotencyKey: idempotencyKey(["synthesize", "run-worker-base"]),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    const done = jobs.getById(job.id);
    expect(done?.status).toBe("done");
    const summary = JSON.parse(done?.progress_json as string);
    expect(summary.mode).toBe("baseline");
    expect(summary.created).toBe(0);
    expect(summary.baseline_items).toHaveLength(1);
    expect(summary.baseline_items[0].text.length).toBeGreaterThan(0);
    expect(summary.baseline_items[0].evidence.length).toBeGreaterThanOrEqual(2);
    // et la base reste vierge de tout ancrage comme de toute synthèse
    expect(countRows(db, "themes")).toBe(0);
    expect(countRows(db, "syntheses")).toBe(0);
  });

  /**
   * Un baseline n'écrit rien en base : ses énoncés n'existent que dans le checkpoint.
   * Défaut trouvé sur le run réel du 2026-09-14 : la coupure provider du 5e appel a
   * fait reprendre le run à la graine suivante et les 4 premiers résumés ont disparu —
   * le contrôle Q25 aurait comparé 11 synthèses à 8 résumés. Le checkpoint transporte
   * désormais les énoncés déjà calculés.
   */
  it("process() : une reprise de baseline conserve les résumés déjà calculés", async () => {
    const { db } = makeTestDb();
    const sourceIds = CORPUS.map((e) => {
      const sourceId = makeTextSource(db, `${e.title} — ${e.text}`, e.title);
      makeFragment(db, { sourceId, text: e.text, vector: e.vector });
      return sourceId;
    });
    const jobs = createJobsRepo(db);
    const chat = new ScriptedChat((call) => answer(SYNTHESIS_TEXTS[call % SYNTHESIS_TEXTS.length]));
    const worker = new Worker({
      jobs,
      ingest: new IngestService({
        db,
        sources: createSourcesRepo(db),
        fragments: createFragmentsRepo(db),
        jobs,
        embedder: makeFakeEmbedder(8),
        chatModel: "test-chat",
      }),
      summary: new SummaryService({
        db,
        sources: createSourcesRepo(db),
        jobs,
        llm: chat,
        chatModel: "test-chat",
        groqKeyMissing: false,
      }),
      synthesize: new SynthesisService({
        db,
        themes: createThemesRepo(db),
        syntheses: createSynthesesRepo(db),
        chat,
        chatModel: "test-chat",
      }),
    });

    const job = jobs.createJob({
      kind: "synthesize",
      payload: {
        run_id: "run-base-resume",
        source_ids: sourceIds,
        mode: "baseline",
        max_seeds: 4,
        inter_seed_delay_ms: 0,
      },
      sourceId: null,
      idempotencyKey: idempotencyKey(["synthesize", "run-base-resume"]),
    });
    // la tentative précédente avait traité 2 graines puis échoué (provider)
    const doneItems = [
      { id: "baseline:0", text: SYNTHESIS_TEXTS[0], evidence: [] },
      { id: "baseline:1", text: SYNTHESIS_TEXTS[1], evidence: [] },
    ];
    db.prepare("UPDATE jobs SET checkpoint = ?, progress_json = ? WHERE id = ?").run(
      JSON.stringify({ done_seeds: 2, total_seeds: 4 }),
      JSON.stringify({
        llm_calls: 2,
        llm_calls_from_cache: 0,
        baseline_items: doneItems,
      }),
      job.id
    );
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    const done = jobs.getById(job.id);
    expect(done?.status).toBe("done");
    const summary = JSON.parse(done?.progress_json as string);
    const items = summary.baseline_items as { id: string }[];
    // 2 résumés repris + 2 graines traitées par cette tentative
    expect(items).toHaveLength(4);
    expect(items.slice(0, 2).map((i) => i.id)).toEqual(["baseline:0", "baseline:1"]);
    expect(summary.llm_calls).toBe(4); // 2 cumulés + 2 de cette tentative
    // rien n'a été persisté : un baseline ne pollue jamais le corpus de production
    expect(countRows(db, "themes")).toBe(0);
    expect(countRows(db, "syntheses")).toBe(0);
  });
});
