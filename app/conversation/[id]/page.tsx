import { MessageSquare } from "lucide-react";
import { PageShell } from "@/components/page-shell";
import { ConversationView } from "@/components/conversation-view";

/**
 * Une conversation, à son adresse (Phase 6).
 *
 * Rien n'est chargé ici côté serveur : la lecture passe par `GET /api/conversations/:id`,
 * qui **revérifie les provenances à cette lecture**. La lire deux fois (une fois au
 * prérendu, une fois au montage) donnerait deux verdicts possibles pour le même écran —
 * et c'est précisément ce que la maison refuse depuis la Phase 4.
 *
 * L'ancre passée ici n'est qu'un repli : dès que la conversation est chargée, c'est celle
 * de la base qui s'affiche (elle seule sait si la synthèse d'origine existe encore).
 */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PageShell
      icon={MessageSquare}
      title="Conversation"
      subtitle="Chaque affirmation porte ses preuves, revérifiées contre le corpus à cette lecture."
    >
      <ConversationView
        conversationId={id}
        initialAnchor={{ kind: "corpus", ref: null, label: null }}
      />
    </PageShell>
  );
}
