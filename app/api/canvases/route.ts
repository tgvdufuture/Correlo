import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import {
  CANVAS_COLORS,
  CANVAS_KINDS,
  MAX_CANVAS_LABEL,
  createCanvasesRepo,
} from "@/lib/repositories/canvases";

/**
 * Les tableaux (v1.6 §14, étape 2) — le CRUD que l'explorateur propose, ici en
 * routes : `POST` (créer), `PATCH /:id` (renommer, colorier, épingler),
 * `DELETE /:id` (détacher), `PUT /reorder` (l'ordre total).
 *
 * Les erreurs de validation sont **des** réponses (400 avec la raison), pas des
 * 500 : un label trop long est une action utilisateur, pas une panne. Les codes
 * métier du dépôt (`atelier`, `not_found`) deviennent 403/404 — l'écran peut les
 * nommer au lieu d'afficher « une erreur est survenue ».
 *
 * La palette `CANVAS_COLORS` est **importée** : l'écran et l'API ne peuvent pas
 * diverger sur ce qu'est une étiquette valide (même source unique que partout
 * ailleurs dans le projet).
 */

const colorSchema = z.union([z.enum(CANVAS_COLORS), z.null()]);

const createSchema = z.object({
  label: z.string().trim().min(1).max(MAX_CANVAS_LABEL),
  color: colorSchema.optional(),
  pinned: z.boolean().optional(),
  /** La nature (v1.6.2) : surface de travail (`canvas`) ou conteneur (`folder`). */
  kind: z.enum(CANVAS_KINDS).optional(),
  /** Créer directement sous un dossier (le « + » de l'arbre) ; absent = racine. */
  parentId: z.string().optional(),
});

const patchSchema = z.object({
  label: z.string().trim().min(1).max(MAX_CANVAS_LABEL).optional(),
  color: colorSchema.optional(),
  pinned: z.boolean().optional(),
  /** Déplacer (v1.6.1) : un id de tableau, ou null pour remonter à la racine. */
  parentId: z.union([z.string(), z.null()]).optional(),
});

const reorderSchema = z.object({ ids: z.array(z.string()) });

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.issues }, { status: 400 });
  }
  try {
    const row = createCanvasesRepo(getDb()).create(parsed.data);
    return NextResponse.json(row, { status: 201 });
  } catch (e) {
    const message = (e as Error).message;
    // les refus nommés du dépôt (parent inconnu) sont des 400 avec leur raison,
    // pas des 500 — même contrat que le reste de la route
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  const parsed = reorderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.issues }, { status: 400 });
  }
  const moved = createCanvasesRepo(getDb()).reorder(parsed.data.ids);
  return NextResponse.json({ moved });
}

export async function PATCH(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id_requis" }, { status: 400 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.issues }, { status: 400 });
  }
  const repo = createCanvasesRepo(getDb());
  // le déplacement est le seul patch qui peut refuser **nommément** (cycle,
  // atelier) : il passe par setParent, et sa raison traverse en 400/403 —
  // l'écran peut dire « ce déplacement ferait un cycle » au lieu d'un 500
  if (parsed.data.parentId !== undefined) {
    const moved = repo.setParent(id, parsed.data.parentId);
    if (!moved.ok) {
      return NextResponse.json(
        { error: moved.reason },
        { status: moved.reason === "atelier" ? 403 : moved.reason === "not_found" ? 404 : 400 }
      );
    }
    const rest = { ...parsed.data };
    delete rest.parentId;
    if (Object.keys(rest).length === 0) return NextResponse.json(moved.row);
  }
  const row = repo.update(id, parsed.data);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id_requis" }, { status: 400 });
  const result = createCanvasesRepo(getDb()).deleteById(id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason },
      { status: result.reason === "atelier" ? 403 : 404 }
    );
  }
  // le détachement est **dit** : l'écran annonce ce qui survit (sous-tableaux
  // remontés, frames dissoutes, conversations déliées) au lieu de laisser un
  // silence après un geste lourd
  return NextResponse.json(result);
}
