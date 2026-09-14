import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";
import { createPromptCache } from "@/lib/repositories/llm-cache";
import { createThemesRepo } from "@/lib/repositories/themes";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import { SynthesisService } from "@/lib/synth/synth-service";

describe("cache de prompt persisté", () => {
  it("rend la même valeur à travers deux instances (persistance réelle)", () => {
    const { db } = makeTestDb();
    createPromptCache(db).set("k1", { synthesis: "une réponse", evidence: [0, 1] });
    // nouvelle instance : ce que fait un nouveau démon worker sur la même base
    expect(createPromptCache(db).get("k1")).toEqual({
      synthesis: "une réponse",
      evidence: [0, 1],
    });
  });

  it("ne sert rien pour une autre clé (jamais de réponse détournée)", () => {
    const { db } = makeTestDb();
    const cache = createPromptCache(db);
    cache.set("modele-A|v1|prompt", { ok: true });
    expect(cache.get("modele-B|v1|prompt")).toBeUndefined();
    expect(cache.get("modele-A|v2|prompt")).toBeUndefined();
  });

  it("refuse une entrée illisible au lieu de la propager", () => {
    const { db } = makeTestDb();
    db.prepare("INSERT INTO llm_cache (key, value, created_at) VALUES (?, ?, ?)").run(
      "casse",
      "{ pas du json",
      new Date().toISOString()
    );
    expect(createPromptCache(db).get("casse")).toBeUndefined();
  });

  it("écrase la valeur d'une clé réutilisée", () => {
    const { db } = makeTestDb();
    const cache = createPromptCache(db);
    cache.set("k", { v: 1 });
    cache.set("k", { v: 2 });
    expect(cache.get("k")).toEqual({ v: 2 });
    expect(
      (db.prepare("SELECT count(*) AS c FROM llm_cache").get() as { c: number }).c
    ).toBe(1);
  });
});

/**
 * Le point qui compte : sur un vrai modèle, la même question reçoit une réponse
 * **reformulée**. Sans cache, `content_sig` ne peut donc rien dédupliquer et un
 * rejeu de run insère de nouvelles synthèses — l'AC2 tombe. Ces deux tests
 * opposent les deux situations avec le même provider stochastique.
 */
class StochasticChat implements LlmProvider {
  calls = 0;
  readonly messages: ChatMessage[][] = [];
  /** `failOnCall` : rang (1-based) de l'appel qui échoue — simule une coupure provider. */
  constructor(
    private templates: string[],
    private failOnCall?: number
  ) {}

  async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    // chaque appel produit une formulation différente (aucune ne contient l'autre)
    this.messages.push(messages);
    if (this.failOnCall !== undefined && this.messages.length === this.failOnCall) {
      throw new Error("provider indisponible (test)");
    }
    const text = this.templates[this.calls % this.templates.length];
    this.calls += 1;
    return schema.parse({
      synthesis: text,
      relation_kind: "combination",
      evidence: [0, 1],
      confidence: "medium",
      epistemic_status: "INFERENCE",
    }) as z.infer<T>;
  }

  async embed(): Promise<number[]> {
    return [];
  }
}

/** 8 formulations distinctes : le 2e run d'un modèle stochastique reformule (indices 4–7). */
const VARIANTS = [
  "L'absence de grille publique transforme la discussion en epreuve de force entre deux positions inegales.",
  "Aucun laboratoire ne peut comparer deux campagnes de relevés sans fixer au préalable une unité commune.",
  "La coutume locale prime tant que le juge n'en a pas constaté l'opposition avec une regle superieure.",
  "Un signal n'a de sens que rapporte a la fonction qu'il permet d'accomplir dans l'ensemble.",
  "Fixer un prix a l'avance suppose de connaitre ce que la confection coutera reellement.",
  "Deux series d'observations ne se comparent que si l'appareil de mesure reste identique.",
  "L'ordre juridique reconnait deux sources concurrentes dont la hierarchie se decide au cas par cas.",
  "Une fonction biologique s'explique par la cooperation des parties, non par l'organe isole.",
];

/** 4 paires de fragments proches (8 sources distinctes) : les graines du run. */
const ENTRIES: { text: string; vector: number[] }[] = [
  { text: "Le tailleur vendait chaque habit sans aucun bareme.", vector: [1, 0, 0, 0, 0, 0, 0, 0] },
  { text: "La commande se negociait piece par piece avec le client.", vector: [0.9, 0.44, 0, 0, 0, 0, 0, 0] },
  { text: "La sonde mesurait la salinite de l'eau prelevee.", vector: [0, 1, 0, 0, 0, 0, 0, 0] },
  { text: "Le capteur enregistrait la pression a chaque palier.", vector: [0, 0.9, 0.44, 0, 0, 0, 0, 0] },
  { text: "Le droit romain distingue la propriete de la possession.", vector: [0, 0, 1, 0, 0, 0, 0, 0] },
  { text: "La coutume provinciale supplee le silence de la loi ecrite.", vector: [0, 0, 0.9, 0.44, 0, 0, 0, 0] },
  { text: "La mitochondrie fournit l'energie necessaire a la cellule.", vector: [0, 0, 0, 1, 0, 0, 0, 0] },
  { text: "Le neurone transmet un signal electrique par synapse.", vector: [0, 0, 0, 0.9, 0.44, 0, 0, 0] },
];

function makeStochasticSetup(): {
  db: ReturnType<typeof makeTestDb>["db"];
  sourceIds: string[];
  chat: StochasticChat;
  service: import("@/lib/synth/synth-service").SynthesisService;
  /** Même base et même cache, mais un autre réglage de chat (clé de cache distincte). */
  serviceWith: (chatSignature?: string) => import("@/lib/synth/synth-service").SynthesisService;
  cache: ReturnType<typeof createPromptCache>;
} {
  const { db } = makeTestDb();
  const sourceIds = ENTRIES.map((e, i) => {
    const sourceId = makeTextSource(db, `${e.text} (${i})`, `Auteur ${i + 1}`);
    makeFragment(db, { sourceId, text: e.text, vector: e.vector });
    return sourceId;
  });
  const chat = new StochasticChat(VARIANTS);
  const serviceWith = (chatSignature?: string): SynthesisService =>
    new SynthesisService({
      db,
      themes: createThemesRepo(db),
      syntheses: createSynthesesRepo(db),
      chat,
      chatModel: "test-chat",
      chatSignature,
    });
  const service = serviceWith();
  return { db, sourceIds, chat, service, serviceWith, cache: createPromptCache(db) };
}

const count = (db: ReturnType<typeof makeTestDb>["db"], table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("AC2 — rejeu de run avec et sans cache persisté", () => {
  it("avec cache : 2e run = 0 appel LLM, 0 nouvelle synthèse", async () => {
    const { db, sourceIds, chat, service, cache } = makeStochasticSetup();

    const first = await service.run(sourceIds, {
      runId: "run-cache",
      totalSeeds: 4,
      promptCache: cache,
    });
    expect(first.syntheses).toHaveLength(4);
    const callsAfterFirst = chat.calls;

    const second = await service.run(sourceIds, {
      runId: "run-cache",
      totalSeeds: 4,
      promptCache: cache,
    });

    expect(chat.calls).toBe(callsAfterFirst); // aucun nouvel appel réseau
    expect(second.llmCalls).toBe(0);
    expect(second.llmCallsFromCache).toBe(4);
    // rien de neuf : les 4 énoncés du run sont reconnus comme déjà couverts
    expect(second.syntheses).toHaveLength(0);
    expect(second.skipped.nearDuplicate).toBe(4);
    expect(count(db, "syntheses")).toBe(4);
    const ids = (db.prepare("SELECT id FROM syntheses").all() as { id: string }[]).map((r) => r.id);
    expect([...ids].sort()).toEqual([...first.createdIds].sort());
  });

  /**
   * L'attente inter-graines protège la **fenêtre de quota du provider** : elle n'a de
   * sens que si la graine a réellement appelé le LLM. Sur un rejeu servi par le cache,
   * zéro appel ⇒ zéro attente. Défaut trouvé sur le rejeu réel du 2026-09-14 : le rejeu
   * payait 12 × 65 s pour aucun appel, dépassait le `--wait` du CLI et n'était donc
   * jamais rapporté (le run restait « non évaluable »).
   */
  it("un rejeu servi par le cache ne paie pas l'attente inter-graines", async () => {
    const { sourceIds, service, cache } = makeStochasticSetup();
    const delay = 150;
    const seeds = {
      runId: "run-delay",
      totalSeeds: 4,
      promptCache: cache,
      interSeedDelayMs: delay,
    };

    const t0 = Date.now();
    const first = await service.run(sourceIds, seeds);
    // contrôle : quand les 4 graines appellent réellement, les 3 intervalles sont payés
    expect(Date.now() - t0).toBeGreaterThanOrEqual(delay * 3);
    expect(first.llmCalls).toBe(4);

    const t1 = Date.now();
    const replay = await service.run(sourceIds, seeds);
    const replayElapsed = Date.now() - t1;

    expect(replay.llmCalls).toBe(0);
    expect(replay.llmCallsFromCache).toBe(4);
    expect(replayElapsed).toBeLessThan(delay);
  });

  /**
   * Cas réel du 2026-09-13 : un run interrompu (503 du provider) et repris au
   * checkpoint repartait avec une liste « déjà formulé » **vide**, donc les prompts
   * des thèmes suivants différaient du premier passage, la clé de cache changeait et
   * le modèle était rappelé — chaque reprise insérait de nouvelles synthèses.
   * Le « déjà formulé » vient désormais des énoncés **persistés** du run, filtrés aux
   * thèmes précédents : reprise et passage unique produisent les mêmes prompts.
   */
  it("une reprise au checkpoint produit exactement les mêmes prompts qu'un passage unique", async () => {
    const full = makeStochasticSetup();
    const r1 = await full.service.run(full.sourceIds, { runId: "run-resume", totalSeeds: 4 });
    expect(r1.syntheses).toHaveLength(4);

    // tentative interrompue : le provider tombe au 3e appel, après 2 graines
    const split = makeStochasticSetup();
    const brittle = new StochasticChat(VARIANTS, 3);
    const service = new SynthesisService({
      db: split.db,
      themes: createThemesRepo(split.db),
      syntheses: createSynthesesRepo(split.db),
      chat: brittle,
      chatModel: "test-chat",
    });
    const persisted = () =>
      (split.db.prepare("SELECT COUNT(*) AS n FROM syntheses").get() as { n: number }).n;
    await expect(service.run(split.sourceIds, { runId: "run-resume", totalSeeds: 4 })).rejects.toThrow(
      "provider indisponible"
    );
    expect(persisted()).toBe(2);

    // reprise : le worker repart à la graine suivante avec les compteurs cumulés
    const resumed = await service.run(split.sourceIds, {
      runId: "run-resume",
      totalSeeds: 4,
      startSeed: 2,
      resume: { llmCalls: 2 },
    });
    expect(resumed.syntheses).toHaveLength(2);
    expect(persisted()).toBe(4);

    // mêmes prompts que le passage unique : l'historique « déjà formulé » vient des
    // énoncés PERSISTÉS du run, jamais de la liste en mémoire de l'invocation.
    // (3 appels dans la tentative interrompue — le 3e a échoué — puis les graines 2 et 3.)
    expect(brittle.messages.slice(3).map((m) => JSON.stringify(m))).toEqual(
      full.chat.messages.slice(2).map((m) => JSON.stringify(m))
    );
  });

  /**
   * Cas réel du 2026-09-13 : le cache ne retenait que (modèle, prompt, version), donc
   * après activation de `reasoning_effort` il rejouait les `{skip:true}` produits par
   * un modèle qui ne raisonnait pas — le correctif semblait sans effet. La clé doit
   * couvrir le **réglage** du chat, pas seulement le nom du modèle.
   */
  it("un autre réglage de chat n'est pas servi par les réponses mises en cache", async () => {
    const { sourceIds, chat, service, serviceWith, cache } = makeStochasticSetup();

    const first = await service.run(sourceIds, {
      runId: "run-sig",
      totalSeeds: 4,
      promptCache: cache,
    });
    expect(first.llmCalls).toBe(4);
    expect(first.llmCallsFromCache).toBe(0);
    const callsAfterFirst = chat.calls;

    // mêmes thèmes, mêmes preuves, même run — seul le réglage du chat change
    const other = serviceWith("groq:test-chat|reasoning=low|max_tokens=3000");
    const second = await other.run(sourceIds, {
      runId: "run-sig",
      totalSeeds: 4,
      promptCache: cache,
    });

    expect(second.llmCallsFromCache).toBe(0);
    expect(chat.calls).toBeGreaterThan(callsAfterFirst);
  });

  it("sans cache : le modèle reformule, donc un rejeu insère de nouvelles synthèses", async () => {
    // même provider stochastique, mais aucun cache : c'est le comportement réel avant
    // le branchement du cache persisté (migration 004). Un rejeu double les énoncés.
    const { db, sourceIds, chat, service } = makeStochasticSetup();

    const first = await service.run(sourceIds, { runId: "run-sans-cache", totalSeeds: 4 });
    expect(count(db, "syntheses")).toBe(4);
    expect(chat.calls).toBe(first.llmCalls);

    const second = await service.run(sourceIds, { runId: "run-sans-cache", totalSeeds: 4 });

    // c'est le constat réel : la question est reposée, la réponse est reformulée,
    // donc `content_sig` (hash du texte) ne peut pas dédupliquer.
    expect(second.llmCalls).toBe(4);
    expect(count(db, "syntheses")).toBe(8);
    expect(second.skipped.duplicate).toBe(0);
  });
});
