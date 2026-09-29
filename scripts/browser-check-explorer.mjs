#!/usr/bin/env node
/**
 * Vérification navigateur v1.6 étape 2 — l'écran explorateur.
 *   node scripts/browser-check-explorer.mjs [base-url]
 *
 * À lancer contre un serveur sur une **copie jetable** de la base (le script ne
 * tranche rien de persistant, mais l'écran écrit : PATCH étiquette, épingler…).
 * Détections par **rôle / texte réel** — aucun id inventé côté test.
 *
 * La base attendue est enrichie par le même geste que les autres checks
 * (copie `VACUUM INTO` + fixtures minimales) : voir data/eval/v16-check.db.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const SHOT_DIR = "data/eval/screenshots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const BASE = process.argv[2] ?? "http://localhost:3224";
const CHROME = "C:/Users/timot/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe";

const results = [];
const check = (name, ok, detail = "") =>
  results.push({ name, ok, detail: String(detail).slice(0, 200) });

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage();
const consoleErrors = [];
const failedRequests = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("requestfailed", (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));

try {
  await page.goto(`${BASE}/explorer`, { waitUntil: "networkidle" });

  /* 1 — les 3 volets (colonne 1 nav, colonne 2 dossiers, colonne 3 aperçu) */
  await page.getByText("🗂 Tableaux").waitFor({ timeout: 10_000 });
  check("volet nav : « 🗂 Tableaux » actif", true);
  await page.getByRole("heading", { name: "Tableaux" }).waitFor({ timeout: 10_000 });
  check("volet centre : le titre « Tableaux » (grille)", true);
  await page.getByText("Rien de sélectionné").waitFor({ timeout: 10_000 });
  check("volet aperçu : « Rien de sélectionné »", true);

  /* 2 — la grille montre les 2 tableaux de la fixture */
  const atelier = page.locator("div[title='Cliquer : ouvrir le tableau']", { hasText: "Atelier" });
  check("dossier « Atelier » dans la grille", (await atelier.count()) === 1);
  const veille = page.locator("div[title='Cliquer : ouvrir le tableau']", { hasText: "Veille vérification" });
  check("dossier « Veille vérification » dans la grille", (await veille.count()) === 1);
  await page.screenshot({ path: `${SHOT_DIR}/v16-grille.png` });

  /* 3 — un clic sur le dossier Atelier ouvre le canvas (géométrie maquette) */
  await atelier.click();
  await page.getByRole("heading", { name: /Atelier/ }).waitFor({ timeout: 8_000 });
  check("clic dossier → canvas ouvert (titre atelier)", true);
  check("l'aperçu montre le détail du tableau", (await page.getByText(/Tableau.*non supprimable/).count()) >= 1);
  await page.screenshot({ path: `${SHOT_DIR}/v16-canvas-atelier.png` });

  /* 4 — la vignette (AC2) : les objets positionnés réels, cliquables */
  const node = page.getByText(/bombe nucléaire/i).first();
  await node.waitFor({ timeout: 8_000 });
  check("vignette : la construction positionnée est rendue", true);
  await node.click();
  await page.getByText(/Construction · tableau/).waitFor({ timeout: 8_000 });
  check("clic node → l'aperçu montre l'objet", true);
  check("l'aperçu porte le statut épistémique", (await page.getByText(/Statut : inference|hypothèse|hypothese|spéculation|spéculation|inference/i).count()) >= 1);
  await page.screenshot({ path: `${SHOT_DIR}/v16-node-selectionne.png` });

  /* 5 — la frame cliquable DANS LA VIGNETTE (maquette : « frames cliquables ») :
     les nodes posés dessus interceptent le centre, on clique un bord libre. */
  const frameBox = await page.locator('button[title*="Zone de vérification"]').boundingBox();
  await page.mouse.click(frameBox.x + 14, frameBox.y + 14);
  await page.getByText("Objets de la frame").waitFor({ timeout: 8_000 });
  check("clic frame (vignette) → aperçu « Objets de la frame »", true);

  /* 6 — retour à la grille : le bouton « Tableaux » (fil d'Ariane, icône ArrowLeft) */
  await page.getByRole("button", { name: "Tableaux" }).click();
  await page.getByRole("heading", { name: "Tableaux" }).waitFor({ timeout: 8_000 });
  check("bouton « Tableaux » → retour à la grille", true);

  /* 7 — création d'un tableau (modale) puis suppression avec dialogue natif */
  await page.getByRole("button", { name: /Nouveau tableau/ }).first().click();
  await page.getByLabel("Nom").fill("Tableau de check");
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  // la création réussit → l'écran ouvre le canvas (h1 = son nom), snapshot rechargé
  await page.getByRole("heading", { name: "Tableau de check" }).waitFor({ timeout: 8_000 });
  check("création → canvas ouvert (h1 = nouveau tableau)", true);
  // retour à la grille : la carte est là (le snapshot a bien été rechargé)
  await page.getByRole("button", { name: "Tableaux" }).click();
  const card = page.locator("div[title='Cliquer : ouvrir le tableau']", { hasText: "Tableau de check" });
  await card.waitFor({ timeout: 8_000 });
  check("snapshot rechargé → la carte est dans la grille", (await card.count()) === 1);
  page.once("dialog", (d) => d.accept());
  await card.hover();
  await card.locator('button[title="Supprimer"]').click();
  await page.getByText(/supprimé/).waitFor({ timeout: 8_000 });
  const gone = await page.locator("div[title='Cliquer : ouvrir le tableau']", { hasText: "Tableau de check" }).count();
  check("suppression → notice + carte sortie", gone === 0, `${gone} carte(s) restante(s)`);
  await page.screenshot({ path: `${SHOT_DIR}/v16-apres-suppression.png` });
} catch (e) {
  check("ERREUR de parcours", false, e.message);
} finally {
  await browser.close();
}

let failed = 0;
check("0 erreur console", consoleErrors.length === 0, consoleErrors.join(" | "));
check("0 requête en échec", failedRequests.length === 0, failedRequests.join(" | "));
if (consoleErrors.length || failedRequests.length) failed++;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);
