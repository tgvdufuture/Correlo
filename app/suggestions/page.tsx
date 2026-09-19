import { SuggestionFeed } from "@/components/suggestion-feed";

/** Feed des connexions découvertes (Phase 3, US-05) : lecture, acceptation, rejet. */
export default function SuggestionsPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Connexions</h1>
        <p className="text-sm text-muted-foreground">
          Relations non évidentes entre fragments de sources différentes. Chaque suggestion
          porte son statut épistémique (survolez-le pour sa définition) et ses preuves
          citables — intégrez-la à votre canvas ou rejetez-la avec une raison.
        </p>
      </header>
      <SuggestionFeed />
    </main>
  );
}
