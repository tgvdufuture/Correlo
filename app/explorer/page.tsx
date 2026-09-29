import { ExplorerScreen } from "@/components/explorer/explorer-screen";

/**
 * L'explorateur de tableaux (v1.6 §14, étape 2) — la page qui monte l'écran.
 *
 * Pas de `<main>` à padding : la géométrie de la maquette (nav à gauche, tableaux
 * au centre, aperçu à droite) est portée par le composant lui-même, qui remplit
 * la hauteur restante sous la barre de navigation (flex-1 min-h-0).
 */
export default function ExplorerPage() {
  return <ExplorerScreen />;
}
