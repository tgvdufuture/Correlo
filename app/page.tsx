import { ExplorerScreen } from "@/components/explorer/explorer-screen";

/**
 * L'explorateur de tableaux est l'**accueil** (v1.6 §14.2 : « l'explorateur
 * devient / ») — on ouvre l'app sur ses tableaux, pas sur un plan particulier.
 * L'atelier vit à `/canvas/<id>` (et `/canvas` y redirige) ; la géométrie 3 volets
 * (nav, tableaux, aperçu) est portée par le composant, qui remplit la hauteur
 * restante sous la barre de navigation.
 */
export default function HomePage() {
  return <ExplorerScreen />;
}
