import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeFragment, makeTestDb, makeTextSource } from "./helpers";
import { contentSig } from "@/lib/discover/epistemic";
import { encodeEmbedding } from "@/lib/llm/embedding-codec";

import { createConversationsRepo } from "@/lib/repositories/conversations";
import { createConversationCanvasRepo } from "@/lib/repositories/conversation-canvases";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { ConversationService } from "@/lib/agent/conversation-service";
import { emptyConversationTurn } from "@/lib/agent/conversation-types";
import { createConversationReviewService } from "@/lib/agent/conversation-review";
import type { ChatMessage, LlmProvider } from "@/lib/llm/types";

/**
 * Phase 6 — lecture d'une conversation.
 *
 * Ce que ces tests protègent :
 *  - le verdict des affirmations est **recalculé à la lecture** (une source supprimée
 *    depuis fait passer l'affirmation en non sourcée, sans effacer la copie au moment T) ;
 *  - le catalogue **n'est pas** renvoyé (il est dans la ligne, il sert à vérifier) ;
 *  - la liste porte l'état d'attente, le dernier message et l'ancre — sans lire le détail ;
 *  - l'ancre d'une synthèse disparue est `null`, mais la conversation reste lisible.
 */

const V = (x: number, y: number): number[] => [x, y, 0, 0, 0, 0, 0, 0];

class ScriptedLlm implements LlmProvider {
  calls = 0;
  constructor(private actions: Record<string, unknown>[]) {}
  async embed(): Promise<number[]> {
    throw new Error("pas d'embedding dans la conversation");
  }
  async chat<T extends z.ZodType>(_messages: ChatMessage[], schema: T): Promise<z.infer<T>> {
    const action =
      this.actions[Math.min(this.calls, this.actions.length - 1)] ?? {
        action: "search",
        query: "mesure",
      };
    this.calls += 1;
    return schema.parse(action);
  }
}

/** Corpus + synthèse ancrable + une conversation avec un tour rendu. */
async function setup() {
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
    evidence_fragment_ids: [fA, fB],
    provenance_snapshot: [fA, fB].map((id) => {
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

  const conversations = createConversationsRepo(db);
  conversations.create({
    id: "conv-1",
    anchorKind: "synthesis",
    anchorRef: created.id,
    title: "Quel est le lien ?",
    chatModel: "test-model",
    promptVersion: "conversation-v1",
  });
  const user = conversations.addUserMessage({
    id: "msg-user-1",
    conversationId: "conv-1",
    text: "Quel est le lien ?",
  });

  // deux étapes : le tour doit avoir lu avant de répondre (règle du 2026-09-19)
  const llm = new ScriptedLlm([
    { action: "search", query: "doute" },
    { action: "answer", claims: [{ text: "Le doute énonce la règle.", citations: [0] }] },
  ]);
  const service = new ConversationService({
    db,
    conversations,
    syntheses: createSynthesesRepo(db),
    canvasLinks: createConversationCanvasRepo(db),
    fragments,
    sources,
    chat: llm,
    chatModel: "test-model",
  });
  await service.run("conv-1", {
    messageId: "msg-assistant-1",
    questionMessageId: user.id,
    question: "Quel est le lien ?",
  });

  return { db, conversations, synthesisId: created.id, fA, fB, user };
}

describe("lecture d'une conversation", () => {
  it("renvoie null pour une conversation inconnue", () => {
    const { db } = makeTestDb();
    expect(createConversationReviewService(db).read("conv-inconnue")).toBeNull();
  });

  it("rend les messages dans l'ordre, une question et une réponse, avec le tour de l'agent", async () => {
    const { db } = await setup();
    const view = createConversationReviewService(db).read("conv-1");
    expect(view).not.toBeNull();
    const [user, assistant] = view?.messages ?? [];
    expect(user.role).toBe("user");
    expect(user.claims).toEqual([]);
    expect(user.run).toBeNull();
    expect(assistant.role).toBe("assistant");
    expect(assistant.status).toBe("done");
    expect(assistant.text).toBe("Le doute énonce la règle.");
    expect(assistant.claims).toHaveLength(1);
    expect(assistant.claims[0].sourced).toBe(true);
    const provenance = assistant.claims[0].provenance[0];
    expect(provenance.verified).toBe(true);
    // la famille est celle du corpus : c'est un repli explicite, pas un `any`
    if (provenance.kind !== "fragment") throw new Error("provenance corpus attendue");
    expect(provenance.source_title).toBe("Descartes");
    // le tour porte ce qui s'affiche : les étapes, les compteurs — pas le catalogue
    expect(assistant.run?.steps.map((s) => s.action)).toEqual(["search", "answer"]);
    // la réponse est rendue : rien n'attend plus
    expect(view?.awaiting_reply).toBe(false);
    expect(assistant.run?.step_budget).toBe(5);
    expect(assistant.run?.anchor_missing).toBe(false);
    expect(assistant.run).not.toHaveProperty("catalogue");
    expect(view?.anchor).toEqual({
      kind: "synthesis",
      ref: expect.any(String),
      label: expect.stringContaining("doute cartésien"),
    });
  });

  it("`awaiting_reply` est vrai dès la question posée, et faux dès qu'elle a une réponse terminale", async () => {
    const { db, conversations } = await setup();
    const service = createConversationReviewService(db);
    expect(service.read("conv-1")?.awaiting_reply).toBe(false);

    // c'est la fenêtre de file : le worker n'a pas encore ouvert son tour
    conversations.addUserMessage({ id: "msg-user-2", conversationId: "conv-1", text: "Et ensuite ?" });
    expect(service.read("conv-1")?.awaiting_reply).toBe(true);
    expect(service.list()[0].pending).toBe(true);

    // une réponse terminale (done ou failed) rend la main : on peut réessayer
    conversations.upsertAssistantMessage({
      id: "msg-assistant-2",
      conversationId: "conv-1",
      status: "failed",
      text: "",
      claims: [],
      turn: {
        ...emptyConversationTurn(),
        prompt_version: "conversation-v2",
        chat_model: "test-model",
        step_budget: 5,
        llm_calls: 5,
        history_messages: 2,
        failure: "step_budget_exhausted",
      },
    });
    expect(service.read("conv-1")?.awaiting_reply).toBe(false);
    expect(service.list()[0].pending).toBe(false);
  });

  it("recalcule le verdict à la lecture : une source supprimée rend l'affirmation non sourcée", async () => {
    const { db, fA } = await setup();
    const service = createConversationReviewService(db);

    const before = service.read("conv-1");
    expect(before?.messages[1].unsourced).toBe(0);
    expect(before?.messages[1].unverified).toBe(0);

    const sourceId = (
      db.prepare("SELECT source_id FROM fragments WHERE id = ?").get(fA) as { source_id: string }
    ).source_id;
    createSourcesRepo(db).deleteById(sourceId);

    const after = service.read("conv-1");
    expect(after?.messages[1].claims[0].text).toBe("Le doute énonce la règle.");
    expect(after?.messages[1].claims[0].sourced).toBe(false);
    expect(after?.messages[1].unsourced).toBe(1);
    expect(after?.messages[1].unverified).toBe(1);
    const broken = after?.messages[1].claims[0].provenance[0];
    if (broken?.kind !== "fragment") throw new Error("provenance corpus attendue");
    expect(broken.problem).toBe("fragment_absent");
    // la copie au moment T reste lisible : c'est tout l'intérêt de l'avoir faite
    expect(broken.text).toContain("doute methodique");
  });

  it("l'ancre d'une synthèse supprimée est nulle, la conversation reste lisible", async () => {
    const { db, synthesisId } = await setup();
    db.prepare("DELETE FROM themes WHERE id = 'theme-1'").run(); // CASCADE sur la synthèse
    expect(createSynthesesRepo(db).getById(synthesisId)).toBeNull();

    const view = createConversationReviewService(db).read("conv-1");
    expect(view).not.toBeNull();
    expect(view?.anchor).toEqual({ kind: "synthesis", ref: synthesisId, label: null });
    expect(view?.messages).toHaveLength(2);
  });
});

describe("liste des conversations", () => {
  it("porte le nombre de messages, le dernier message, l'état d'attente et l'ancre", async () => {
    const { db, conversations, synthesisId } = await setup();
    const service = createConversationReviewService(db);

    const [summary] = service.list();
    expect(summary.id).toBe("conv-1");
    expect(summary.title).toBe("Quel est le lien ?");
    expect(summary.anchor_kind).toBe("synthesis");
    expect(summary.anchor_ref).toBe(synthesisId);
    expect(summary.messages).toBe(2);
    expect(summary.last?.role).toBe("assistant");
    expect(summary.pending).toBe(false);

    // un tour en attente se voit à la dernière ligne **pending** (le worker a ouvert le tour)
    conversations.upsertAssistantMessage({
      id: "msg-assistant-2",
      conversationId: "conv-1",
      status: "pending",
      text: "",
      claims: [],
      turn: {
        ...emptyConversationTurn(),
        prompt_version: "conversation-v1",
        chat_model: "test-model",
        step_budget: 5,
        history_messages: 2,
        catalogue: [],
        steps: [],
        claims: [],
        unsourced: 0,
      },
    });
    const [after] = service.list();
    expect(after.pending).toBe(true);
    expect(after.messages).toBe(3);
  });

  it("rend la plus récemment active d'abord, et respecte la limite", async () => {
    const { db, conversations } = await setup();
    conversations.create({
      id: "conv-2",
      anchorKind: "corpus",
      anchorRef: null,
      title: "Question sur le corpus",
      chatModel: "test-model",
      promptVersion: "conversation-v1",
    });
    // `conv-2` vient d'être créée puis touchée : elle passe devant
    conversations.addUserMessage({ id: "msg-user-2", conversationId: "conv-2", text: "Et ici ?" });

    const service = createConversationReviewService(db);
    expect(service.list().map((c) => c.id)).toEqual(["conv-2", "conv-1"]);
    expect(service.list(1).map((c) => c.id)).toEqual(["conv-2"]);
    expect(service.list(1)[0].messages).toBe(1);
  });
});
