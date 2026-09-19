import { redirect } from "next/navigation";

/**
 * Le canvas est devenu la page principale (`/`) : cette route ne survit que pour
 * les liens et signets existants.
 */
export default function CanvasPage() {
  redirect("/");
}
