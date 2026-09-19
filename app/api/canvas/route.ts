import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createCanvasRepo } from "@/lib/repositories/canvas";
import { createReviewService } from "@/lib/discover/review-service";
import { getEmbeddingSpace } from "@/lib/llm/active-space";
import { listCorpusSpaces, sameSpace, type EmbeddingSpace } from "@/lib/llm/embedding-space";
import type { EmbeddingSpaceState } from "@/lib/api-types";

/**
 * GET /api/canvas — l'état de l'atelier : les conteneurs, les **éléments** (les
 * fichiers déposés et les Constructions, avec leur provenance et leur `stale`) et
 * les **liens** que l'IA propose entre les fichiers.
 *
 * Un fichier sans disposition, ou une Construction sans disposition, est placé
 * avant lecture (`placeMissing`) : le canvas ne peut rien cacher. Les liens sont
 * les suggestions ouvertes (exposées au passage — les afficher, c'est les avoir
 * montrées) plus celles déjà intégrées, restreintes aux fichiers présents.
 *
 * `discovery` dit si l'IA travaille (jobs `discover` en attente ou en cours) : c'est
 * ce qui permet à l'écran de relire tout seul et de montrer que l'analyse avance,
 * au lieu d'exiger un rechargement manuel.
 *
 * `embeddingSpace` dit si le corpus est **dans un seul espace vectoriel** : après une
 * bascule de connecteur d'embeddings, les fragments d'un autre espace ne peuvent être
 * comparés à rien — l'écran le montre au lieu de laisser croire que toute la
 * bibliothèque participe à l'analyse.
 */
export async function GET() {
  const db = getDb();
  const state = createCanvasRepo(db).getState();
  const sourceRefs = state.items.filter((i) => i.kind === "source").map((i) => i.ref);
  const links = createReviewService(db).linksFor(sourceRefs);
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM jobs
       WHERE kind = 'discover' AND status IN ('pending', 'running')
       GROUP BY status`
    )
    .all() as { status: "pending" | "running"; n: number }[];
  const discovery = {
    pending: rows.find((r) => r.status === "pending")?.n ?? 0,
    running: rows.find((r) => r.status === "running")?.n ?? 0,
  };
  return NextResponse.json({ ...state, links, discovery, embeddingSpace: embeddingSpaceState() });
}

/**
 * Réglage actif confronté à ce que porte la base.
 *
 * Une configuration invalide (clé manquante sur `EMBED_PROVIDER=api`) ne doit **pas**
 * emporter l'écran : les fichiers du canvas restent consultables, et le bandeau dit ce
 * qui est cassé. Un 500 ici afficherait « Canvas indisponible », ce qui désignerait le
 * mauvais coupable.
 */
function embeddingSpaceState(): EmbeddingSpaceState {
  let active: EmbeddingSpace;
  try {
    active = getEmbeddingSpace();
  } catch (e) {
    return {
      active: { model: "?", dimensions: 0, version: "?" },
      corpus: [],
      outOfSpace: 0,
      outOfSpaceSources: 0,
      aligned: false,
      error: (e as Error).message,
    };
  }
  const corpus = listCorpusSpaces(getDb());
  const foreign = corpus.filter((s) => !sameSpace(s, active));
  return {
    active,
    corpus,
    outOfSpace: foreign.reduce((n, s) => n + s.fragments, 0),
    outOfSpaceSources: foreign.reduce((n, s) => n + s.sources, 0),
    aligned: foreign.length === 0,
  };
}
