import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createExaSearchProvider } from "@/lib/agent/web-search";
import { readWebPage } from "@/lib/agent/web-page";
import { assertPublicHttpUrl } from "@/lib/agent/web-guard";

/**
 * Vérification **réelle** du chemin web (Phase 6, §13.4) — sur demande, jamais en CI :
 *
 *     EXA_LIVE=1 npx vitest run tests/web-live.test.ts
 *
 * Ce que les tests à `fetch` injecté ne peuvent pas prouver : la clé est acceptée, le
 * contrat du connecteur correspond au vrai service, et une page réelle traverse le
 * durcissement puis Readability pour produire une copie citable. Aucune assertion sur le
 * *contenu* — une page du web change, et un test qui dépendrait de son texte serait faux le
 * lendemain.
 *
 * La clé est lue dans `.env.local` (jamais suivie par git) plutôt que passée en ligne de
 * commande : un secret sur une ligne de commande finit dans l'historique du shell, et il n'y
 * a rien à y gagner.
 */
function readEnvLocal(name: string): string | null {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && m[1] === name) return m[2].trim() || null;
    }
  }
  return null;
}

const apiKey = readEnvLocal("EXA_API_KEY");
const live = process.env.EXA_LIVE === "1" && apiKey !== null;

describe.skipIf(!live)("chemin web réel (EXA_LIVE=1)", () => {
  it("cherche pour de vrai, puis lit une page pour de vrai", async () => {
    const provider = createExaSearchProvider({ apiKey: apiKey as string, numResults: 5 });
    const started = Date.now();
    const results = await provider.search(
      "régulation européenne batteries lithium recyclage véhicules électriques"
    );
    console.log(`[live] recherche Exa : ${results.length} résultat(s) en ${Date.now() - started} ms`);
    for (const r of results) console.log(`  · ${r.title ?? "(sans titre)"} — ${r.url}${r.snippet ? ` (${r.snippet})` : ""}`);

    // le connecteur ne rend que des URL montrables : schéma, identifiants, littéraux privés
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(assertPublicHttpUrl(r.url).protocol).toMatch(/^https?:$/);

    const first = results[0];
    const readStarted = Date.now();
    const page = await readWebPage(first.url);
    console.log(
      `[live] lecture durcie de ${page.url}\n` +
        `  titre : ${page.title ?? "(sans titre)"}\n` +
        `  texte : ${page.text.length} caractères en ${Date.now() - readStarted} ms` +
        (page.redirects.length > 0 ? ` (redirections : ${page.redirects.join(" → ")})` : "") +
        `\n  extrait : ${page.text.slice(0, 240).replace(/\s+/g, " ")}…`
    );
    // ce que le tour citera : une copie non vide, prête pour la provenance datée
    expect(page.text.length).toBeGreaterThan(100);
    expect(assertPublicHttpUrl(page.url).protocol).toMatch(/^https?:$/);
  }, 60_000);
});
