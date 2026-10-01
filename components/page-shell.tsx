import type { LucideIcon } from "lucide-react";

/**
 * Le gabarit commun des pages « liste » (Bibliothèque, Connexions, Synthèses,
 * Conversation) — la contrepartie de la sidebar globale : sans lui, chaque page
 * réinventait son en-tête (titre, sous-titre, largeur, padding), et l'app
 * ressemblait à quatre sites cousus ensemble.
 *
 * Le gabarit ne porte **que** la coquille : titre, description, actions à droite
 * de l'en-tête, et une largeur de lecture. Le contenu reste la propriété de la
 * page — le gabarit ne décide rien de ce qui s'affiche dessous.
 */
export function PageShell({
  icon: Icon,
  title,
  subtitle,
  actions,
  children,
  wide = false,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /** Les boutons d'en-tête (import, nouvelle conversation…) — la page garde ses gestes. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** `true` pour les pages qui ont besoin de la largeur (tableaux de sources). */
  wide?: boolean;
}) {
  return (
    <main
      className={`w-full flex-1 px-8 py-8 ${
        wide ? "max-w-[1400px]" : "max-w-5xl"
      } mx-auto`}
    >
      <header className="mb-8 flex items-start gap-4">
        <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
          <Icon className="size-5 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? (
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </main>
  );
}
