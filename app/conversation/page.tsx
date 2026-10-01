import { MessageSquare } from "lucide-react";
import { PageShell } from "@/components/page-shell";
import { ConversationView } from "@/components/conversation-view";
import { getDb } from "@/lib/db/client";
import { createSynthesesRepo } from "@/lib/repositories/syntheses";

/**
 * Nouvelle conversation (Phase 6, amendement v1.3 §13) — et liste des précédentes.
 *
 * L'ancre est un **paramètre d'URL**, pas un état de client : `?anchor=synthesis&ref=<id>`
 * (le bouton « Discuter » d'une carte de synthèse, AC4) ; sans paramètre, la question
 * porte sur le corpus entier. Un écran qui porterait l'ancre dans son état la perdrait au
 * rechargement, et une conversation dont on ne sait plus d'où elle part n'est pas
 * relisable.
 *
 * L'énoncé de la synthèse est lu **ici, côté serveur** : le bandeau s'affiche avant la
 * première question, sans requête client supplémentaire — et s'il n'existait pas, le
 * `POST` répondrait 404, ce que l'écran dit.
 */
export default async function NewConversationPage({
  searchParams,
}: {
  searchParams: Promise<{ anchor?: string; ref?: string }>;
}) {
  const params = await searchParams;
  const ref = params.anchor === "synthesis" ? (params.ref ?? null) : null;
  const synthesis = ref ? createSynthesesRepo(getDb()).getById(ref) : null;
  const initialAnchor =
    ref === null
      ? ({ kind: "corpus", ref: null, label: null } as const)
      : ({
          kind: "synthesis",
          ref,
          label: synthesis
            ? synthesis.text.length > 160
              ? `${synthesis.text.slice(0, 159)}…`
              : synthesis.text
            : null,
        } as const);

  return (
    <PageShell
      icon={MessageSquare}
      title="Conversation"
      subtitle="Une question, et un agent qui lit le corpus avant de répondre : sa prose est assemblée par le serveur, avec les sources regroupées sous la réponse — revérifiées à chaque lecture."
    >
      <ConversationView conversationId={null} initialAnchor={initialAnchor} />
    </PageShell>
  );
}
