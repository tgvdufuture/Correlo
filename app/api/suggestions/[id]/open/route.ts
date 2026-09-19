import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createReviewService } from "@/lib/discover/review-service";

/**
 * POST /api/suggestions/:id/open — l'utilisateur a ouvert le détail : la
 * suggestion passe à `opened` (`discovered|shown` → `opened`). C'est la
 * transition que mesure la métrique « ≥ 40 % de suggestions ouvertes » ; elle
 * n'est jamais rétrogradée (ré-ouvrir une suggestion acceptée ne la change pas).
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = createReviewService(getDb()).open(id);
  if (!result.ok) return NextResponse.json({ code: result.reason }, { status: 404 });
  return NextResponse.json({ state: "opened" });
}
