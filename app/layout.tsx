import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sérendipité",
  description: "Moteur de connexions personnel, local-first",
};

/**
 * Le **plan de travail** (`/`) est la page principale : on y dépose les fichiers et
 * l'IA y propose ses liens. La Bibliothèque reste la vue d'administration des sources
 * (US-04), la page Connexions le feed des paires (US-05), Synthèses celui des énoncés
 * multi-sources (Phase 5B) et Conversation la reprise d'une synthèse ou du corpus par un
 * agent (Phase 6) — les liens du plan sont les mêmes suggestions, vues à côté des
 * fichiers concernés.
 */
const NAV = [
  { href: "/", label: "Plan de travail" },
  { href: "/sources", label: "Bibliothèque" },
  { href: "/suggestions", label: "Connexions" },
  { href: "/syntheses", label: "Synthèses" },
  { href: "/conversation", label: "Conversation" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <nav className="border-b border-border" aria-label="Navigation principale">
          <ul className="mx-auto flex w-full max-w-[1800px] items-center gap-4 px-6 py-3 text-sm">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {children}
      </body>
    </html>
  );
}
