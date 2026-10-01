import { Compass } from "lucide-react";
import { PageShell } from "@/components/page-shell";
import { SuggestionFeed } from "@/components/suggestion-feed";

/** Feed des connexions découvertes (Phase 3, US-05) : lecture, acceptation, rejet. */
export default function SuggestionsPage() {
  return (
    <PageShell
      icon={Compass}
      title="Connexions"
      subtitle="Relations non évidentes entre fragments de sources différentes. Chaque suggestion porte son statut épistémique (survolez-le pour sa définition) et ses preuves citables — intégrez-la à votre canvas ou rejetez-la avec une raison."
    >
      <SuggestionFeed />
    </PageShell>
  );
}
