#!/usr/bin/env node
/**
 * Vérification navigateur v1.6.2 — les dossiers (conteneurs purs) et les canvas
 * côte à côte.
 *   node scripts/browser-check-explorer-nested.mjs [base-url]
 *
 * À lancer contre un serveur sur une **copie jetable** de la base. Le script
 * crée son propre arbre, le vérifie, puis le supprime : il est idempotent et
 * ne laisse rien dans la base copiée.
 *
 * Ce que le check prouve (et que build + tests ne voient pas) :
 *  - deux créations côte à côte (« Nouveau canvas » / « Nouveau dossier ») ;
 *  - ouvrir un dossier montre le contenu MÉLANGÉ (canvas + sous-dossiers) ;
 *  - un dossier à enfants s'ouvre comme un dossier, un canvas ouvre son plan ;
 *  - « Déplacer vers… » ne propose QUE des dossiers (un canvas n'est pas un
 *    conteneur) ;
 *  - supprimer un dossier remonte canvas ET sous-dossiers mêlés.
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

/** Une carte de la grille, par sa nature visible dans le titre du clic. */
const card = (label) =>
  page.locator('div[title^="Cliquer :"]', { hasText: label }).first();

const backToRoot = async () => {
  // après une création, on peut être en vue PLAN (h1 = le canvas créé, bouton
  // « Tableaux ») ou en vue DOSSIER (bouton « Racine ») : les deux chemins
  // mènent à la grille racine
  const planBack = page.getByRole("button", { name: "Tableaux" });
  if (await planBack.count()) {
    await planBack.click();
  } else {
    await page.getByRole("button", { name: "Racine" }).click();
  }
  await page.getByRole("heading", { name: "Tableaux" }).waitFor({ timeout: 8_000 });
};

/** Créer depuis le niveau courant : un canvas ou un dossier (les deux tuiles).
 *  Après création, l'écran entre dans le dossier créé (ou ouvre le canvas) : ce
 *  que le h1 dit ensuite dépend de la nature — un dossier se vérifie par le fil
 *  d'Ariane, pas par un h1 de plan. */
const createFromLevel = async (label, which) => {
  await page
    .getByRole("button", { name: which === "folder" ? "Nouveau dossier" : "Nouveau canvas" })
    .first()
    .click();
  await page.getByLabel("Nom").fill(label);
  await page.getByRole("button", { name: /Créer le / }).click();
  await page.waitForTimeout(400);
  if (which === "folder") {
    // entré dedans : le fil d'Ariane le dit (Racine / …) et le chemin affiché
    // porte le nom du dossier (le h1 de la grille reste « Tableaux »)
    await page.getByRole("button", { name: "Racine" }).waitFor({ timeout: 8_000 });
    await page.locator("button", { hasText: label }).first().waitFor({ timeout: 8_000 });
  } else {
    await page.getByRole("heading", { name: label }).waitFor({ timeout: 8_000 });
  }
};

const deleteCanvas = async (label) => {
  await card(label).hover();
  page.once("dialog", (d) => d.accept());
  await card(label).locator('button[title="Supprimer"]').click();
  await page.getByText(/supprimé/).waitFor({ timeout: 8_000 });
  // la notice s'affiche **avant** que le snapshot rechargé ait re-rendu la
  // grille : la carte peut rester visible une frame de plus — on attend qu'elle
  // parte vraiment (sinon le compte du nettoyage lit un DOM périmé)
  await page.locator('div[title^="Cliquer :"]', { hasText: label }).waitFor({ state: "detached", timeout: 8_000 }).catch(() => {});
};

try {
  await page.goto(`${BASE}/explorer`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Tableaux" }).waitFor({ timeout: 10_000 });
  check("l'explorateur se charge", true);

  /* 1 — les DEUX tuiles de création existent à la racine (v1.6.2) */
  check("tuile « Nouveau canvas »", (await page.getByRole("button", { name: "Nouveau canvas" }).count()) >= 1);
  check("tuile « Nouveau dossier »", (await page.getByRole("button", { name: "Nouveau dossier" }).count()) >= 1);

  /* 2 — créer un dossier à la racine, puis un canvas DANS ce dossier */
  await createFromLevel("Dossier de check", "folder");
  // après création, on est DANS le dossier (fil d'Ariane, grille vide) — la
  // carte du dossier n'existe plus (on ne se voit pas soi-même) : le canvas se
  // crée via la tuile du niveau visité, parent implicite = le dossier courant
  await page.getByRole("button", { name: "Nouveau canvas" }).first().click();
  await page.getByLabel("Nom").fill("Canvas dans le dossier");
  await page.getByRole("button", { name: /Créer le / }).click();
  await page.getByRole("heading", { name: "Canvas dans le dossier" }).waitFor({ timeout: 8_000 });
  check("canvas créé dans le dossier ouvert → plan ouvert", true);
  // « Dossier » (le bouton de retour, renommé quand on visite un dossier) rend
  // le niveau du dossier — jamais un saut brutal à la racine
  await page.getByRole("button", { name: "Dossier", exact: true }).click();
  await page.getByRole("button", { name: "Racine" }).waitFor({ timeout: 8_000 });
  await card("Canvas dans le dossier").waitFor({ timeout: 8_000 });
  check("« Dossier » rend le niveau visité (le canvas y est)", true);
  await backToRoot();
  // on est revenu à la racine : le canvas imbriqué n'y est PAS
  check("le canvas imbriqué n'est pas à la racine", (await card("Canvas dans le dossier").count()) === 0);

  /* 3 — ajouter un sous-dossier DANS le dossier, puis contenu MÉLANGÉ */
  // on est à la racine : entrer dans le dossier par un clic de carte
  await card("Dossier de check").click();
  await page.getByRole("button", { name: "Racine" }).waitFor({ timeout: 8_000 });
  // la tuile du niveau pose le sous-dossier DANS le dossier visité (parent implicite)
  await page.getByRole("button", { name: "Nouveau dossier" }).first().click();
  await page.getByLabel("Nom").fill("Sous-dossier B");
  await page.getByRole("button", { name: /Créer le / }).click();
  await page.waitForTimeout(400);
  // la création d'un dossier entre dedans (grille vide, fil d'Ariane « Racine /
  // Dossier de check / Sous-dossier B ») : remonter au parent via le fil d'Ariane
  await page.locator("button", { hasText: "Dossier de check" }).first().click();
  await page.getByRole("button", { name: "Racine" }).waitFor({ timeout: 8_000 });
  // …et le niveau du dossier montre le MÉLANGE : canvas + sous-dossier
  await card("Canvas dans le dossier").waitFor({ timeout: 8_000 });
  await card("Sous-dossier B").waitFor({ timeout: 8_000 });
  check("ouvrir le dossier : canvas et sous-dossier côte à côte", true);
  await page.screenshot({ path: `${SHOT_DIR}/v162-contenu-mixte.png` });

  /* 4 — « Déplacer vers… » d'un canvas ne propose QUE des dossiers */
  await card("Canvas dans le dossier").hover();
  await card("Canvas dans le dossier").locator('button[title="Déplacer vers…"]').click();
  await page.getByText(/Déplacer « Canvas dans le dossier » vers…/).waitFor({ timeout: 8_000 });
  const modal = page.locator("div.fixed", { hasText: "Déplacer « Canvas dans le dossier » vers…" });
  // les canvas de la base (Perso, l'atelier) ne doivent PAS être des cibles
  const targetTexts = await modal.locator("button").allInnerTexts();
  check("cibles = dossiers + « À la racine » uniquement", !targetTexts.some((t) => t.includes("Perso")), targetTexts.join(" | ").slice(0, 120));
  await modal.locator("button", { hasText: "À la racine" }).click();
  await page.getByText("Tableau remis à la racine.").waitFor({ timeout: 8_000 });
  check("déplacement du canvas vers la racine", true);
  await backToRoot();
  await card("Canvas dans le dossier").waitFor({ timeout: 8_000 });
  check("le canvas déplacé est à la racine", true);

  /* 5 — supprimer le dossier : sous-dossier ET canvas remontent (mêlés) */
  // on ré-imbrique d'abord le canvas dans le dossier (via la modale, cible dossier)
  await card("Canvas dans le dossier").hover();
  await card("Canvas dans le dossier").locator('button[title="Déplacer vers…"]').click();
  const modal2 = page.locator("div.fixed", { hasText: "Déplacer « Canvas dans le dossier » vers…" });
  await modal2.locator("button", { hasText: "Dossier de check" }).click();
  await page.getByText("Tableau déplacé.").waitFor({ timeout: 8_000 });
  // on est déjà à la racine (le canvas y était, on l'a déplacé par la modale) :
  // la grille racine est là, pas besoin de backToRoot
  await card("Dossier de check").hover();
  page.once("dialog", (d) => d.accept());
  await card("Dossier de check").locator('button[title="Supprimer"]').click();
  await page.getByText(/remonté/).waitFor({ timeout: 8_000 });
  // le re-render du snapshot peut prendre une frame : on attend les cartes
  await card("Canvas dans le dossier").waitFor({ timeout: 8_000 });
  check("suppression du dossier → canvas remonté", (await card("Canvas dans le dossier").count()) === 1);
  await card("Sous-dossier B").waitFor({ timeout: 8_000 });
  check("suppression du dossier → sous-dossier remonté", (await card("Sous-dossier B").count()) === 1);
  await page.screenshot({ path: `${SHOT_DIR}/v162-remontee.png` });

  /* 6 — un canvas (pas un dossier) ouvre le PLAN (pas la navigation) */
  await card("Canvas dans le dossier").click();
  await page.getByRole("heading", { name: "Canvas dans le dossier" }).waitFor({ timeout: 8_000 });
  check("clic canvas → plan ouvert (pas la grille)", true);
  // le bouton de retour : « Dossier » si le canvas vit dans un dossier (browseIn
  // est resté sur le niveau), sinon « Tableaux » — les deux rendent la grille
  const backBtn = (await page.getByRole("button", { name: "Dossier", exact: true }).count())
    ? page.getByRole("button", { name: "Dossier", exact: true })
    : page.getByRole("button", { name: "Tableaux" });
  await backBtn.click();
  await page.getByRole("heading", { name: "Tableaux" }).waitFor({ timeout: 8_000 });
  // au besoin, remonter à la racine pour le nettoyage (le fil d'Ariane peut avoir
  // disparu si le niveau visité a été supprimé — alors on est déjà à la racine)
  if (await page.getByRole("button", { name: "Racine" }).count()) await backToRoot();

  /* 7 — nettoyage */
  // ⚠ `hasText` matche les sous-chaînes : « Dossier de check » matche la carte
  // « Dossier de check » mais aussi toute carte contenant ce texte. Le compte
  // doit se faire **après** un re-render complet du snapshot.
  await page.waitForTimeout(300);
  await deleteCanvas("Canvas dans le dossier");
  await deleteCanvas("Sous-dossier B");
  const residue =
    (await card("Canvas dans le dossier").count()) +
    (await card("Sous-dossier B").count()) +
    (await card("Dossier de check").count());
  check("nettoyage : l'arbre du check est parti", residue === 0, `${residue} carte(s)`);
} catch (e) {
  check("ERREUR de parcours", false, e.message);
  await page.screenshot({ path: `${SHOT_DIR}/v162-echec.png` });
} finally {
  await browser.close();
}

let failed = 0;
check("0 erreur console", consoleErrors.length === 0, consoleErrors.join(" | "));
// les préfetch Next (`?_rsc=`) abandonnés par une navigation sont bénins
// (constat PROGRESS.md : une requête en vol est tuée par la navigation suivante)
const realFailures = failedRequests.filter((r) => !r.includes("_rsc="));
check("0 requête en échec", realFailures.length === 0, realFailures.join(" | "));
if (consoleErrors.length || realFailures.length) failed++;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);
