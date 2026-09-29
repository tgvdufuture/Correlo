import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { createConversationCanvasRepo } from "@/lib/repositories/conversation-canvases";

/**
 * Le multi-ancrage (v1.6 §14.3, AC4) — les liaisons conversation ↔ tableaux.
 *
 * `GET ?conversationId=` : les tableaux d'une conversation (les pastilles de
 * l'écran). `POST` : l'état final des cases cochées (`setLinks` — l'écran envoie
 * l'ensemble, le serveur calcule le diff ; rejouer la même requête est sans
 * effet). `DELETE ?conversationId=&canvasId=` : une seule liaison.
 *
 * Une conversation inconnue est une **404**, pas une écriture silencieuse : lier
 * quelque chose qui n'existe pas créerait un état que l'écran croit vrai.
 */

const setSchema = z.object({
  conversationId: z.string().min(1),
  canvasIds: z.array(z.string()),
});

export async function GET(req: NextRequest) {
  const conversationId = new URL(req.url).searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId_requis" }, { status: 400 });
  }
  const exists = getDb().prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId);
  if (!exists) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ canvasIds: createConversationCanvasRepo(getDb()).listForConversation(conversationId) });
}

export async function POST(req: NextRequest) {
  const parsed = setSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.issues }, { status: 400 });
  }
  const { conversationId, canvasIds } = parsed.data;
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const result = createConversationCanvasRepo(db).setLinks(conversationId, canvasIds);
    return NextResponse.json(result);
  } catch (e) {
    // tableau inconnu dans la liste : le dépôt refuse par nom
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const conversationId = params.get("conversationId");
  const canvasId = params.get("canvasId");
  if (!conversationId || !canvasId) {
    return NextResponse.json({ error: "conversationId_et_canvasId_requis" }, { status: 400 });
  }
  const removed = createConversationCanvasRepo(getDb()).unlink(conversationId, canvasId);
  return NextResponse.json({ removed });
}
