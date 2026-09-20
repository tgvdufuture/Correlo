import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { getConfig } from "@/lib/config/env";
import { createWorkspace } from "@/lib/agent/workspace";
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
 *
 * Le lecteur du **workspace** est construit ici, depuis le réglage, et passé à la lecture :
 * une citation de fichier est revérifiée par le **même** confinement que pendant le tour
 * (AC3), et un `WORKSPACE_ROOT` retiré depuis fait tomber la citation en `racine_absente` au
 * lieu de la laisser passer pour une preuve.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const view = createConversationReviewService(getDb(), {
    workspace: createWorkspace(getConfig().WORKSPACE_ROOT),
  }).read(id);
  if (!view) return NextResponse.json({ code: "not_found" }, { status: 404 });
  return NextResponse.json(view);
}
