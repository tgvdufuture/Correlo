import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createJobsRepo } from "@/lib/repositories/jobs";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";
import { conversationTitle, createConversationsRepo } from "@/lib/repositories/conversations";
import { createConversationReviewService } from "@/lib/agent/conversation-review";
import { conversationTurnJobKey, conversationTurnJobPayload } from "@/lib/agent/queue";
import { CONVERSATION_PROMPT_VERSION } from "@/lib/agent/conversation-prompts";
import {
  MAX_QUESTION_CHARS,
  MIN_QUESTION_CHARS,
} from "@/lib/agent/conversation-types";
import { getChatModelName } from "@/lib/llm/llm";

/**
 * GET /api/conversations?limit= — les conversations, la plus récemment active d'abord
 * (Phase 6, amendement v1.3 §13).
 *
 * La lecture est faite par `createConversationReviewService` (aucun appel LLM) : le feed
 * porte le nombre de messages, le dernier message et l'état d'attente, sans lire le détail.
 */
export async function GET(req: NextRequest) {
  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return NextResponse.json(
      { code: "invalid_limit", message: "limit doit être un entier entre 1 et 200" },
      { status: 400 }
    );
  }
  const service = createConversationReviewService(getDb());
  return NextResponse.json(service.list(limit));
}

/**
 * POST /api/conversations — ouvre une conversation **et pose sa première question**.
 *
 * La conversation n'est pas créée à vide : `conversations.title` est le premier message
 * tronqué (§13.6), donc il n'existe pas de conversation sans question. C'est aussi ce qui
 * évite un état intermédiaire que l'écran devrait gérer (« conversation ouverte, aucun
 * message »).
 *
 * **201** et non 202 : la conversation existe immédiatement et est adressable (son `id`
 * est renvoyé), c'est la **réponse** qui est en attente — le tour part en file et l'écran
 * suit `GET /api/conversations/:id`.
 *
 * **404 `anchor_not_found`** quand la synthèse ancrée n'existe pas : on n'enfile pas un
 * tour qui ne saurait pas d'où il part (même règle que l'enquête d'une suggestion
 * disparue, qui répond 404 avant d'enfiler).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    question?: unknown;
    anchor?: unknown;
  } | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ code: "invalid_body" }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length < MIN_QUESTION_CHARS || question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      {
        code: "invalid_question",
        message: `question requise (${MIN_QUESTION_CHARS} à ${MAX_QUESTION_CHARS} caractères)`,
      },
      { status: 400 }
    );
  }

  const db = getDb();
  let anchorKind: "synthesis" | "corpus" = "corpus";
  let anchorRef: string | null = null;
  if (body.anchor !== undefined) {
    const anchor = body.anchor as { kind?: unknown; ref?: unknown };
    if (!anchor || typeof anchor !== "object" || (anchor.kind !== "synthesis" && anchor.kind !== "corpus")) {
      return NextResponse.json(
        { code: "invalid_anchor", message: 'anchor.kind ∈ {"synthesis", "corpus"}' },
        { status: 400 }
      );
    }
    if (anchor.kind === "synthesis") {
      if (typeof anchor.ref !== "string" || anchor.ref.length === 0) {
        return NextResponse.json(
          { code: "invalid_anchor", message: "anchor.ref requis pour kind=synthesis" },
          { status: 400 }
        );
      }
      if (!createSynthesesRepo(db).getById(anchor.ref)) {
        return NextResponse.json({ code: "anchor_not_found" }, { status: 404 });
      }
      anchorKind = "synthesis";
      anchorRef = anchor.ref;
    }
  }

  const conversations = createConversationsRepo(db);
  const conversation = conversations.create({
    anchorKind,
    anchorRef,
    title: conversationTitle(question),
    chatModel: getChatModelName(),
    promptVersion: CONVERSATION_PROMPT_VERSION,
  });
  const userMessage = conversations.addUserMessage({
    conversationId: conversation.id,
    text: question,
  });
  const job = createJobsRepo(db).createJob({
    kind: "conversation",
    payload: conversationTurnJobPayload({
      conversationId: conversation.id,
      questionMessageId: userMessage.id,
      question,
    }),
    sourceId: null,
    idempotencyKey: conversationTurnJobKey(conversation.id, userMessage.id),
  });

  return NextResponse.json(
    {
      conversation_id: conversation.id,
      question_message_id: userMessage.id,
      job_id: job.id,
      status: "pending",
    },
    { status: 201 }
  );
}
