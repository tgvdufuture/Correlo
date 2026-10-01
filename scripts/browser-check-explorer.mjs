#!/usr/bin/env node
/**
 * Vérification navigateur v1.6 étape 2 — l'écran explorateur, **révisé après la
 * refonte UX** (sidebar permanente + panneau d'inspection coulissant).
 *   node scripts/browser-check-explorer.mjs [base-url]
 *
 * À lancer contre un serveur sur une **copie jetable** de la base (le script ne
 * tranche rien de persistant, mais l'écran écrit : PATCH étiquette, épingler…).
 * Détections par **rôle / texte réel** — aucun id inventé côté test.
 *
 * ── Ce qui a été corrigé, et par quoi c'était périmé ──────────────────────────
 * Trois sélecteurs dataient déjà de la v1.6.1/v1.6.2 (`dfb7138`) et ne
 * correspondaient plus au composant :
 *   - la carte n'a plus de `title="Cliquer : ouvrir le tableau"` ;
 *   - le bouton d'ouverture est « Nouveau canvas » (plus « Nouveau tableau ») ;
 *   - le bouton de validation est « Créer le canvas » (plus « Créer »).
 * Trois autres dataient de la refonte UX : la nav est une sidebar à icônes (plus
 * d'emoji 🗂), la grille n'a plus de `<h1>Tableaux</h1>` (la sidebar porte ce nom)
 * et l'aperçu n'est plus une colonne permanente mais un **panneau coulissant**.
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

/** La colonne d'aperçu permanente a disparu : le détail est un panneau, fermé au repos. */
const PANEL = '[role="dialog"][aria-label="Détail"]';
/** La carte d'un tableau : plus de `title`, on cible sa classe de carte cliquable. */
const CARD = "div.cursor-pointer";

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

  /* 1 — la coquille : la sidebar navigation, et UNE SEULE colonne de contenu.
     Le second volet qui appelait « aperçu » est devenu un panneau : au repos il
     ne doit rien occuper, sinon c'est la double barre qu'on voulait supprimer. */
  await page.getByRole("link", { name: "Tableaux" }).waitFor({ timeout: 10_000 });
  check("sidebar : le lien « Tableaux » est présent et actif", true);
  await page.getByText(/\d+ tableau\(x\)/).waitFor({ timeout: 10_000 });
  check("grille : les comptes de tableaux sont rendus", true);
  check(
    "aucun panneau d'inspection au repos (pas de colonne permanente)",
    (await page.locator(PANEL).count()) === 0
  );

  /* 2 — la grille montre les 2 tableaux de la fixture */
  const atelier = page.locator(CARD, { hasText: "Atelier" });
  check("dossier « Atelier » dans la grille", (await atelier.count()) === 1);
  const veille = page.locator(CARD, { hasText: "Veille vérification" });
  check("dossier « Veille vérification » dans la grille", (await veille.count()) === 1);
  await page.screenshot({ path: `${SHOT_DIR}/v16-grille.png` });

  /* 3 — un clic sur le dossier Atelier ouvre le canvas (géométrie maquette) */
  await atelier.click();
  await page.getByRole("heading", { name: /Atelier/ }).waitFor({ timeout: 8_000 });
  check("clic dossier → canvas ouvert (titre atelier)", true);
  check(
    "ouvrir un tableau n'ouvre pas le panneau tout seul",
    (await page.locator(PANEL).count()) === 0
  );
  /* …et le bouton « Détails » donne accès à sa fiche (l'aperçu ne s'ouvre plus
     de lui-même, il fallait donc un geste explicite). */
  await page.getByRole("button", { name: "Détails" }).click();
  await page.locator(PANEL).waitFor({ timeout: 8_000 });
  check("« Détails » ouvre le panneau sur la fiche du tableau", true);
  check(
    "le panneau montre le détail du tableau",
    (await page.getByText(/Tableau.*non supprimable/).count()) >= 1
  );
  await page.screenshot({ path: `${SHOT_DIR}/v16-panneau-details.png` });
  await page.keyboard.press("Escape");
  await page.locator(PANEL).waitFor({ state: "detached", timeout: 8_000 });
  check("Échap referme le panneau", true);

  /* 4 — la vignette (AC2) : les objets positionnés réels, cliquables */
  const node = page.getByText(/bombe nucléaire/i).first();
  await node.waitFor({ timeout: 8_000 });
  check("vignette : la construction positionnée est rendue", true);
  await node.click();
  await page.getByText(/Construction · tableau/).waitFor({ timeout: 8_000 });
  check("clic node → le panneau montre l'objet", true);
  check("le panneau porte le statut épistémique", (await page.getByText(/Statut : inference|hypothèse|hypothese|spéculation|inference/i).count()) >= 1);
  await page.screenshot({ path: `${SHOT_DIR}/v16-node-selectionne.png` });
  // On referme le panneau avant l'étape suivante : tant qu'il est ouvert, son
  // calage couvre la vignette et absorbe le clic sur la frame (comportement
  // voulu — un panneau modal ne laisse pas cliquer derrière lui).
  await page.keyboard.press("Escape");
  await page.locator(PANEL).waitFor({ state: "detached", timeout: 8_000 });
  check("le clic sur un objet refermable le panneau (Échap)", true);

  /* 5 — la frame cliquable DANS LA VIGNETTE (maquette : « frames cliquables ») :
     les nodes posés dessus interceptent le centre, on clique un bord libre. */
  const frameBox = await page.locator('button[title*="Zone de vérification"]').boundingBox();
  await page.mouse.click(frameBox.x + 14, frameBox.y + 14);
  await page.locator(PANEL).waitFor({ timeout: 8_000 });
  await page.getByText("Objets de la frame").waitFor({ timeout: 8_000 });
  check("clic frame (vignette) → panneau « Objets de la frame »", true);

  /* 6 — retour à la grille : le bouton « Tableaux » (fil d'Ariane, icône ArrowLeft).
     Le panneau de l'étape 5 est encore ouvert : il faut le refermer, sinon son
     calage absorbe le clic sur le bouton de retour. */
  await page.keyboard.press("Escape");
  await page.locator(PANEL).waitFor({ state: "detached", timeout: 8_000 });
  await page.getByRole("button", { name: "Tableaux" }).click();
  await page.getByText(/\d+ tableau\(x\)/).waitFor({ timeout: 8_000 });
  check("bouton « Tableaux » → retour à la grille", true);

  /* 7 — création d'un tableau (modale) puis suppression avec dialogue natif.
     v1.6.2 : on crée un **canvas** (« Nouveau canvas »), et le bouton de la
     modale est « Créer le canvas ». */
  await page.getByRole("button", { name: "Nouveau canvas" }).first().click();
  await page.getByLabel("Nom").fill("Tableau de check");
  await page.getByRole("button", { name: "Créer le canvas" }).click();
  // la création réussit → l'écran ouvre le canvas (h1 = son nom), snapshot rechargé
  await page.getByRole("heading", { name: "Tableau de check" }).waitFor({ timeout: 8_000 });
  check("création → canvas ouvert (h1 = nouveau tableau)", true);
  // retour à la grille : la carte est là (le snapshot a bien été rechargé)
  await page.getByRole("button", { name: "Tableaux" }).click();
  const card = page.locator(CARD, { hasText: "Tableau de check" });
  await card.waitFor({ timeout: 8_000 });
  check("snapshot rechargé → la carte est dans la grille", (await card.count()) === 1);
  page.once("dialog", (d) => d.accept());
  await card.hover();
  await card.locator('button[title="Supprimer"]').click();
  await page.getByText(/supprimé/).waitFor({ timeout: 8_000 });
  const gone = await page.locator(CARD, { hasText: "Tableau de check" }).count();
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
// Pas de double comptage ici : la boucle ci-dessous recompte chaque check en
// échec (cf. le même défaut, corrigé dans browser-check-explorer-nested.mjs).
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);