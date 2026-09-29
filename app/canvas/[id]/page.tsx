import { notFound } from "next/navigation";
import { CanvasWorkspace } from "@/components/canvas/canvas-workspace";
import { getDb } from "@/lib/db/client";
import { createCanvasesRepo } from "@/lib/repositories/canvases";

/**
 * L'atelier **focalisé** sur un tableau (v1.6 §14.2, AC2) — le plein écran que
 * l'explorateur ouvre depuis une carte ou une vignette.
 *
 * La page est un serveur : elle vérifie que le tableau existe (un lien périmé —
 * un tableau supprimé — est un 404 rendu, pas un écran cassé), puis délègue au
 * composant, qui charge l'état et applique le focus (`?frame=<id>` : centre +
 * zoom sur la frame, la suite des gestes reste libre).
 *
 * Le dépôt de fichiers et la création de frames fonctionnent ici comme dans
 * l'atelier : les écritures sont scopées sur **ce** tableau (`?canvas=` aux
 * routes), jamais sur l'atelier.
 */
export default async function FocusedCanvasPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ frame?: string }>;
}) {
  const { id } = await params;
  const { frame } = await searchParams;
  const canvas = createCanvasesRepo(getDb()).getById(id);
  if (!canvas) notFound();
  return (
    <main className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col px-6 py-4">
      <CanvasWorkspace canvasId={id} focusFrameId={frame} />
    </main>
  );
}
