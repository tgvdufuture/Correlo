import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createConversationReviewService } from "@/lib/agent/conversation-review";

/**
 * GET /api/conversations/:id — la conversation et ses messages (Phase 6).
 *
 * Chaque affirmation arrive avec ses provenances **revérifiées à cette lecture** (la règle
 * partagée des phases 4 et 5B) : une source supprimée depuis fait passer l'affirmation en
 * « non sourcée » (`sourced: false`, `problem` par provenance) au lieu de la servir comme
 * un fait. L'écran n'a donc rien à recalculer — deux lectures du même état ne peuvent pas
 * diverger.
 *
 * **404** quand la conversation n'existe pas : un écran qui afficherait une conversation
 * vide ferait croire à une conversation perdue.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const view = createConversationReviewService(getDb()).read(id);
  if (!view) return NextResponse.json({ code: "not_found" }, { status: 404 });
  return NextResponse.json(view);
}
