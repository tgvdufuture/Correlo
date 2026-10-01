import type { Metadata } from "next";
import Script from "next/script";
import { AppSidebar } from "@/components/app-sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sérendipité",
  description: "Moteur de connexions personnel, local-first",
};

/**
 * La coquille de l'application (révision du 2026-10-01) : une **sidebar globale
 * permanente** à gauche — la nav n'est plus une barre horizontale qu'on lit, c'est
 * une colonne qu'on habite. La page « Tableaux » cesse d'être un vestibule qu'on
 * visite : le premier lien de la sidebar y mène comme au bureau de l'app, et son
 * contenu (dossiers, vignettes, aperçu) s'affiche à droite de la colonne.
 *
 * Le plein écran d'un tableau (`/canvas/<id>`) reste focalisé : il vit à droite de
 * la même sidebar — partir d'un écran vers un autre ne coûte jamais un détour par
 * l'accueil, ce que la nav horizontale imposait.
 */
/**
 * Le thème avant le premier rendu : sombre par défaut, sauf préférence persistée.
 * Sans ce script, la première peinture serait claire puis basculerait — le flash
 * qui fait « site » au lieu d'« app ».
 *
 * Il passe par `<Script strategy="beforeInteractive">` et non par un `<script>`
 * écrit à la main dans `<head>` : Next l'injecte lui-même en tête du document
 * HTML servi (donc exécuté avant la première peinture) et s'assure qu'il ne
 * rejoue pas à chaque navigation — ce qui est exactement le contrat voulu. Un
 * script inline dans un composant React n'est exécuté qu'au premier chargement
 *SSR et déclenche en plus un avertissement React.
 */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem("theme");var d=t?t==="dark":true;document.documentElement.classList.toggle("dark",d);}catch(e){document.documentElement.classList.add("dark");}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="h-full overflow-hidden bg-background text-foreground">
        <Script id="theme-boot" strategy="beforeInteractive">
          {THEME_BOOT}
        </Script>
        <div className="flex h-full">
          <AppSidebar />
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</div>
        </div>
      </body>
    </html>
  );
}
