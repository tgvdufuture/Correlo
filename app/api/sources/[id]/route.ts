import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR, getDb } from "@/lib/db/client";
import { createSourcesRepo } from "@/lib/repositories/sources";
import { createFragmentsRepo } from "@/lib/repositories/fragments";

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
 * Constructions → stale=1 (provenance_snapshot intacte, US-08 AC1-AC2) ; fichier supprimé.
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  const sources = createSourcesRepo(db);
  const source = sources.getById(id);
  if (!source) return NextResponse.json({ code: "not_found" }, { status: 404 });

  db.transaction(() => {
    // stale = 1 dès que des fragments d'origine disparaissent
    db.prepare(
      `UPDATE constructions SET stale = 1
       WHERE EXISTS (
         SELECT 1 FROM json_each(constructions.provenance_snapshot) je
         WHERE json_extract(je.value, '$.source_id') = ?
       )`
    ).run(id);
    sources.deleteById(id);
  })();

  fs.rmSync(path.join(DATA_DIR, `${id}.pdf`), { force: true });
  fs.rmSync(path.join(DATA_DIR, `${id}.txt`), { force: true });
  return new NextResponse(null, { status: 204 });
}