import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createReviewService } from "@/lib/discover/review-service";
import { FEEDBACK_REASONS } from "@/lib/repositories/suggestions";

/**
 * POST /api/suggestions/:id/reject — US-06 : le rejet exige **exactement une**
 * raison ∈ {trivial, false, already_known, off_topic} (sinon 400) ; la raison est
 * persistée et la paire (pair_key, relation_type) est bloquée pour toute variante
 * future, y compris reformulée (US-05 AC4).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "invalid_payload", message: "JSON invalide" }, { status: 400 });
  }
  const reason = (body ?? {}) as { feedback_reason?: unknown };
  const result = createReviewService(getDb()).reject(id, reason.feedback_reason);
  if (!result.ok) {
    return result.reason === "not_found"
      ? NextResponse.json({ code: result.reason }, { status: 404 })
      : NextResponse.json(
          {
            code: "invalid_feedback_reason",
            message: `feedback_reason requis, ∈ {${FEEDBACK_REASONS.join(", ")}}`,
          },
          { status: 400 }
        );
  }
  return NextResponse.json({ state: "rejected", feedback_reason: reason.feedback_reason });
}
