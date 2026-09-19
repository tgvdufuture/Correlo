import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createJobsRepo } from "@/lib/repositories/jobs";
import { createInvestigationsRepo } from "@/lib/repositories/investigations";
import { createSuggestionsRepo } from "@/lib/repositories/suggestions";
import { parseInvestigationDocument, verifyDocument } from "@/lib/agent/citations";
import { investigationJobKey } from "@/lib/agent/queue";
import { parseJobError } from "@/lib/api-types";

/**
 * GET /api/suggestions/:id/investigation — dernière enquête de cette suggestion.
 *
 * Les citations sont **revérifiées ici, à chaque lecture** (US-09 AC2) : chaque
 * entrée de catalogue est comparée au fragment vivant (existence, texte, source), et
 * une étape dont une citation ne tient plus est marquée `failed` — elle n'est donc
 * jamais affichée comme une preuve. La base n'est pas modifiée par cette lecture.
 *
 * `status` couvre aussi l'**attente** : la ligne `investigations` n'existe qu'à
 * partir du premier appel LLM, donc l'état du job (en file, en cours, échoué avec son
 * erreur structurée) est renvoyé à côté du document. C'est ce qui évite l'écran
 * « enquête en cours » éternel quand le worker a échoué avant d'écrire.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  const suggestion = createSuggestionsRepo(db).getById(id);
  if (!suggestion) return NextResponse.json({ code: "not_found" }, { status: 404 });

  const row = createInvestigationsRepo(db).latestBySuggestion(id);
  const job = createJobsRepo(db).getByIdempotencyKey(investigationJobKey(id));
  if (!row && !job) {
    return NextResponse.json({ status: "none", investigation: null, job: null });
  }
  const investigation = row ? verifyDocument(db, parseInvestigationDocument(row.steps)) : null;
  return NextResponse.json({
    // la ligne d'investigation fait foi dès qu'elle existe ; sinon l'état du job
    status: row?.status ?? job?.status ?? "none",
    investigation,
    job: job ? { id: job.id, status: job.status, error: parseJobError(job.error) } : null,
  });
}
