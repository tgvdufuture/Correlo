import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeFragment, makeFakeEmbedder, makeTestDb, makeTextSource } from "./helpers";
import { contentSig } from "@/lib/discover/epistemic";
import { encodeEmbedding } from "@/lib/llm/embedding-codec";

import {
  conversationTitle,
  createConversationsRepo,
  turnInFlight,
  type ConversationsRepo,
} from "@/lib/repositories/conversations";
import { createConversationCanvasRepo } from "@/lib/repositories/conversation-canvases";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import { createJobsRepo, idempotencyKey, type ClaimedJob } from "@/lib/repositories/jobs";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { ConversationService } from "@/lib/agent/conversation-service";
import {
  CONVERSATION_STEP_BUDGET,
  MAX_REFUSED_STEPS,
  emptyConversationTurn,
  parseConversationTurn,
  type ConversationTurn,
} from "@/lib/agent/conversation-types";
import { verifyConversationTurn } from "@/lib/agent/conversation-citations";
import {
  conversationTurnJobKey,
  conversationTurnJobPayload,
} from "@/lib/agent/queue";
import { IngestService } from "@/lib/ingest/ingest-service";
import { SummaryService } from "@/lib/ingest/summary-service";
import { Worker } from "@/lib/jobs/worker";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";
import { LlmOutputError } from "@/lib/llm/errors";

/**
 * Phase 6 — conversation (amendement v1.3 §13).
 *
 * Ce qui est testé ici est le **contrat**, pas le raisonnement du modèle (il n'est pas
 * déterministe) : ce que le serveur transmet, ce qu'il accepte, ce qu'il refuse, ce qu'il
 * assemble et ce qu'il persiste. Le modèle est donc scripté, comme en Phase 4.
 *
 * Les propriétés qui portent les AC :
 *  - AC1 : le texte affiché **est** l'union des affirmations, chacune portant ses
 *    provenances ; une affirmation sans preuve survivante est comptée et signalée ;
 *  - AC5′ : 5 étapes internes au plus, quel que soit le payload ;
 *  - un refus est **récupérable** : il consomme une étape et le tour continue ;
 *  - un rejeu du même tour ne rappelle pas le modèle (cache de prompt).
 */

const V = (x: number, y: number): number[] => [x, y, 0, 0, 0, 0, 0, 0];

/** LLM qui rend une sortie que le schéma refuse, après le retry de correction du provider. */
class UnreadableLlm implements LlmProvider {
  async embed(): Promise<number[]> {
    throw new Error("pas d'embedding dans la conversation");
  }
  async chat<T extends z.ZodType>(): Promise<z.infer<T>> {
    throw new LlmOutputError("Sortie LLM invalide après retry de correction — action inconnue");
  }
}

/** LLM scripté : rend les actions dans l'ordre, puis répète la dernière. */
class ScriptedLlm implements LlmProvider {
  calls = 0;
  prompts: string[] = [];
  constructor(private actions: Record<string, unknown>[]) {}
  async embed(): Promise<number[]> {
    throw new Error("pas d'embedding dans la conversation");
  }
  async chat<T extends z.ZodType>(messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    const action =
      this.actions[Math.min(this.calls, this.actions.length - 1)] ?? {
        action: "search",
        query: "mesure",
      };
    this.calls += 1;
    this.prompts.push(messages[messages.length - 1].content);
    return schema.parse(action);
  }
}

/** Corpus : 2 sources, 3 fragments — la question porte sur la mesure expérimentale. */
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
  return { db, s1, s2, fA, fB };
}

/** Une synthèse ancrable (thème + synthèse), preuves = deux fragments donnés. */
function seedSynthesis(db: ReturnType<typeof makeTestDb>["db"], evidence: string[]): string {
  const fragments = createFragmentsRepo(db);
  const sources = createSourcesRepo(db);
  db.prepare(
    `INSERT INTO themes (id, run_id, corpus_hash, seed, label, centroid, centroid_dimensions,
       size, sampler_version, created_at)
     VALUES ('theme-1', 'run-1', 'hash-1', 'seed-1', 'doute · mesure', ?, 8, 2, 'seeds-v1', '2026-09-19')`
  ).run(encodeEmbedding(V(1, 0), 8));
  const text = "Le doute cartésien énonce la règle que la mesure expérimentale applique au vivant.";
  const created = createSynthesesRepo(db).create({
    text,
    theme_id: "theme-1",
    relation_kind: "extension",
    epistemic_status: "INFERENCE",
    evidence_fragment_ids: evidence,
    provenance_snapshot: evidence.map((id) => {
      const f = fragments.getById(id) as NonNullable<ReturnType<typeof fragments.getById>>;
      return {
        fragment_id: f.id,
        source_id: f.source_id,
        source_title: sources.getById(f.source_id)?.title ?? null,
        content_hash: "hash",
        locator: f.locator,
        text: f.text,
      };
    }),
    content_sig: contentSig(text),
    confidence: "high",
    prompt_version: "synthesis-v2",
    chat_model: "test-model",
  });
  if (!created.ok) throw new Error(`synthèse de test refusée : ${created.reason}`);
  return created.id;
}

function makeService(
  db: ReturnType<typeof makeTestDb>["db"],
  chat: LlmProvider,
  promptCache?: Map<string, unknown>
) {
  return new ConversationService({
    db,
    conversations: createConversationsRepo(db),
    syntheses: createSynthesesRepo(db),
    canvasLinks: createConversationCanvasRepo(db),
    fragments: createFragmentsRepo(db),
    sources: createSourcesRepo(db),
    chat,
    chatModel: "test-model",
    chatSignature: "test-model|low|2048",
    promptCache,
  });
}

/** Une conversation ancrée à une synthèse, et son premier message utilisateur. */
function startTurn(
  db: ReturnType<typeof makeTestDb>["db"],
  question: string,
  opts?: { anchor?: string | null }
) {
  const conversations = createConversationsRepo(db);
  conversations.create({
    id: "conv-1",
    anchorKind: opts?.anchor ? "synthesis" : "corpus",
    anchorRef: opts?.anchor ?? null,
    title: conversationTitle(question),
    chatModel: "test-model",
    promptVersion: "conversation-v1",
  });
  const user = conversations.addUserMessage({ id: "msg-user-1", conversationId: "conv-1", text: question });
  return { conversations, user, question };
}

function readTurn(conversations: ConversationsRepo, messageId: string): ConversationTurn {
  return parseConversationTurn(conversations.getMessage(messageId)?.run ?? null);
}

describe("migration 009 : conversations, messages, kind de job", () => {
  it("les deux tables existent et le kind `conversation` est accepté par jobs", () => {
    const { db } = makeTestDb();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain("conversations");
    expect(tables).toContain("messages");

    const jobs = createJobsRepo(db);
    const job = jobs.createJob({
      kind: "conversation",
      payload: { conversation_id: "c1", question_message_id: "m1", question: "pourquoi ?" },
      sourceId: null,
      idempotencyKey: idempotencyKey(["conversation", "c1", "m1"]),
    });
    expect(jobs.getById(job.id)?.kind).toBe("conversation");
  });

  it("l'ancre est un fait de la ligne : `synthesis` sans `anchor_ref` est refusé par la base", () => {
    const { db } = makeTestDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO conversations (id, anchor_kind, anchor_ref, title, chat_model, prompt_version, created_at, updated_at)
           VALUES ('c', 'synthesis', NULL, 't', 'm', 'p', 'now', 'now')`
        )
        .run()
    ).toThrow(/CHECK/i);
    // et l'inverse : une ancre sur `corpus` ne porte pas de référence
    expect(() =>
      db
        .prepare(
          `INSERT INTO conversations (id, anchor_kind, anchor_ref, title, chat_model, prompt_version, created_at, updated_at)
           VALUES ('c', 'corpus', 'synth-1', 't', 'm', 'p', 'now', 'now')`
        )
        .run()
    ).toThrow(/CHECK/i);
  });

  it("un rôle inconnu et un statut inconnu sont refusés par la base", () => {
    const { db } = makeTestDb();
    createConversationsRepo(db).create({
      id: "c",
      anchorKind: "corpus",
      anchorRef: null,
      title: "t",
      chatModel: "m",
      promptVersion: "p",
    });
    const insert = (id: string, role: string, status: string) =>
      db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, text, claims, run, status, created_at)
           VALUES (?, 'c', ?, 't', '[]', NULL, ?, 'now')`
        )
        .run(id, role, status);
    // la forme valide passe : ce qui suit échoue bien sur la contrainte visée
    expect(() => insert("m-ok", "assistant", "done")).not.toThrow();
    expect(() => insert("m-role", "system", "done")).toThrow(/CHECK/i);
    expect(() => insert("m-status", "assistant", "streaming")).toThrow(/CHECK/i);
  });
});

describe("dépôt conversations", () => {
  it("crée, relit et liste ; l'ancre sur une synthèse inexistante est refusée", () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const repo = createConversationsRepo(db);

    const row = repo.create({
      id: "conv-ok",
      anchorKind: "synthesis",
      anchorRef: synthId,
      title: conversationTitle("Que dit Descartes sur la mesure ?"),
      chatModel: "test-model",
      promptVersion: "conversation-v1",
    });
    expect(row.anchor_ref).toBe(synthId);
    expect(repo.getById("conv-ok")?.title).toContain("Descartes");
    expect(repo.list().map((c) => c.id)).toEqual(["conv-ok"]);

    expect(() =>
      repo.create({
        anchorKind: "synthesis",
        anchorRef: "synth-inexistante",
        title: "t",
        chatModel: "m",
        promptVersion: "p",
      })
    ).toThrow(/synthèse introuvable/);
    expect(() =>
      repo.create({
        anchorKind: "corpus",
        anchorRef: "synth-1",
        title: "t",
        chatModel: "m",
        promptVersion: "p",
      })
    ).toThrow(/n'admet pas anchor_ref/);
  });

  it("les messages se lisent dans l'ordre, `limit` garde les derniers, et la suppression cascade", () => {
    const { db } = setup();
    const repo = createConversationsRepo(db);
    repo.create({
      id: "conv-1",
      anchorKind: "corpus",
      anchorRef: null,
      title: "t",
      chatModel: "m",
      promptVersion: "p",
    });
    const turn: ConversationTurn = {
      ...emptyConversationTurn(),
      prompt_version: "conversation-v1",
      chat_model: "m",
      step_budget: 5,
      llm_calls: 1,
    };
    repo.addUserMessage({ id: "u1", conversationId: "conv-1", text: "question 1" });
    repo.upsertAssistantMessage({
      id: "a1",
      conversationId: "conv-1",
      status: "done",
      text: "réponse 1",
      claims: [],
      turn,
    });
    repo.addUserMessage({ id: "u2", conversationId: "conv-1", text: "question 2" });

    expect(repo.listMessages("conv-1").map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect(repo.listMessages("conv-1", { limit: 2 }).map((m) => m.id)).toEqual(["a1", "u2"]);

    repo.deleteById("conv-1");
    expect(repo.listMessages("conv-1")).toEqual([]);
  });

  it("réécrire la réponse du même tour met à jour sa ligne au lieu d'en empiler une seconde", () => {
    const { db } = setup();
    const repo = createConversationsRepo(db);
    repo.create({
      id: "conv-1",
      anchorKind: "corpus",
      anchorRef: null,
      title: "t",
      chatModel: "m",
      promptVersion: "p",
    });
    const turn = (n: number): ConversationTurn => ({
      ...emptyConversationTurn(),
      prompt_version: "conversation-v1",
      chat_model: "m",
      step_budget: 5,
      llm_calls: n,
    });
    repo.upsertAssistantMessage({
      id: "a1",
      conversationId: "conv-1",
      status: "pending",
      text: "",
      claims: [],
      turn: turn(0),
    });
    repo.upsertAssistantMessage({
      id: "a1",
      conversationId: "conv-1",
      status: "done",
      text: "réponse",
      claims: [{ text: "réponse", provenance: [] }],
      turn: turn(2),
    });
    const rows = repo.listMessages("conv-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
    expect(JSON.parse(rows[0].run as string).llm_calls).toBe(2);
  });

  it("`turnInFlight` couvre la fenêtre de file : une question sans réponse terminale bloque la suivante", () => {
    const { db } = setup();
    const repo = createConversationsRepo(db);
    repo.create({
      id: "conv-1",
      anchorKind: "corpus",
      anchorRef: null,
      title: "t",
      chatModel: "m",
      promptVersion: "p",
    });
    const turn = (): ConversationTurn => ({
      ...emptyConversationTurn(),
      prompt_version: "conversation-v2",
      chat_model: "m",
      step_budget: 5,
    });
    const last = () => repo.listMessages("conv-1", { limit: 1 })[0];
    const write = (id: string, status: "pending" | "done" | "failed") =>
      repo.upsertAssistantMessage({
        id,
        conversationId: "conv-1",
        status,
        text: "",
        claims: [],
        turn: turn(),
      });

    expect(turnInFlight(last())).toBe(false); // conversation vide

    // **la fenêtre de file** : la ligne de réponse est écrite par le worker à son démarrage,
    // donc entre le `POST` et la prise en charge du job la dernière ligne est la question.
    // C'est ce que la garde initiale (`status === 'pending'`) laissait passer — deux tours
    // menés en parallèle, mesuré sur la base jetable de vérification HTTP du 2026-09-19.
    repo.addUserMessage({ id: "u1", conversationId: "conv-1", text: "question 1" });
    expect(turnInFlight(last())).toBe(true);

    write("a1", "pending");
    expect(turnInFlight(last())).toBe(true);

    write("a1", "done");
    expect(turnInFlight(last())).toBe(false);

    // un échec **vaut** réponse : c'est le seul moyen de réessayer sans nouvelle conversation
    write("a2", "failed");
    expect(turnInFlight(last())).toBe(false);
  });
});

describe("service : tour de conversation", () => {
  it("explore puis répond ; le texte est l'union des affirmations et porte leurs provenances", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "La mesure prolonge-t-elle le doute ?", { anchor: synthId });
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      {
        action: "answer",
        claims: [
          { text: "La mesure expérimentale hérite de la règle du doute.", citations: [0] },
          { text: "Elle la restreint au vivant.", citations: [1] },
        ],
      },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "La mesure prolonge-t-elle le doute ?",
    });

    expect(result.status).toBe("done");
    expect(result.claims).toBe(2);
    expect(result.unsourced).toBe(0);
    expect(result.llmCalls).toBe(2);

    const message = conversations.getMessage("msg-assistant-1");
    expect(message?.status).toBe("done");
    // le texte affiché EST l'union des affirmations (jamais la prose du modèle)
    expect(message?.text).toBe(
      "La mesure expérimentale hérite de la règle du doute. Elle la restreint au vivant."
    );
    const claims = JSON.parse(message?.claims as string);
    expect(claims[0].provenance[0].locator).toBeDefined();
    expect(claims[0].provenance[0].fragment_id).toBe(fA);

    const turn = readTurn(conversations, "msg-assistant-1");
    expect(turn.steps.map((s) => s.action)).toEqual(["search", "answer"]);
    expect(turn.catalogue.length).toBeGreaterThanOrEqual(2);
    expect(turn.step_budget).toBe(CONVERSATION_STEP_BUDGET);
    expect(turn.web_unlocked).toBe(false);
  });

  it("citer un fragment jamais montré est refusé, mais le refus est récupérable", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Que dit le corpus ?", { anchor: synthId });
    // le tour commence par lire : c'est la règle depuis la mesure du 2026-09-19, et c'est ce
    // qui rend le motif du refus vérifiable ici
    const llm = new ScriptedLlm([
      { action: "search", query: "doute" },
      { action: "answer", claims: [{ text: "Affirmation adossée à rien.", citations: [42] }] },
      { action: "answer", claims: [{ text: "Affirmation appuyée.", citations: [0] }] },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus ?",
    });

    expect(result.status).toBe("done");
    const turn = readTurn(conversations, "msg-assistant-1");
    expect(turn.steps[1].refused).toBe("reponse_hors_catalogue");
    expect(turn.steps[2].refused).toBeUndefined();
    expect(conversations.getMessage("msg-assistant-1")?.text).toBe("Affirmation appuyée.");
  });

  it("une réponse dont aucune affirmation n'est appuyée est refusée ; et le motif décrit le tour échoué", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Et ensuite ?", { anchor: synthId });
    const llm = new ScriptedLlm([
      { action: "search", query: "doute" },
      { action: "answer", claims: [{ text: "Une idée générale sans appui.", citations: [] }] },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Et ensuite ?",
      maxSteps: 2,
    });

    expect(result.status).toBe("failed");
    // « budget épuisé » serait vrai mais ne dirait rien de ce qui a été refusé
    expect(result.failure).toBe("reponse_sans_aucune_preuve");
    expect(conversations.getMessage("msg-assistant-1")?.status).toBe("failed");
    const turn = readTurn(conversations, "msg-assistant-1");
    // l'exploration a bien abouti (étape 1), c'est l'étape 2 qui est refusée
    expect(turn.steps[0].refused).toBeUndefined();
    expect(turn.steps[1].refused).toBe("reponse_sans_aucune_preuve");
  });

  it("une affirmation non sourcée est acceptée **si** la réponse est appuyée par ailleurs (AC1)", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Quel est le lien ?", { anchor: synthId });
    const llm = new ScriptedLlm([
      { action: "search", query: "doute" },
      {
        action: "answer",
        claims: [
          { text: "Le doute énonce une règle.", citations: [0] },
          { text: "On peut donc en tirer une conséquence.", citations: [] },
        ],
      },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Quel est le lien ?",
    });

    expect(result.status).toBe("done");
    expect(result.unsourced).toBe(1);
    expect(result.claims).toBe(2);
    const claims = JSON.parse(conversations.getMessage("msg-assistant-1")?.claims as string);
    expect(claims[1].provenance).toEqual([]);
  });

  /**
   * Contrat v9 (décision du 2026-10-01) : le modèle rend une **prose** et ses sources, et
   * c'est le serveur qui découpe en phrases et rattache. Ce qui est testé ici est le
   * rattachement, pas la qualité du découpage : une phrase recouvre une source si ses mots
   * de contenu s'y retrouvent (asymétrique, seuil 0,34).
   */
  it("une réponse en prose est découpée par le serveur, et les sources déclarées sont rattachées aux phrases", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Que dit le corpus de la mesure ?", { anchor: synthId });
    const llm = new ScriptedLlm([
      { action: "search", query: "doute" },
      {
        action: "answer",
        answer: {
          prose:
            "Le doute methodique ecarte les opinions seulement probables. " +
            "La mesure experimentale fixe les conditions de l'observation. " +
            "On peut donc lire ces deux textes comme un meme mouvement.",
          citations: [0, 1],
        },
      },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus de la mesure ?",
    });

    expect(result.status).toBe("done");
    const claims = JSON.parse(conversations.getMessage("msg-assistant-1")?.claims as string);
    expect(claims).toHaveLength(3);
    // phrase 1 : recouverte par le fragment cité (doute)
    expect(claims[0].provenance.map((p: { kind: string }) => p.kind)).toEqual(["fragment"]);
    // phrase 2 : recouverte par l'autre fragment cité (mesure)
    expect(claims[1].provenance.map((p: { kind: string }) => p.kind)).toEqual(["fragment"]);
    // phrase 3 : transition assumée, sans recouvrement — marquée propre au modèle
    expect(claims[2].own_knowledge).toBe(true);
    expect(claims[2].provenance).toEqual([]);
    expect(conversations.getMessage("msg-assistant-1")?.text).toContain("meme mouvement");
  });

  it("une réponse 100 % own_knowledge est recevable : le modèle assume, l'écran dira quoi", async () => {
    const { db } = setup();
    const { conversations } = startTurn(db, "Que dit le corpus de la mesure ?");
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      {
        action: "answer",
        answer: {
          prose: "Le corpus ne parle pas de mesure au sens scientifique : ici, il s'agit de mesure expérimentale au sens de Claude Bernard.",
          own_knowledge: true,
        },
      },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus de la mesure ?",
    });

    expect(result.status).toBe("done");
    const claims = JSON.parse(conversations.getMessage("msg-assistant-1")?.claims as string);
    expect(claims.every((c: { provenance: unknown[] }) => c.provenance.length === 0)).toBe(true);
    expect(claims.every((c: { own_knowledge: boolean }) => c.own_knowledge === true)).toBe(true);
  });

  it("une prose qui prétend rapporter des sources sans en déclarer reste refusée", async () => {
    const { db } = setup();
    startTurn(db, "Que dit le corpus ?");
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      {
        action: "answer",
        answer: { prose: "Les documents affirment tous la meme chose, sans source déclarée." },
      },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus ?",
      maxSteps: 2,
    });

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("reponse_sans_aucune_preuve");
  });

  /**
   * Défaut réel du 2026-10-01 (tour « Ca sert a quoi un LLM ? ») : le prompt montre le
   * format answer **à plat** (prose/citations au niveau racine), la première mouture du
   * schéma l'exigeait **imbriquée** sous `answer` — le modèle a suivi le prompt (à juste
   * titre) et le schéma a rejeté la bonne réponse (`sortie_invalide`, 8 fragments trouvés
   * pour rien). Non-régression : la forme plate du prompt EST le contrat ; la forme
   * imbriquée est normalisée, l'ancienne sortie `claims` reste acceptée en repli.
   */
  it("la sortie answer en forme plate (celle du prompt) est acceptée, imbriquée normalisée", async () => {
    const { db } = setup();
    const { conversations } = startTurn(db, "Que dit le corpus de la mesure ?");
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      {
        action: "answer",
        prose:
          "La mesure experimentale fixe les conditions de l'observation. " +
          "C'est ce que le corpus montre le plus clairement.",
        citations: [0],
      },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus de la mesure ?",
    });

    expect(result.status).toBe("done");
    const claims = JSON.parse(conversations.getMessage("msg-assistant-1")?.claims as string);
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(claims[0].provenance.map((p: { kind: string }) => p.kind)).toContain("fragment");
  });

  it("un reasoning trop long n'annule pas l'action (champ libre, jamais lu)", async () => {
    const { db } = setup();
    const { conversations } = startTurn(db, "Que dit le corpus ?");
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      {
        action: "answer",
        prose: "La mesure experimentale fixe les conditions de l'observation du vivant.",
        citations: [0],
        reasoning: "x".repeat(12_000),
      },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus ?",
    });

    expect(result.status).toBe("done");
    expect(conversations.getMessage("msg-assistant-1")?.text).toContain("mesure");
  });

  it("une question posée sur le corpus entier doit lire avant de répondre", async () => {
    const { db } = setup();
    const { conversations } = startTurn(db, "Que dit le corpus de la mesure ?");
    const llm = new ScriptedLlm([
      { action: "answer", claims: [{ text: "Réponse sans rien avoir lu.", citations: [0] }] },
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "Réponse après lecture.", citations: [0] }] },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus de la mesure ?",
    });

    expect(result.status).toBe("done");
    const turn = readTurn(conversations, "msg-assistant-1");
    // le premier refus est motivé : il n'y avait rien à citer, le catalogue était vide
    expect(turn.steps[0].refused).toBe("reponse_sans_exploration");
    expect(turn.catalogue.length).toBeGreaterThan(0);
  });

  it("un tour ancré doit lire avant de répondre : l'ancre est un contexte, pas une lecture", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Et ensuite ?", { anchor: synthId });
    // le catalogue **contient déjà** les deux preuves de la synthèse : répondre d'entrée
    // était autorisé par la première version, et c'est ce qui a produit un tour réel qui ne
    // répondait pas à sa question (mesure du 2026-09-19)
    const llm = new ScriptedLlm([
      {
        action: "answer",
        claims: [{ text: "Réponse depuis les seules preuves de la synthèse.", citations: [0] }],
      },
      { action: "search", query: "doute" },
      { action: "answer", claims: [{ text: "Réponse après lecture.", citations: [0] }] },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Et ensuite ?",
    });

    expect(result.status).toBe("done");
    const turn = readTurn(conversations, "msg-assistant-1");
    expect(turn.catalogue.length).toBeGreaterThanOrEqual(2);
    expect(turn.steps[0].refused).toBe("reponse_sans_exploration");
    expect(turn.steps[1].action).toBe("search");
    expect(conversations.getMessage("msg-assistant-1")?.text).toBe("Réponse après lecture.");
  });

  it("une réponse qui parle du protocole est refusée, et réécrite à l'étape suivante", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Que dit le corpus du doute ?", { anchor: synthId });
    // le défaut réel du 2026-09-19 : les indices de catalogue décrits en clair dans le texte
    // affiché (« Le fragment [0] affirme que… »), puisque `messages.text` est l'union des
    // affirmations
    const llm = new ScriptedLlm([
      { action: "search", query: "doute" },
      {
        action: "answer",
        claims: [{ text: "Le fragment [0] affirme que le doute écarte le probable.", citations: [0] }],
      },
      {
        action: "answer",
        claims: [{ text: "Le doute méthodique écarte les opinions seulement probables.", citations: [0] }],
      },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus du doute ?",
    });

    expect(result.status).toBe("done");
    const turn = readTurn(conversations, "msg-assistant-1");
    expect(turn.steps[1].refused).toBe("reponse_avec_repere_technique");
    const text = conversations.getMessage("msg-assistant-1")?.text as string;
    expect(text).toBe("Le doute méthodique écarte les opinions seulement probables.");
    expect(text).not.toContain("[");
  });

  /**
   * Deux bornes, et elles sont **séparées** : le budget compte ce qui est **exécuté**, les
   * refus non facturés ont la leur (`MAX_REFUSED_STEPS`). Ici le modèle ne fait que répéter une
   * recherche : quatre passent (l'exploration est plafonnée à `budget − 1`, la réponse garde sa
   * place), les suivantes sont refusées — et au troisième refus d'affilée, le tour s'arrête, au
   * lieu de boucler sur des refus qui ne coûtent rien.
   *
   * La version précédente affirmait `steps === budget`, ce qui couplait les deux bornes : un
   * refus consommait alors la place d'une **étape facturée**, et un tour à court de budget
   * pouvait échouer sans avoir jamais eu la place de répondre (défaut mesuré sur le workspace).
   */
  it("plafond dur : 99 étapes demandées, quatre exécutées et trois refus, puis arrêt", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Question sans fin", { anchor: synthId });
    const llm = new ScriptedLlm([{ action: "search", query: "mesure" }]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Question sans fin",
      maxSteps: 99,
    });

    expect(result.steps).toBe(CONVERSATION_STEP_BUDGET - 1 + MAX_REFUSED_STEPS);
    expect(llm.calls).toBe(result.steps); // une itération = un appel LLM, refus compris
    // les étapes **facturées** ne dépassent jamais le budget (AC5′)
    expect(result.internalSteps).toBe(CONVERSATION_STEP_BUDGET - 1);
    expect(result.internalSteps).toBeLessThanOrEqual(CONVERSATION_STEP_BUDGET);
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("refus_repete");
    expect(readTurn(conversations, "msg-assistant-1").step_budget).toBe(CONVERSATION_STEP_BUDGET);
    // le dernier refus dit au modèle quoi faire, et il est tracé comme non facturé
    const steps = readTurn(conversations, "msg-assistant-1").steps;
    expect(steps.at(-1)?.failure).toBe("budget_interne_epuise");
    expect(steps.at(-1)?.charged).toBe(false);
  });

  /**
   * Défaut réel, trouvé par un tour réel du 2026-09-20 : la branche « sortie invalide » sortait
   * de la boucle avec un statut déjà `failed`, donc le bloc qui ne traitait que `pending` ne
   * passait pas — la ligne `messages` restait `pending` **pour toujours**, `awaiting_reply` vrai,
   * l'écran qui sonde sans fin et le 409 qui verrouille la conversation. Le tour était perdu
   * **sans trace** : 0 affirmation, un job `done`.
   */
  it("une sortie invalide est un échec tracé, et ne laisse pas la réponse en `pending`", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Question illisible", { anchor: synthId });
    const result = await makeService(db, new UnreadableLlm()).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Question illisible",
    });

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sortie_invalide");
    expect(result.llmCalls).toBe(0);

    const row = conversations.getMessage("msg-assistant-1");
    // la ligne **est** terminale : c'est ce qui libère la conversation
    expect(row?.status).toBe("failed");
    expect(turnInFlight(row)).toBe(false);
    // et l'étape invalide est tracée, non facturée (rien n'a été exécuté)
    const turn = parseConversationTurn(row?.run ?? null);
    expect(turn.steps.at(-1)).toMatchObject({ action: "invalid", charged: false });
    expect(turn.internal_steps).toBe(0);
  });

  it("un rejeu du même tour ne rappelle pas le modèle et réécrit la même réponse", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Que dit le corpus ?", { anchor: synthId });
    const cache = new Map<string, unknown>();
    const actions = [
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "Réponse stable.", citations: [0] }] },
    ];

    const llm1 = new ScriptedLlm(actions);
    await makeService(db, llm1, cache).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus ?",
    });
    const first = conversations.getMessage("msg-assistant-1");
    const firstCalls = llm1.calls;

    const llm2 = new ScriptedLlm(actions);
    const result = await makeService(db, llm2, cache).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus ?",
    });

    expect(firstCalls).toBe(2);
    expect(llm2.calls).toBe(0);
    expect(result.llmCallsFromCache).toBe(2);
    expect(conversations.getMessage("msg-assistant-1")?.text).toBe(first?.text);
    expect(conversations.listMessages("conv-1").filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("le tour suivant reçoit l'échange précédent dans son prompt, et rien du précédent pour le premier", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Première question ?", { anchor: synthId });
    const llm = new ScriptedLlm([
      { action: "search", query: "doute" },
      { action: "answer", claims: [{ text: "Première réponse appuyée.", citations: [0] }] },
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "Seconde réponse appuyée.", citations: [1] }] },
    ]);
    const service = makeService(db, llm);
    await service.run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Première question ?",
    });
    const second = conversations.addUserMessage({
      id: "msg-user-2",
      conversationId: "conv-1",
      text: "Deuxième question ?",
    });
    await service.run("conv-1", {
      messageId: "msg-assistant-2",
      questionMessageId: second.id,
      question: "Deuxième question ?",
    });

    // deux étapes par tour (lire, puis répondre) : le premier prompt du second tour est le 3ᵉ
    const [firstPrompt] = llm.prompts;
    const secondPrompt = llm.prompts[2];
    expect(firstPrompt).not.toContain("Première réponse appuyée.");
    expect(secondPrompt).toContain("Première réponse appuyée.");
    expect(secondPrompt).toContain("Deuxième question ?");
    // le premier tour n'a aucun historique, le second en a deux messages
    expect(readTurn(conversations, "msg-assistant-1").history_messages).toBe(0);
    expect(readTurn(conversations, "msg-assistant-2").history_messages).toBe(2);
    // l'historique du second tour porte la question **précédente**, pas la sienne :
    // le serveur délimite sur le message déclencheur, il ne devine pas
    expect(secondPrompt).toContain("Première question ?");
  });

  it("aucun prompt ne contient d'identifiant de fragment", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    startTurn(db, "Que dit le corpus ?", { anchor: synthId });
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "Réponse.", citations: [0] }] },
    ]);
    await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que dit le corpus ?",
    });
    for (const prompt of llm.prompts) {
      expect(prompt).not.toContain("frag-");
      expect(prompt).not.toContain(fA);
      expect(prompt).not.toContain(fB);
    }
  });
});

describe("vérification à la lecture", () => {
  it("supprimer un fragment cité transforme l'affirmation en affirmation non sourcée", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "Quel est le lien ?", { anchor: synthId });
    const llm = new ScriptedLlm([
      { action: "search", query: "doute" },
      { action: "answer", claims: [{ text: "Le doute écarte les opinions probables.", citations: [0] }] },
    ]);
    await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Quel est le lien ?",
    });

    const turn = readTurn(conversations, "msg-assistant-1");
    const before = verifyConversationTurn(db, turn);
    expect(before.unsourced).toBe(0);
    expect(before.claims[0].sourced).toBe(true);

    // la source est supprimée : la copie au moment T reste lisible, mais elle n'est plus
    // une preuve — exactement l'AC1 (« jamais présentée comme un fait »)
    createSourcesRepo(db).deleteById(readSourceOf(db, fA));
    const after = verifyConversationTurn(db, turn);
    expect(after.claims[0].text).toBe("Le doute écarte les opinions probables.");
    expect(after.claims[0].sourced).toBe(false);
    expect(after.unsourced).toBe(1);
    expect(after.unverified).toBe(1);
    expect(after.claims[0].provenance[0].problem).toBe("fragment_absent");
  });
});

function readSourceOf(db: ReturnType<typeof makeTestDb>["db"], fragmentId: string): string {
  const row = db.prepare("SELECT source_id FROM fragments WHERE id = ?").get(fragmentId) as
    | { source_id: string }
    | undefined;
  return row?.source_id as string;
}

describe("worker : job conversation", () => {
  it("process() : la réponse est écrite dans `messages`, le job passe done", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations, user } = startTurn(db, "Quel est le lien ?", { anchor: synthId });
    const jobs = createJobsRepo(db);
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "Réponse du worker.", citations: [0] }] },
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
      conversation: makeService(db, llm),
    });

    const job = jobs.createJob({
      kind: "conversation",
      payload: conversationTurnJobPayload({
        conversationId: "conv-1",
        questionMessageId: user.id,
        question: "Quel est le lien ?",
      }),
      sourceId: null,
      idempotencyKey: conversationTurnJobKey("conv-1", user.id),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    expect(jobs.getById(job.id)?.status).toBe("done");
    // l'id de la réponse est celui du job : un rejeu met à jour la même ligne
    const message = conversations.getMessage(job.id);
    expect(message?.status).toBe("done");
    expect(message?.text).toBe("Réponse du worker.");
    const progress = JSON.parse(jobs.getById(job.id)?.progress_json as string);
    expect(progress.claims).toBe(1);
    expect(progress.steps).toBe(2);
  });

  it("un tour sans réponse n'est pas une panne de job : `messages.status = failed`, job done", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations, user } = startTurn(db, "Question sans réponse ?", { anchor: synthId });
    const jobs = createJobsRepo(db);
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
      conversation: makeService(db, llm),
    });

    const job = jobs.createJob({
      kind: "conversation",
      payload: conversationTurnJobPayload({
        conversationId: "conv-1",
        questionMessageId: user.id,
        question: "Question sans réponse ?",
      }),
      sourceId: null,
      idempotencyKey: conversationTurnJobKey("conv-1", user.id),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    expect(jobs.getById(job.id)?.status).toBe("done");
    expect(conversations.getMessage(job.id)?.status).toBe("failed");
    // le modèle ne fait que rechercher : les explorations facturées s'arrêtent à `budget − 1`,
    // puis les refus (non facturés) s'enchaînent — et au troisième, le tour s'arrête et le dit
    expect(readTurn(conversations, job.id).failure).toBe("refus_repete");
  });

  it("conversation disparue : aucune ligne orpheline, aucun appel LLM, et le job repart en file", async () => {
    const { db } = setup();
    const jobs = createJobsRepo(db);
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
      conversation: makeService(db, llm),
    });

    const job = jobs.createJob({
      kind: "conversation",
      payload: conversationTurnJobPayload({
        conversationId: "conv-inexistante",
        questionMessageId: "msg-1",
        question: "Quel est le lien ?",
      }),
      sourceId: null,
      idempotencyKey: conversationTurnJobKey("conv-inexistante", "msg-1"),
    });
    const [claimed] = jobs.claim(1);
    await worker.process(claimed as ClaimedJob);

    // même convention que la suggestion disparue de la Phase 4 : l'erreur est passagère du
    // point de vue du worker, le job est réessayé jusqu'à épuiser ses tentatives — mais rien
    // n'a été écrit et le modèle n'a pas été appelé (la conversation manque dès le premier
    // contrôle)
    expect(jobs.getById(job.id)?.status).toBe("pending");
    expect(jobs.getById(job.id)?.attempts).toBe(1);
    expect(createConversationsRepo(db).getMessage(job.id)).toBeNull();
    expect(llm.calls).toBe(0);
  });

  it("une clé d'idempotence par message : rejouer la même demande reprend le même job, reposer la question en crée un autre", () => {
    const k1 = conversationTurnJobKey("conv-1", "msg-1");
    const same = conversationTurnJobKey("conv-1", "msg-1");
    const other = conversationTurnJobKey("conv-1", "msg-2");
    expect(k1).toBe(same);
    expect(k1).not.toBe(other);
  });
});

describe("multi-ancrage — les constructions des tableaux ancrés entrent dans le catalogue (v1.6 AC5)", () => {
  /** Un tableau + une construction posée dessus (extraits + paire parente). */
  function seedAnchoredCanvas(
    db: ReturnType<typeof makeTestDb>["db"],
    canvasId: string,
    constructionId: string,
    opts: { evidence: string[]; suggestionId?: string }
  ): void {
    const now = "2026-09-29T10:00:00.000Z";
    db.prepare(
      `INSERT INTO canvases (id, label, color, is_default, pinned, position, created_at, updated_at)
       VALUES (?, 'Tableau de test', NULL, 0, 0, 2, ?, ?)`
    ).run(canvasId, now, now);
    db.prepare(
      `INSERT INTO constructions (id, text, epistemic_status, parent_source_ids, evidence_fragment_ids,
         suggestion_id, depth, stale, provenance_snapshot)
       VALUES (?, 'Une construction ancrée.', 'INFERENCE', '[]', ?, ?, 1, 0, '[]')`
    ).run(constructionId, JSON.stringify(opts.evidence), opts.suggestionId ?? null);
    db.prepare(
      `INSERT INTO canvas_items (item_kind, item_ref, x, y, z, canvas_id, frame_id, created_at, updated_at)
       VALUES ('construction', ?, 10, 10, 1, ?, NULL, ?, ?)`
    ).run(constructionId, canvasId, now, now);
  }

  it("les extraits des constructions des tableaux ancrés rejoignent le catalogue de départ", async () => {
    const { db, fA } = setup();
    seedAnchoredCanvas(db, "canvas-ancré", "c-1", { evidence: [fA] });
    const { conversations } = startTurn(db, "Que disent mes notes ?");
    createConversationCanvasRepo(db).link("conv-1", "canvas-ancré");
    // le constat d'exploration (§13.4) vaut aussi avec un seed non vide : une
    // étape search d'abord, la réponse ensuite — sinon la réponse est refusée
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "Le doute écarte le probable.", citations: [0] }] },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que disent mes notes ?",
    });

    expect(result.status).toBe("done");
    const turn = readTurn(conversations, "msg-assistant-1");
    // l'extrait de la construction ancrée est **dans le catalogue de départ** (origin seed)
    expect(turn.catalogue.map((e) => e.fragment_id)).toContain(fA);
    expect(turn.catalogue[0]?.origin).toBe("seed");
    // l'affirmation qui cite l'indice du seed est vérifiable comme le reste (AC1)
    expect(result.unsourced).toBe(0);
  });

  it("la paire parente d'une construction (sa suggestion) entre aussi dans le catalogue", async () => {
    const { db, s1, fA, fB } = setup();
    // une suggestion parente dont les fragments sont HORS extraits de la construction
    const sg = createSuggestionsRepo(db).create({
      claim: "Paire parente de test.",
      relation_type: "analogy",
      tier: "medium",
      fragment_a_id: fB,
      fragment_b_id: fA,
      pair_key: `${fB}|${fA}`,
      content_sig: contentSig("Paire parente de test."),
      epistemic_status: "INFERENCE",
      prompt_version: "pv",
      chat_model: "m",
    });
    if (!sg.ok) throw new Error("suggestion de test refusée");
    seedAnchoredCanvas(db, "canvas-ancré", "c-1", {
      evidence: ["frag-inexistant"], // sauté : jamais inventé
      suggestionId: sg.id,
    });
    const { conversations } = startTurn(db, "Que disent mes notes ?");
    createConversationCanvasRepo(db).link("conv-1", "canvas-ancré");
    const llm = new ScriptedLlm([
      { action: "answer", claims: [{ text: "Les deux corpus se répondent.", citations: [0] }] },
    ]);
    await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que disent mes notes ?",
    });

    const turn = readTurn(conversations, "msg-assistant-1");
    const ids = turn.catalogue.map((e) => e.fragment_id);
    // les deux fragments de la paire parente sont là ; le fragment disparu ne l'est pas
    expect(ids).toContain(fB);
    expect(ids).toContain(fA);
    expect(ids).not.toContain("frag-inexistant");
    // ...et la source de chaque entrée est celle du fragment (jamais devinée)
    const entry = turn.catalogue.find((e) => e.fragment_id === fA)!;
    expect(entry.source_id).toBe(s1);
  });

  it("le plafond du catalogue borne le seed multi-ancré (débordement impossible)", async () => {
    const { db, fA, fB } = setup();
    // deux tableaux ancrés, deux constructions, quatre extraits voulus — pour un
    // catalogue plafonné à 3 : le tout entre, tronqué, sans jamais dépasser
    const { conversations } = startTurn(db, "Que disent mes notes ?");
    seedAnchoredCanvas(db, "canvas-a", "c-a", { evidence: [fA, fB] });
    seedAnchoredCanvas(db, "canvas-b", "c-b", { evidence: [fA] });
    createConversationCanvasRepo(db).link("conv-1", "canvas-a");
    createConversationCanvasRepo(db).link("conv-1", "canvas-b");
    const llm = new ScriptedLlm([
      { action: "search", query: "mesure" },
      { action: "answer", claims: [{ text: "Une affirmation.", citations: [0] }] },
    ]);
    const result = await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "Que disent mes notes ?",
      catalogueSize: 3,
    });

    expect(result.status).toBe("done");
    const turn = readTurn(conversations, "msg-assistant-1");
    // le plafond vaut pour le seed **et** pour ce que l'exploration ajoute ensuite
    expect(turn.catalogue.length).toBeLessThanOrEqual(3);
    // et le seed a pris sa part : les extraits des deux tableaux ancrés sont là
    expect(turn.catalogue.map((e) => e.fragment_id)).toEqual(expect.arrayContaining([fA, fB]));
  });

  it("sans tableau ancré, le catalogue est celui d'avant (aucune régression)", async () => {
    const { db, fA, fB } = setup();
    const synthId = seedSynthesis(db, [fA, fB]);
    const { conversations } = startTurn(db, "La mesure prolonge-t-elle le doute ?", { anchor: synthId });
    const llm = new ScriptedLlm([
      { action: "answer", claims: [{ text: "Réponse.", citations: [0] }] },
    ]);
    await makeService(db, llm).run("conv-1", {
      messageId: "msg-assistant-1",
      questionMessageId: "msg-user-1",
      question: "La mesure prolonge-t-elle le doute ?",
    });
    const turn = readTurn(conversations, "msg-assistant-1");
    // seulement les preuves de la synthèse ancrée : aucun canvas ancré n'ajoute quoi que ce soit
    expect(turn.catalogue.map((e) => e.fragment_id).sort()).toEqual([fA, fB].sort());
  });
});
