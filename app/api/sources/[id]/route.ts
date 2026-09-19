import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR, getDb } from "@/lib/db/client";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createFragmentsRepo } from "@/lib/repositories/fragments";
import { createCanvasRepo } from "@/lib/repositories/canvas";
import { markSourceDependentsStale } from "@/lib/repositories/stale";

/**
 * GET /api/sources/:id — détail + compte de fragments + statuts. 404 si absent.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  const sources = createSourcesRepo(db);
  const fragments = createFragmentsRepo(db);
  const source = sources.getById(id);
  if (!source) return NextResponse.json({ code: "not_found" }, { status: 404 });
  const listItem = sources.list().find((s) => s.id === id) ?? null;
  return NextResponse.json({
    ...source,
    fragment_count: fragments.countBySource(id),
    ingest_status: listItem?.ingest_status ?? "pending",
    ingest_error: listItem?.ingest_error ?? null,
    summary_error: listItem?.summary_error ?? null,
  });
}

/**
 * DELETE /api/sources/:id — 204 ; CASCADE fragments/suggestions ;
 * Constructions **et synthèses** → stale=1 (provenance_snapshot intact, US-08 AC1-AC2,
 * Phase 5B AC4) ; le fichier quitte le canvas (l'élément est polymorphe : aucune clé
 * étrangère ne le fait à notre place) ; fichier d'origine supprimé.
 *
 * Les deux marquages passent par `markSourceDependentsStale` : le dépôt des synthèses
 * avait un `markStaleBySource` que cet écran **n'appelait pas** (constaté le
 * 2026-09-18), donc supprimer une source laissait ses synthèses fraîches.
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  const sources = createSourcesRepo(db);
  const source = sources.getById(id);
  if (!source) return NextResponse.json({ code: "not_found" }, { status: 404 });

  db.transaction(() => {
    // stale = 1 dès que des fragments d'origine disparaissent (US-08 AC2) ; le
    // snapshot n'est pas touché : il reste lisible après le CASCADE (AC1)
    markSourceDependentsStale(db, id);
    sources.deleteById(id);
    // les liens de cette source disparaissent avec ses fragments (CASCADE) ; son
    // élément de canvas doit partir explicitement (clé polymorphe, pas de FK)
    createCanvasRepo(db).removeItems("source", [id]);
  })();

  fs.rmSync(path.join(DATA_DIR, `${id}.pdf`), { force: true });
  fs.rmSync(path.join(DATA_DIR, `${id}.txt`), { force: true });
  return new NextResponse(null, { status: 204 });
}