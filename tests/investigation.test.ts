import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeFragment, makeFakeEmbedder, makeTestDb, makeTextSource } from "./helpers";
import { contentSig } from "@/lib/discover/epistemic";

import { createSuggestionsRepo, type SuggestionsRepo } from "@/lib/repositories/suggestions";
import { createInvestigationsRepo } from "@/lib/repositories/investigations";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createJobsRepo, idempotencyKey, type ClaimedJob } from "@/lib/repositories/jobs";
import { InvestigationService } from "@/lib/agent/investigation-service";
import { parseInvestigationDocument, verifyDocument } from "@/lib/agent/citations";
import { buildCorpusIndex } from "@/lib/agent/retrieval";
import { INVESTIGATION_STEP_BUDGET } from "@/lib/agent/types";
import { IngestService } from "@/lib/ingest/ingest-service";
import { SummaryService } from "@/lib/ingest/summary-service";
import { Worker } from "@/lib/jobs/worker";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";

/**
 * Phase 4 — investigation (PRD §4, US-09).
 *
 * AC1 : 1 agent, ≤ 5 étapes. AC2 : toute citation est vérifiée programmatiquement
 * (fragment existant + texte identique) — une citation invalide marque l'étape
 * `failed` et n'est jamais affichée comme preuve.
 *
 * Le modèle est **scripté** : chaque appel rend une action prédéfinie. Ce n'est pas
 * le raisonnement du modèle qui est testé (il n'est pas déterministe), mais le
 * contrat : ce que le serveur transmet, ce qu'il accepte, ce qu'il persiste et ce
 * qu'il refuse. Les prompts réellement envoyés sont capturés pour vérifier qu'aucun
 * identifiant de fragment ne fuit.
 */

const V = (x: number, y: number): number[] => [x, y, 0, 0, 0, 0, 0, 0];

/** LLM scripté : rend les actions dans l'ordre, puis répète la dernière. */
class ScriptedLlm implements LlmProvider {
  calls = 0;
  prompts: string[] = [];
  constructor(private actions: Record<string, unknown>[]) {}
  async embed(): Promise<number[]> {
    throw new Error("pas d'embedding dans l'investigation");
  }
  async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    const action =
      this.actions[Math.min(this.calls, this.actions.length - 1)] ?? { action: "search", query: "mesure" };
    this.calls += 1;
    this.prompts.push(messages[messages.length - 1].content);
    return schema.parse(action);
  }
}

/** Corpus : 2 sources, 3 fragments — la question porte sur la paire fA / fB. */
function setup() {
  const { db } = makeTestDb();
  const s1 = makeTextSource(db, "s1", "Descartes");
  const s2 = makeTextSource(db, "s2", "Claude Bernard");
  const fA = makeFragment(db, {
    sourceId: s1,
    chunkIndex: 0,
    id: "frag-doute",
    text: "Le doute methodique ecarte les opinions seulement probables.",
    vector: V(1, 0),
  });
  const fB = makeFragment(db, {
    sourceId: s2,
    chunkIndex: 0,
    id: "frag-mesure",
    text: "La mesure experimentale fixe les conditions de l'observation.",
    vector: V(0, 1),
  });
  makeFragment(db, {
    sourceId: s2,
    chunkIndex: 1,
    id: "frag-conditions",
    text: "Les conditions de l'experience exigent une mesure repetee.",
    vector: V(0.7, 0.7),
  });
  const suggestions = createSuggestionsRepo(db);
  const claim = "Le doute cartesien prepare la mesure bernardienne en isolant ce qui est verifiable.";
  const created = suggestions.create({
    claim,
    relation_type: "analogy",
    tier: "strong",
    fragment_a_id: fA,
    fragment_b_id: fB,
    pair_key: "frag-doute:frag-mesure",
    content_sig: contentSig(claim),
    epistemic_status: "INFERENCE",
    prompt_version: "discovery-v4",
    chat_model: "test-model",
  });
  if (!created.ok) throw new Error(`suggestion de test refusée : ${created.reason}`);
  return { db, s1, s2, fA, fB, suggestionId: created.id, suggestions };
}

function makeService(
  db: ReturnType<typeof makeTestDb>["db"],
  suggestions: SuggestionsRepo,
  chat: LlmProvider,
  promptCache?: Map<string, unknown>
) {
  return new InvestigationService({
    db,
    investigations: createInvestigationsRepo(db),
    suggestions,
    fragments: createFragmentsRepo(db),
    sources: createSourcesRepo(db),
    chat,
    chatModel: "test-model",
    promptCache,
  });
}

/** Document relu depuis la base, après vérification des citations. */
function readDoc(
  db: ReturnType<typeof makeTestDb>["db"],
  investigationId: string
) {
  const row = createInvestigationsRepo(db).getById(investigationId);
  if (!row) throw new Error("investigation absente");
  return { row, doc: verifyDocument(db, parseInvestigationDocument(row.steps)) };
}

/**
 * Conclusion de test **conforme à la barrière** (`conclusion-v2`) : une proposition,
 * une relation énoncée entre les deux documents, 50–160 mots.
 *
 * Les fixtures de ce fichier employaient un énoncé de 8 mots (« Le doute et la mesure
 * partagent l'exigence de verifiabilite. »), accepté tant que le service n'appliquait
 * que ses deux règles locales. Depuis que la barrière partagée est branchée, un tel
 * énoncé est refusé (« conclusion_hors_format » : moins de 12 mots) — et un test qui le
 * prenait pour une conclusion valide ne mesurait plus ce qu'il annonçait.
 */
const GOOD_CONCLUSION =
  "Le doute ne se contente pas de précéder la mesure : il en énonce le critère. " +
  "Ce que Descartes exige du côté des raisons — écarter l'opinion seulement probable — " +
  "la mesure bernardienne l'applique sur le vivant, où la vérification devient une " +
  "épreuve répétée. La mesure apparaît alors comme la mise à l'épreuve de ce critère, " +
  "et non comme son application mécanique.";

describe("agent d'investigation", () => {
  it("3 étapes : recherche, voisinage, conclusion — indices rattachés par le serveur, aucun id dans le prompt", async () => {
    const { db, suggestions, suggestionId } = setup();
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure experimentale" },
      { action: "expand", fragment: 0 },
      {
        action: "conclude",
        answer: GOOD_CONCLUSION,
        citations: [2],
      },
    ]);
    const service = makeService(db, suggestions, llm);

    const result = await service.run(suggestionId, { investigationId: "inv-1" });

    expect(result.status).toBe("done");
    expect(result.steps).toBe(3);
    expect(result.llmCalls).toBe(3);
    expect(result.citations).toBe(1);

    const { row, doc } = readDoc(db, "inv-1");
    expect(row.status).toBe("done");
    // catalogue : 2 graines (les preuves de la suggestion) + ce que la recherche a trouvé
    expect(doc.catalogue.map((e) => e.fragment_id)).toEqual([
      "frag-doute",
      "frag-mesure",
      "frag-conditions",
    ]);
    expect(doc.catalogue.map((e) => e.origin)).toEqual(["seed", "seed", "search"]);
    expect(doc.steps.map((s) => s.action)).toEqual(["search", "expand", "conclude"]);
    expect(doc.steps[0].added).toEqual([2]);
    expect(doc.steps[2].citations).toEqual([2]);
    expect(doc.steps.every((s) => !s.failed)).toBe(true);
    expect(doc.unverified).toBe(0);
    // le rattachement indice → fragment est fait par le serveur, jamais par le modèle
    expect(doc.catalogue[2].text).toBe("Les conditions de l'experience exigent une mesure repetee.");
    // aucune fuite d'identifiant de fragment dans ce que le modèle a vu
    for (const prompt of llm.prompts) expect(prompt).not.toContain("frag-");
  });

  it("AC1 : le budget est un plafond dur (5), et l'épuiser sans conclure est un échec tracé", async () => {
    const { db, suggestions, suggestionId } = setup();
    const llm = new ScriptedLlm(Array.from({ length: 8 }, () => ({ action: "search", query: "mesure" })));
    const service = makeService(db, suggestions, llm);

    const result = await service.run(suggestionId, { investigationId: "inv-cap", maxSteps: 99 });

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("step_budget_exhausted");
    expect(result.steps).toBe(INVESTIGATION_STEP_BUDGET);
    expect(result.llmCalls).toBe(INVESTIGATION_STEP_BUDGET);
    expect(llm.calls).toBe(INVESTIGATION_STEP_BUDGET);

    const { doc } = readDoc(db, "inv-cap");
    expect(doc.step_budget).toBe(INVESTIGATION_STEP_BUDGET);
    expect(doc.steps).toHaveLength(INVESTIGATION_STEP_BUDGET);
    expect(doc.steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    expect(doc.failure).toBe("step_budget_exhausted");
  });

  it("AC2 : citer un fragment jamais montré marque l'étape failed et l'enquête échoue", async () => {
    const { db, suggestions, suggestionId } = setup();
    const llm = new ScriptedLlm([
      { action: "conclude", answer: "Une conclusion appuyée sur rien.", citations: [7] },
    ]);
    const service = makeService(db, suggestions, llm);

    const result = await service.run(suggestionId, { investigationId: "inv-hors" });

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("citation_hors_catalogue");
    expect(result.citations).toBe(0);

    const { doc } = readDoc(db, "inv-hors");
    expect(doc.steps[0].failed).toBe(true);
    expect(doc.steps[0].failure).toBe("citation_hors_catalogue");
    // l'indice refusé n'existe dans aucun catalogue : il n'y a rien à afficher
    expect(doc.catalogue.some((e) => e.index === 7)).toBe(false);
  });

  it("un `expand` sur un indice inconnu ne tue pas l'enquête : l'étape est failed, le budget continue", async () => {
    const { db, suggestions, suggestionId } = setup();
    const llm = new ScriptedLlm([
      { action: "expand", fragment: 9 },
      { action: "search", query: "mesure" },
      { action: "conclude", answer: GOOD_CONCLUSION, citations: [1] },
    ]);
    const service = makeService(db, suggestions, llm);

    const result = await service.run(suggestionId, { investigationId: "inv-reprise" });

    expect(result.status).toBe("done");
    const { doc } = readDoc(db, "inv-reprise");
    expect(doc.steps[0].failed).toBe(true);
    expect(doc.steps[0].failure).toBe("indice_hors_catalogue");
    expect(doc.steps[2].failed).toBe(false);
  });

  it("conclure sans avoir exploré est refusé : l'enquête doit regarder au-delà des graines", async () => {
    const { db, suggestions, suggestionId } = setup();
    const llm = new ScriptedLlm([
      // le modèle veut conclure d'entrée de jeu (comportement réel observé : 1 seul appel,
      // réponse qui reformule la suggestion)
      { action: "conclude", answer: GOOD_CONCLUSION, citations: [0, 1] },
      { action: "search", query: "mesure" },
      { action: "conclude", answer: "La condition de verifiabilite qui fonde le doute se retrouve dans la mesure experimentale.", citations: [2] },
    ]);
    const service = makeService(db, suggestions, llm);

    const result = await service.run(suggestionId, { investigationId: "inv-sans-exploration" });
    expect(result.status).toBe("done");
    const { doc } = readDoc(db, "inv-sans-exploration");
    expect(doc.steps[0].failed).toBe(true);
    expect(doc.steps[0].failure).toBe("conclusion_sans_exploration");
    expect(doc.steps[2].failed).toBe(false);
  });

  /**
   * Deux textes **réellement produits** par `nvidia/nemotron-3-super-120b-a12b` sur le
   * corpus réel (run HTTP du 2026-09-18, suggestion Bernard × Descartes) : l'énoncé de
   * la suggestion, et la réponse du modèle — qui le reprend presque mot pour mot en le
   * reliant par « tandis que ». C'est le défaut de juxtaposition de la Phase 2A, et
   * c'est ce que l'enquête ne doit pas restituer.
   */
  const REAL_CLAIM =
    "Bernard affirme que l'expérimentateur ne fait qu'obéir aux lois de la nature, tandis " +
    "Descartes soutient que la connaissance naît de l'expérience particulière pour déduire les causes.";
  const REAL_ECHO =
    "Bernard et Descartes montrent tous deux que la connaissance scientifique procède de " +
    "l'observation particulière ou de l'expérimentation pour remonter à des lois universelles : " +
    "Bernard affirme que l'expérimentateur ne fait qu'obéir au déterminisme absolu des phénomènes " +
    "naturels, tandis que Descartes soutient que, en partant d'expériences particulières et en " +
    "remontant des effets aux causes, on peut dégager les principes généraux de la nature.";

  it("une conclusion qui restitue la question est refusée (sortie réelle du modèle)", async () => {
    const { db, suggestions, suggestionId, fA, fB } = setup();
    // la suggestion porte le claim **réel**, pour juger la réponse réelle contre sa question
    const created = suggestions.create({
      claim: REAL_CLAIM,
      relation_type: "contradiction",
      tier: "medium",
      fragment_a_id: fA,
      fragment_b_id: fB,
      pair_key: "frag-doute:frag-mesure",
      content_sig: contentSig(REAL_CLAIM),
      epistemic_status: "INFERENCE",
      prompt_version: "discovery-v4",
      chat_model: "test-model",
    });
    if (!created.ok) throw new Error(`suggestion de test refusée : ${created.reason}`);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "conclude", answer: REAL_ECHO, citations: [0, 1] },
      {
        action: "conclude",
        answer:
          "L'exigence de verifiabilite du doute se retrouve chez Bernard comme condition de la mesure : ce que le doute ecarte a priori, la mesure l'ecarte par l'observation.",
        citations: [2],
      },
    ]);

    const result = await makeService(db, suggestions, llm).run(created.id, {
      investigationId: "inv-echo",
    });

    expect(result.status).toBe("done");
    const { doc } = readDoc(db, "inv-echo");
    expect(doc.steps[1].failed).toBe(true);
    // la réponse réelle déclenche les **deux** règles (reports coordonnés par « tandis
    // que » **et** recouvrement de 0,846 avec la question) : c'est la juxtaposition qui
    // est rapportée, parce que c'est la structure que le modèle doit changer
    expect(doc.steps[1].failure).toBe("conclusion_juxtaposition");
    expect(doc.steps[2].failed).toBe(false);
    // l'énoncé refusé n'est jamais compté comme un résultat
    expect(result.citations).toBe(1);
    // et la suggestion de départ n'est pas concernée (deux suggestions sur la même paire)
    expect(suggestionId).not.toBe(created.id);
  });

  it("si le modèle ne fait que restituer la question, l'enquête échoue au bout du budget (jamais un énoncé creux)", async () => {
    const { db, suggestions, fA, fB } = setup();
    const created = suggestions.create({
      claim: REAL_CLAIM,
      relation_type: "cause",
      tier: "medium",
      fragment_a_id: fA,
      fragment_b_id: fB,
      pair_key: "frag-doute:frag-mesure",
      content_sig: contentSig(REAL_CLAIM),
      epistemic_status: "INFERENCE",
      prompt_version: "discovery-v4",
      chat_model: "test-model",
    });
    if (!created.ok) throw new Error(`suggestion de test refusée : ${created.reason}`);
    // le modèle répète la même réponse (ScriptedLlm rejoue la dernière action) :
    // 1 exploration, puis 4 conclusions refusées → le budget s'épuise
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "conclude", answer: REAL_ECHO, citations: [0, 1] },
    ]);

    const result = await makeService(db, suggestions, llm).run(created.id, {
      investigationId: "inv-creux",
    });

    expect(result.status).toBe("failed");
    expect(result.citations).toBe(0);
    const { doc } = readDoc(db, "inv-creux");
    expect(doc.steps).toHaveLength(INVESTIGATION_STEP_BUDGET);
    expect(doc.steps[1].failure).toBe("conclusion_juxtaposition");
    // la raison rapportée est celle du refus, pas « budget épuisé »
    expect(doc.failure).toBe("conclusion_juxtaposition");
  });

  it("AC2 à la lecture : fragment disparu ⇒ l'entrée n'est plus vérifiable et l'étape redevient failed", async () => {
    const { db, suggestions, suggestionId } = setup();
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "conclude", answer: GOOD_CONCLUSION, citations: [2] },
    ]);
    const service = makeService(db, suggestions, llm);
    await service.run(suggestionId, { investigationId: "inv-stale" });
    expect(readDoc(db, "inv-stale").doc.steps[1].failed).toBe(false);

    // Le fragment **cité** disparaît sans emporter la suggestion : c'est le cas d'une
    // preuve trouvée par l'agent (elle n'appartient pas à la paire de départ), donc le
    // seul cas où une citation survit au fragment qu'elle cite.
    db.prepare("DELETE FROM fragments WHERE id = ?").run("frag-conditions");

    const { doc } = readDoc(db, "inv-stale");
    const cited = doc.catalogue.find((e) => e.index === 2);
    expect(cited?.verified).toBe(false);
    expect(cited?.problem).toBe("fragment_absent");
    // le texte copié au moment T reste consultable — mais l'étape n'est plus une preuve
    expect(cited?.text).toBe("Les conditions de l'experience exigent une mesure repetee.");
    expect(doc.steps[1].failed).toBe(true);
    expect(doc.unverified).toBe(1);
  });

  /**
   * Réserve assumée du schéma verrouillé (v1.2 §3.3), à connaître :
   * `investigations.suggestion_id` est `ON DELETE CASCADE` **et** `suggestions`
   * cascade sur ses fragments — supprimer une source qui porte une preuve de départ
   * emporte donc la suggestion, puis l'investigation. Une enquête ne survit pas à la
   * disparition de sa question : il n'y a rien à vérifier à la lecture, et la
   * vérification programmatique ne peut pas s'appliquer à une ligne qui n'existe plus.
   */
  it("supprimer une source de la paire de départ emporte l'investigation (CASCADE du schéma verrouillé)", async () => {
    const { db, suggestions, suggestionId, s2 } = setup();
    const llm = new ScriptedLlm([
      { action: "conclude", answer: GOOD_CONCLUSION, citations: [1] },
    ]);
    await makeService(db, suggestions, llm).run(suggestionId, { investigationId: "inv-cascade" });
    expect(createInvestigationsRepo(db).getById("inv-cascade")).not.toBeNull();

    db.prepare("DELETE FROM sources WHERE id = ?").run(s2);

    expect(suggestions.getById(suggestionId)).toBeNull();
    expect(createInvestigationsRepo(db).getById("inv-cascade")).toBeNull();
    // aucune ligne orpheline : la lecture d'une suggestion inconnue ne trouve rien
    expect(createInvestigationsRepo(db).latestBySuggestion(suggestionId)).toBeNull();
  });

  it("AC2 à la lecture : texte du fragment modifié ⇒ texte_modifie, étape invalidée", async () => {
    const { db, suggestions, suggestionId } = setup();
    const llm = new ScriptedLlm([
      { action: "conclude", answer: GOOD_CONCLUSION, citations: [0] },
    ]);
    await makeService(db, suggestions, llm).run(suggestionId, { investigationId: "inv-texte" });

    db.prepare("UPDATE fragments SET text = ? WHERE id = ?").run("Texte remplacé.", "frag-doute");

    const { doc } = readDoc(db, "inv-texte");
    expect(doc.catalogue[0].problem).toBe("texte_modifie");
    expect(doc.steps[0].failed).toBe(true);
  });

  it("rejeu : mêmes étapes, 0 appel LLM (cache de prompt), même document", async () => {
    const { db, suggestions, suggestionId } = setup();
    const actions = [
      { action: "search", query: "mesure" },
      { action: "conclude", answer: GOOD_CONCLUSION, citations: [2] },
    ];
    const cache = new Map<string, unknown>();
    const first = new ScriptedLlm(actions);
    const r1 = await makeService(db, suggestions, first, cache).run(suggestionId, {
      investigationId: "inv-rejeu",
    });
    expect(r1.llmCalls).toBe(2);

    const second = new ScriptedLlm(actions);
    const r2 = await makeService(db, suggestions, second, cache).run(suggestionId, {
      investigationId: "inv-rejeu",
    });

    expect(second.calls).toBe(0);
    expect(r2.llmCalls).toBe(0);
    expect(r2.llmCallsFromCache).toBe(2);
    expect(r2.status).toBe("done");
    const { doc } = readDoc(db, "inv-rejeu");
    expect(doc.steps.map((s) => [s.action, s.added, s.citations])).toEqual([
      ["search", [2], undefined],
      ["conclude", [], [2]],
    ]);
    expect(doc.llm_calls).toBe(0);
    expect(doc.steps_from_cache).toBe(2);
  });
});

describe("worker : job investigation", () => {
  it("process() : la ligne `investigations` est écrite, le job passe done (l'échec d'enquête n'est pas un échec de job)", async () => {
    const { db, suggestions, suggestionId } = setup();
    const jobs = createJobsRepo(db);
    const investigations = createInvestigationsRepo(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "conclude", answer: GOOD_CONCLUSION, citations: [2] },
    ]);
    const worker = new Worker({
      jobs,
      ingest: new IngestService({
        db,
        sources: createSourcesRepo(db),
        fragments: createFragmentsRepo(db),
        jobs,
        embedder: makeFakeEmbedder(8),
        chatModel: "test-model",
      }),
      summary: new SummaryService({
        db,
        sources: createSourcesRepo(db),
        jobs,
        llm: llm as unknown as LlmProvider,
        chatModel: "test-model",
        groqKeyMissing: false,
      }),
      investigation: makeService(db, suggestions, llm),
    });

    const job = jobs.createJob({
      kind: "investigation",
      payload: { suggestion_id: suggestionId },
      sourceId: null,
      idempotencyKey: idempotencyKey(["investigation", suggestionId]),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    expect(jobs.getById(job.id)?.status).toBe("done");
    // l'investigation porte l'id du job : un rejeu met à jour la même ligne
    const row = investigations.getById(job.id);
    expect(row?.suggestion_id).toBe(suggestionId);
    expect(row?.status).toBe("done");
    const summary = JSON.parse(jobs.getById(job.id)?.progress_json as string);
    expect(summary.steps).toBe(2);
    expect(summary.citations).toBe(1);
    expect(summary.llm_calls).toBe(2);
  });

  it("une enquête sans conclusion est un résultat, pas une panne : ligne failed, job done", async () => {
    const { db, suggestions, suggestionId } = setup();
    const jobs = createJobsRepo(db);
    const investigations = createInvestigationsRepo(db);
    const llm = new ScriptedLlm([{ action: "conclude", answer: "Sans appui.", citations: [42] }]);
    const worker = new Worker({
      jobs,
      ingest: new IngestService({
        db,
        sources: createSourcesRepo(db),
        fragments: createFragmentsRepo(db),
        jobs,
        embedder: makeFakeEmbedder(8),
        chatModel: "test-model",
      }),
      summary: new SummaryService({
        db,
        sources: createSourcesRepo(db),
        jobs,
        llm: llm as unknown as LlmProvider,
        chatModel: "test-model",
        groqKeyMissing: false,
      }),
      investigation: makeService(db, suggestions, llm),
    });

    const job = jobs.createJob({
      kind: "investigation",
      payload: { suggestion_id: suggestionId },
      sourceId: null,
      idempotencyKey: idempotencyKey(["investigation", "failed", suggestionId]),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    expect(jobs.getById(job.id)?.status).toBe("done");
    expect(investigations.getById(job.id)?.status).toBe("failed");
  });

  it("suggestion disparue : le job échoue et aucune ligne orpheline n'est écrite", async () => {
    const { db, suggestions } = setup();
    const jobs = createJobsRepo(db);
    const investigations = createInvestigationsRepo(db);
    const llm = new ScriptedLlm([{ action: "search", query: "mesure" }]);
    const worker = new Worker({
      jobs,
      ingest: new IngestService({
        db,
        sources: createSourcesRepo(db),
        fragments: createFragmentsRepo(db),
        jobs,
        embedder: makeFakeEmbedder(8),
        chatModel: "test-model",
      }),
      summary: new SummaryService({
        db,
        sources: createSourcesRepo(db),
        jobs,
        llm: llm as unknown as LlmProvider,
        chatModel: "test-model",
        groqKeyMissing: false,
      }),
      investigation: makeService(db, suggestions, llm),
    });

    const job = jobs.createJob({
      kind: "investigation",
      payload: { suggestion_id: "suggestion-inexistante" },
      sourceId: null,
      idempotencyKey: idempotencyKey(["investigation", "orpheline"]),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    expect(jobs.getById(job.id)?.status).toBe("pending"); // réessayable (attempts 1 < 5)
    expect(investigations.getById(job.id)).toBeNull();
    expect(llm.calls).toBe(0);
  });
});

/**
 * Le corpus de l'index doit être **cohérent** : `dotProduct` lit `dims` valeurs, donc
 * un corpus à deux espaces vectoriels rendrait des voisinages faux mais plausibles.
 * Le garde-fou est celui de la maison (`assertSingleEmbeddingSpace`).
 */
describe("garde-fou de l'espace vectoriel", () => {
  it("un corpus à deux espaces fait échouer l'enquête au lieu de comparer des vecteurs", async () => {
    const { db, suggestions, suggestionId } = setup();
    db.prepare(
      "UPDATE fragments SET embedding_dimensions = 16, embedding = zeroblob(64) WHERE id = ?"
    ).run("frag-conditions");
    const llm = new ScriptedLlm([{ action: "search", query: "mesure" }]);
    const service = makeService(db, suggestions, llm);

    await expect(service.run(suggestionId, { investigationId: "inv-espace" })).rejects.toThrow(
      /espace/i
    );
    expect(llm.calls).toBe(0);
  });

  it("l'index ignore un fragment dont la dimension ne correspond pas à celle du corpus", () => {
    const { db } = setup();
    db.prepare(
      "UPDATE fragments SET embedding_dimensions = 16, embedding = zeroblob(64) WHERE id = ?"
    ).run("frag-conditions");
    const index = buildCorpusIndex(db);
    expect(index.get("frag-conditions")).toBeUndefined();
    expect(index.size).toBe(2);
  });
});
