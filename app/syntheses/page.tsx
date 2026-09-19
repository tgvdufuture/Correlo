import { SynthesisFeed } from "@/components/synthesis-feed";

/**
 * Feed des synthèses (Phase 5B, amendement v1.3 §3) — l'écran qui rend le moteur de
 * la 5A actionnable : lire, vérifier les preuves, trancher.
 */
export default function SynthesesPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Synthèses</h1>
        <p className="text-sm text-muted-foreground">
          Énoncés issus de plusieurs documents, appuyés sur des preuves citées — chaque
          citation est revérifiée contre le corpus à chaque lecture, et la provenance
          copiée au moment de la création reste consultable même si une source disparaît.
          Acceptez ce que vous retenez, rejetez le reste : une synthèse tranchée ne
          revient pas, ni reformulée.
        </p>
      </header>
      <SynthesisFeed />
    </main>
  );
}
