import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createJobsRepo } from "@/lib/repositories/jobs";
import { createConversationsRepo, turnInFlight } from "@/lib/repositories/conversations";
import { conversationTurnJobKey, conversationTurnJobPayload } from "@/lib/agent/queue";
import {
  MAX_QUESTION_CHARS,
  MIN_QUESTION_CHARS,
} from "@/lib/agent/conversation-types";

/**
 * POST /api/conversations/:id/messages — pose une question dans une conversation
 * (Phase 6, amendement v1.3 §13).
 *
 * **202 Accepted** : un tour coûte jusqu'à 5 appels LLM, il est mené par le worker. La
 * réponse dit que la question est prise en compte, pas qu'elle est résolue ; l'écran suit
 * `GET /api/conversations/:id` (la dernière ligne est la question tant que le worker n'a pas
 * ouvert le tour — `awaiting_reply` — puis la réponse en `pending`, comme le panneau
 * d'investigation de la Phase 4).
 *
 * **409 `turn_in_progress`** tant qu'une question n'a pas de réponse terminale, et ce n'est
 * pas une politesse : le tour déjà en file a un **historique figé** (délimité par son
 * message déclencheur), donc répondre à une seconde question avant la première laisserait
 * l'agent sans la réponse qu'il vient de produire — et deux tours écriraient en parallèle
 * dans la même conversation. On refuse plutôt que de rendre l'ordre affiché arbitraire.
 *
 * Le test de cette garde est `turnInFlight` (dépôt), partagé avec la lecture : la version
 * initiale ne regardait que `status === 'pending'` et laissait passer la **fenêtre de file**
 * (le worker n'a pas encore écrit sa ligne), mesurée en vérification HTTP — deux tours
 * menés en parallèle sur la même conversation.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
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
  const conversations = createConversationsRepo(db);
  if (!conversations.getById(id)) {
    return NextResponse.json({ code: "not_found" }, { status: 404 });
  }
  const [last] = conversations.listMessages(id, { limit: 1 });
  if (turnInFlight(last)) {
    return NextResponse.json(
      { code: "turn_in_progress", message: "la réponse précédente est encore en cours" },
      { status: 409 }
    );
  }

  const userMessage = conversations.addUserMessage({ conversationId: id, text: question });
  const job = createJobsRepo(db).createJob({
    kind: "conversation",
    payload: conversationTurnJobPayload({
      conversationId: id,
      questionMessageId: userMessage.id,
      question,
    }),
    sourceId: null,
    idempotencyKey: conversationTurnJobKey(id, userMessage.id),
  });

  return NextResponse.json(
    { conversation_id: id, question_message_id: userMessage.id, job_id: job.id, status: "pending" },
    { status: 202 }
  );
}
