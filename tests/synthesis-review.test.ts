import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";
import { createThemesRepo } from "@/lib/repositories/themes";
import { createSynthesesRepo, type NewSynthesis } from "@/lib/repositories/syntheses";
import { createConstructionsRepo } from "@/lib/repositories/constructions";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { markSourceDependentsStale } from "@/lib/repositories/stale";
import { contentSig } from "@/lib/discover/epistemic";
import { createSynthesisReviewService } from "@/lib/synth/review-service";
import { SynthesisService } from "@/lib/synth/synth-service";

/**
 * Phase 5B — rendre les synthèses actionnables (amendement v1.3 §3).
 *
 * AC1 : feed trié par thème puis `confidence`, une seule synthèse par
 * (`theme_id`, `content_sig`) — l'UNIQUE de la table l'impose, le test le vérifie.
 * AC2 : preuves citables (source, locator, texte) et `provenance_snapshot` affichés.
 * AC3 : accepter/rejeter persistant ; une synthèse rejetée ne réapparaît pas,
 * **y compris reformulée** — la fermeture de la graine (synth-service) est testée ici
 * avec le vrai service 5A, pas avec un stub.
 * AC4 : suppression/ré-ingestion d'une source ⇒ `stale = 1`, snapshot intact.
 * AC5 : `constructions` reste inchangée — accepter une synthèse n'y écrit rien.
 */

function setup() {
  const { db } = makeTestDb();
  const s1 = makeTextSource(db, "Le brutalisme assume le béton brut et la trame porteuse.", "Architecture");
  const s2 = makeTextSource(db, "Le bilan fiscal amortit les charges sur plusieurs exercices.", "Comptabilité");
  const f1 = makeFragment(db, {
    sourceId: s1,
    chunkIndex: 0,
    text: "Le brutalisme assume le béton brut et la trame porteuse.",
    vector: [1, 0, 0, 0, 0, 0, 0, 0],
  });
  const f2 = makeFragment(db, {
    sourceId: s2,
    chunkIndex: 0,
    text: "Le bilan fiscal amortit les charges sur plusieurs exercices.",
    vector: [0, 1, 0, 0, 0, 0, 0, 0],
  });
  const themes = createThemesRepo(db);
  const syntheses = createSynthesesRepo(db);
  const constructions = createConstructionsRepo(db);
  const suggestions = createSuggestionsRepo(db);

  /**
   * Créateur de synthèse du harnais. Les preuves par défaut sont les **deux fragments
   * réels** de `setup` — le dépôt exige ≥ 2 preuves de ≥ 2 sources distinctes, et la
   * vérification compare les `source_id` du snapshot aux sources **réelles** des
   * fragments : un id factice serait refusé (`source_modifiee`), ce qui est exactement
   * le comportement attendu en production.
   */
  const create = (args: {
    themeId: string;
    text: string;
    confidence?: NewSynthesis["confidence"];
    evidence?: { id: string; sourceId: string; text: string }[];
  }): string => {
    const evidence = args.evidence ?? [
      { id: f1, sourceId: s1, text: "Le brutalisme assume le béton brut et la trame porteuse." },
      { id: f2, sourceId: s2, text: "Le bilan fiscal amortit les charges sur plusieurs exercices." },
    ];
    const created = syntheses.create({
      text: args.text,
      theme_id: args.themeId,
      relation_kind: "combination",
      epistemic_status: "INFERENCE",
      evidence_fragment_ids: evidence.map((e) => e.id),
      provenance_snapshot: evidence.map((e) => ({
        fragment_id: e.id,
        source_id: e.sourceId,
        source_title: null,
        content_hash: `hash-${e.id}`,
        locator: "[0,10)",
        text: e.text,
      })),
      content_sig: contentSig(args.text),
      confidence: args.confidence ?? "medium",
      prompt_version: "synthesis-v2",
      chat_model: "test-chat",
    });
    if (!created.ok) throw new Error(`création attendue : ${created.reason}`);
    return created.id;
  };

  return { db, s1, s2, f1, f2, themes, syntheses, constructions, suggestions, create };
}

/** Thème unique, forme commune aux tests de ce fichier. */
function makeTheme(themes: ReturnType<typeof createThemesRepo>, label = "trame · charges", seed = "seed-1") {
  return themes.createMany([
    {
      runId: "run-1",
      corpusHash: "hash",
      seed,
      label,
      centroid: [1, 0, 0, 0, 0, 0, 0, 0],
      size: 2,
      samplerVersion: "themes-v1",
    },
  ])[0];
}

describe("feed de synthèses (AC1, AC2)", () => {
  it("trie par thème puis confiance décroissante, et joint le libellé du thème", () => {
    const { db, create, themes } = setup();
    const t1 = makeTheme(themes, "structure · trame", "seed-1");
    const t2 = makeTheme(themes, "amortissement · charges", "seed-2");
    const low = create({
      themeId: t1,
      text: "La trame explicite du bâti rejoint l'étalement comptable de la dépense.",
      confidence: "low",
    });
    const high = create({
      themeId: t1,
      text: "La structure portée se lit comme une charge étalée dans le temps.",
      confidence: "high",
    });
    const other = create({
      themeId: t2,
      text: "L'exercice comptable fixe une trame que l'ouvrage bâti ignore.",
      confidence: "high",
    });

    const review = createSynthesisReviewService(db);
    const feed = review.feed();

    // thème 1 d'abord (ordre du run), high avant low ; puis thème 2
    expect(feed.map((s) => s.id)).toEqual([high, low, other]);
    expect(feed[0].theme).toMatchObject({ id: t1, label: "structure · trame", run_id: "run-1" });
  });

  it("expose les preuves citables (source, locator, texte) et la provenance copiée (AC2)", () => {
    const { db, create, syntheses, themes } = setup();
    const themeId = makeTheme(themes);
    const id = create({
      themeId,
      text: "La trame portée et la charge étalée disent la même contrainte différée.",
    });

    const [item] = createSynthesisReviewService(db).feed();
    expect(item.id).toBe(id);
    expect(item.evidence).toHaveLength(2);
    for (const e of item.evidence) {
      expect(e.verified).toBe(true);
      expect(e.problem).toBeUndefined();
      expect(e.text.length).toBeGreaterThan(0);
      expect(e.locator).toBe("[0,10)");
    }
    expect(item.unverified).toBe(0);
    // les preuves affichées **sont** la provenance copiée au moment T (pas une jointure)
    expect(item.evidence.map((e) => e.fragment_id)).toEqual(
      JSON.parse(syntheses.getById(id)?.evidence_fragment_ids ?? "[]") as string[]
    );
    expect(item.provenance_lost).toBe(false);
  });

  it("le défaut de lecture est `proposed` : une synthèse tranchée sort du feed (AC3)", () => {
    const { db, create, syntheses, themes } = setup();
    const themeId = makeTheme(themes);
    const proposed = create({ themeId, text: "Une proposition encore en attente de décision." });
    const rejected = create({ themeId, text: "Une proposition déjà rejetée par l'utilisateur." });
    syntheses.reject(rejected);

    const review = createSynthesisReviewService(db);
    expect(review.feed().map((s) => s.id)).toEqual([proposed]);
    // mais elle reste lisible explicitement (état `all`) avec son état — le tri pose la
    // plus récente d'abord, et le rejet a eu lieu après la création de la 2ᵉ ligne :
    // l'ordre n'est pas celui de la création mais celui du created_at, identique ici,
    // départagé par rowid décroissant (la 2ᵉ créée d'abord)
    const all = review.feed({ state: "all" });
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.state).sort()).toEqual(["proposed", "rejected"]);
    expect(all.find((s) => s.id === proposed)?.state).toBe("proposed");
    expect(all.find((s) => s.id === rejected)?.state).toBe("rejected");
  });
});

describe("décisions (AC3)", () => {
  it("accepter puis re-trancher est refusé (already_decided), sans écraser l'état", () => {
    const { db, create, syntheses, themes } = setup();
    const themeId = makeTheme(themes);
    const id = create({
      themeId,
      text: "Décision unique : la synthèse ne bascule pas d'un état à l'autre.",
    });

    const review = createSynthesisReviewService(db);
    const accepted = review.decide(id, "accept");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.synthesis.state).toBe("accepted");
    expect(review.decide(id, "reject")).toEqual({ ok: false, reason: "already_decided" });
    // la base a gardé la première décision
    expect(syntheses.getById(id)?.state).toBe("accepted");
    expect(review.decide(id, "accept")).toEqual({ ok: false, reason: "already_decided" });
  });

  it("404 métier : une synthèse inconnue ne devient jamais une décision", () => {
    const { db } = setup();
    expect(createSynthesisReviewService(db).decide("absent", "reject")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("péremption (AC4) — le marquage partagé couvre les deux entités", () => {
  it("supprimer la source d'une preuve : synthèse stale=1, snapshot intact et affichable", () => {
    const { db, s1, create, themes } = setup();
    const themeId = makeTheme(themes);
    create({
      themeId,
      text: "La trame portée et la charge étalée disent la même contrainte différée.",
    });

    // l'écran voit une synthèse saine avant la suppression
    const before = createSynthesisReviewService(db).feed();
    expect(before[0].stale).toBe(false);
    expect(before[0].unverified).toBe(0);

    // la disparition passe par le marquage partagé (c'est ce que fait la route DELETE
    // et le script de ré-ingestion) : la péremption lit le snapshot, pas les fragments
    const marked = markSourceDependentsStale(db, s1);
    expect(marked.syntheses).toBe(1);
    db.prepare("DELETE FROM sources WHERE id = ?").run(s1);

    // AC4 : stale = 1 (marquage via provenance_snapshot), le snapshot reste lisible
    const after = createSynthesisReviewService(db).feed();
    expect(after).toHaveLength(1);
    expect(after[0].stale).toBe(true);
    expect(after[0].unverified).toBe(1);
    expect(after[0].evidence[0]).toMatchObject({ verified: false, problem: "fragment_absent" });
    // la copie au moment T reste affichable : c'est elle qui permet de réévaluer
    expect(after[0].evidence[0].text).toContain("brutalisme");
    expect(after[0].evidence[0].locator).toBe("[0,10)");
  });

  it("markSourceDependentsStale marque constructions ET synthèses — l'oubli d'une entité est impossible", () => {
    const { db, s1, s2, f1, f2, create, constructions, suggestions, themes } = setup();
    const themeId = makeTheme(themes);
    create({
      themeId,
      text: "La trame portée et la charge étalée disent la même contrainte différée.",
    });
    // une Construction qui cite la même source (US-08 AC2) : créée par le **chemin
    // normal** — une suggestion acceptée — parce que le schéma v1.2 impose une vraie FK
    // `suggestion_id` : la transaction d'acceptation est aussi ce qui garantit que la
    // Construction et son snapshot sont cohérents, autant en profiter ici
    const suggestion = suggestions.create({
      claim: "La trame portée rejoint la charge étalée.",
      relation_type: "analogy",
      tier: "medium",
      fragment_a_id: f1,
      fragment_b_id: f2,
      pair_key: "p1",
      content_sig: contentSig("claim construction"),
      epistemic_status: "INFERENCE",
      prompt_version: "discovery-v4",
      chat_model: "test-model",
    });
    if (!suggestion.ok) throw new Error(`suggestion attendue : ${suggestion.reason}`);
    const accepted = suggestions.getById(suggestion.id);
    if (!accepted) throw new Error("suggestion attendue");
    constructions.create({
      text: accepted.claim,
      epistemic_status: "INFERENCE",
      parentSourceIds: [s1, s2],
      evidenceFragmentIds: [f1, f2],
      suggestionId: suggestion.id,
      snapshot: [
        { source_id: s1, source_title: null, source_content_hash: "h1", fragment_id: f1, fragment_text: "frag", locator: "[0,10)" },
        { source_id: s2, source_title: null, source_content_hash: "h2", fragment_id: f2, fragment_text: "frag", locator: "[0,10)" },
      ],
    });

    const marked = markSourceDependentsStale(db, s1);
    expect(marked).toEqual({ constructions: 1, syntheses: 1 });
    // second appel : déjà marquées (l'état est stable)
    expect(markSourceDependentsStale(db, s1)).toEqual({ constructions: 0, syntheses: 0 });
  });
});

describe("AC5 — accepter une synthèse n'écrit pas dans les Constructions", () => {
  it("les Constructions restent exactement celles d'avant la décision", () => {
    const { db, create, constructions, suggestions, themes } = setup();
    // (déjà exposés par le harnais : ils sont aussi dans la portée du describe AC5)
    const themeId = makeTheme(themes);
    const id = create({
      themeId,
      text: "Aucune écriture croisée : la synthèse n'est pas une Construction.",
    });
    expect(constructions.list()).toEqual([]);

    const result = createSynthesisReviewService(db).decide(id, "accept");
    expect(result.ok).toBe(true);

    expect(constructions.list()).toEqual([]);
    // aucune suggestion n'a été créée par la décision (le cast `state` est celui du
    // dépôt des suggestions, qui ne connaît pas `all` — c'est sa liste de filtres)
    expect(suggestions.listFeed({ limit: 10 })).toEqual([]);
  });
});

describe("AC3 — une synthèse rejetée ne réapparaît pas, y compris reformulée", () => {
  /** Provider scripté minimal : une réponse par appel (le vrai schéma Zod revalide). */
  class ScriptedChat implements LlmProvider {
    calls = 0;
    constructor(private reply: (call: number) => unknown) {}
    async chat<T extends z.ZodType>(_messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
      return schema.parse(this.reply(this.calls++)) as z.infer<T>;
    }
    async embed(): Promise<number[]> {
      return [];
    }
  }

  /** 4 groupes orthogonaux (même corpus que synth-service.test.ts, légèrement réduit). */
  const CORPUS = [
    { text: "Le beton brut affirme la charge portee par la facade.", vector: [1, 0, 0, 0, 0, 0, 0, 0], title: "A1" },
    { text: "L'ossature exprime la trame sans ornement ajoute.", vector: [0.9, 0.44, 0, 0, 0, 0, 0, 0], title: "A2" },
    { text: "L'amortissement fiscal etale la depense sur plusieurs exercices.", vector: [0, 1, 0, 0, 0, 0, 0, 0], title: "C1" },
    { text: "Le bilan comptable differe la reconnaissance du cout engage.", vector: [0, 0.9, 0.44, 0, 0, 0, 0, 0], title: "C2" },
  ];
  const ANSWER_A =
    "Rendre visible la contrainte qui pese sur un ouvrage releve moins du calcul que d'un choix de mise en scene.";
  const ANSWER_B =
    "Deux regimes d'ecriture opposent la mesure chiffree a l'appreciation qualitative du phenomene observe.";

  it("après rejet, un rejeu du run ferme la graine (skipped.decided) au lieu de produire une variante", async () => {
    const { db } = makeTestDb();
    const sourceIds = CORPUS.map((e) => {
      const sourceId = makeTextSource(db, `${e.title} — ${e.text}`, e.title);
      makeFragment(db, { sourceId, text: e.text, vector: e.vector });
      return sourceId;
    });
    const syntheses = createSynthesesRepo(db);
    const service = new SynthesisService({
      db,
      themes: createThemesRepo(db),
      syntheses,
      chat: new ScriptedChat(() => ({
        synthesis: ANSWER_A,
        relation_kind: "combination",
        evidence: [0, 1],
        confidence: "medium",
        epistemic_status: "INFERENCE",
      })),
      chatModel: "test-chat",
    });

    const first = await service.run(sourceIds, { runId: "run-5b", totalSeeds: 1 });
    expect(first.syntheses).toHaveLength(1);
    expect(first.skipped.decided ?? 0).toBe(0);

    // l'utilisateur rejette la synthèse produite
    const review = createSynthesisReviewService(db);
    expect(review.decide(first.createdIds[0], "reject")).toMatchObject({ ok: true });
    expect(review.feed()).toHaveLength(0); // sortie du feed (AC3)

    // rejeu du même run : la graine est fermée par la décision, aucune variante
    const second = await service.run(sourceIds, {
      runId: "run-5b",
      totalSeeds: 1,
      resume: { createdIds: first.createdIds },
    });
    expect(second.skipped.decided).toBe(1);
    expect(second.syntheses).toHaveLength(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM syntheses").get() as { n: number }).n
    ).toBe(1);
  });

  it("une synthèse acceptée ferme aussi sa graine : accepter n'est pas inviter des variantes", async () => {
    const { db } = makeTestDb();
    const sourceIds = CORPUS.map((e) => {
      const sourceId = makeTextSource(db, `${e.title} — ${e.text}`, e.title);
      makeFragment(db, { sourceId, text: e.text, vector: e.vector });
      return sourceId;
    });
    const syntheses = createSynthesesRepo(db);
    // deux énoncés distincts : sans fermeture, le rejeu produirait le second
    let call = 0;
    const service = new SynthesisService({
      db,
      themes: createThemesRepo(db),
      syntheses,
      chat: new ScriptedChat(() => (call++ === 0 ? { ...fresh(ANSWER_A) } : fresh(ANSWER_B))),
      chatModel: "test-chat",
    });

    const first = await service.run(sourceIds, { runId: "run-acc", totalSeeds: 1 });
    expect(first.syntheses).toHaveLength(1);
    expect(createSynthesisReviewService(db).decide(first.createdIds[0], "accept").ok).toBe(true);

    const second = await service.run(sourceIds, {
      runId: "run-acc",
      totalSeeds: 1,
      resume: { createdIds: first.createdIds },
    });
    expect(second.skipped.decided).toBe(1);
    expect(second.syntheses).toHaveLength(0);
  });

  function fresh(text: string) {
    return {
      synthesis: text,
      relation_kind: "combination",
      evidence: [0, 1],
      confidence: "medium",
      epistemic_status: "INFERENCE",
    };
  }
});
