import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { createCanvasesRepo } from "@/lib/repositories/canvases";

/**
 * Le canvas n'est plus **le** plan mais **un** tableau (v1.6 §14.2) : cette route
 * menait à l'atelier, elle mène désormais au premier tableau de la collection —
 * l'atelier (`is_default = 1`), pour que les liens et signets existants restent
 * justes et mènent au même plan qu'avant.
 */
export default function CanvasPage() {
  redirect(`/canvas/${createCanvasesRepo(getDb()).getAtelier().id}`);
}
