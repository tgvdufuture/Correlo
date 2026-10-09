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
  page.locator('div.cursor-pointer', { hasText: label }).first();

const backToRoot = async () => {
  // le chemin de la grille porte TOUJOURS « Tableaux » : c'est lui qui remonte à
  // la racine, quel que soit le niveau visité (v1.6.4)
  await page.getByRole("button", { name: "Tableaux" }).first().click();
  await page.getByText(/\d+ tableau\(x\)/).waitFor({ timeout: 8_000 });
};

/** Le niveau affiché, tel que le chemin le nomme (`aria-current="page"`). */
const currentLevel = (label) => page.locator('[aria-current="page"]', { hasText: label });

/** Créer depuis le niveau courant : un canvas ou un dossier (les deux boutons du
 *  bandeau). v1.6.4 : un dossier créé fait **entrer dedans** (le chemin le
 *  nomme), un canvas créé **reste dans le niveau** (sa carte y est visible) —
 *  plus de saut dans le plan vide d'un canvas qui n'a rien. */
const createFromLevel = async (label, which) => {
  await page
    .getByRole("button", { name: which === "folder" ? "Nouveau dossier" : "Nouveau canvas" })
    .first()
    .click();
  await page.getByLabel("Nom").fill(label);
  await page.getByRole("button", { name: /Créer le / }).click();
  if (which === "folder") {
    await currentLevel(label).waitFor({ timeout: 8_000 });
  } else {
    await card(label).waitFor({ timeout: 8_000 });
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
  await page.locator('div.cursor-pointer', { hasText: label }).waitFor({ state: "detached", timeout: 8_000 }).catch(() => {});
};

try {
  /* 0 — reprise des crashs précédents : le check est idempotent OU repart
     propre. Un run tué en plein parcours laisse ses cartes et ses sources —
     on les retire d'abord (enfants avant parents). */
  const preClean = async () => {
    for (const s of (await fetch(`${BASE}/api/sources`).then((r) => r.json())).filter((s) =>
      ["check-v163.txt", "drop-fond-plan.txt"].includes(s.title)
    )) {
      await fetch(`${BASE}/api/sources/${s.id}`, { method: "DELETE" });
    }
    for (const label of ["Canvas dedans", "Canvas clic droit", "Dossier dans l'atelier", "Dossier clic droit"]) {
      for (;;) {
        const snap = await fetch(`${BASE}/api/explorer`).then((r) => r.json());
        const hit = snap.canvases.find((c) => c.label === label);
        if (!hit) break;
        await fetch(`${BASE}/api/canvases?id=${encodeURIComponent(hit.id)}`, { method: "DELETE" });
      }
    }
  };
  await preClean();

  await page.goto(`${BASE}/explorer`, { waitUntil: "networkidle" });
  await page.getByText(/\d+ tableau\(x\)/).waitFor({ timeout: 10_000 });
  check("l'explorateur se charge", true);

  /* 1 — les DEUX créations existent à la racine (v1.6.2 ; v1.6.4 : un seul rang,
     dans le bandeau — les tuiles en pointillés de la grille ont disparu) */
  check("bouton « Nouveau canvas »", (await page.getByRole("button", { name: "Nouveau canvas" }).count()) >= 1);
  check("bouton « Nouveau dossier »", (await page.getByRole("button", { name: "Nouveau dossier" }).count()) >= 1);

  /* 2 — créer un dossier à la racine, puis un canvas DANS ce dossier */
  await createFromLevel("Dossier de check", "folder");
  // après création, on est DANS le dossier (le chemin le nomme, grille vide) —
  // la carte du dossier n'existe plus (on ne se voit pas soi-même) : le canvas se
  // crée via le bouton du niveau, parent implicite = le dossier courant
  await page.getByRole("button", { name: "Nouveau canvas" }).first().click();
  await page.getByText(/dans « Dossier de check »/).waitFor({ timeout: 8_000 });
  await page.getByLabel("Nom").fill("Canvas dans le dossier");
  await page.getByRole("button", { name: /Créer le / }).click();
  await card("Canvas dans le dossier").waitFor({ timeout: 8_000 });
  check("canvas créé dans le dossier → sa carte est là, on reste dans le dossier", true);
  check("la création n'a pas quitté le dossier", (await currentLevel("Dossier de check").count()) === 1);
  await backToRoot();
  // on est revenu à la racine : le canvas imbriqué n'y est PAS
  check("le canvas imbriqué n'est pas à la racine", (await card("Canvas dans le dossier").count()) === 0);

  /* 3 — ajouter un sous-dossier DANS le dossier, puis contenu MÉLANGÉ */
  // on est à la racine : entrer dans le dossier par un clic de carte
  await card("Dossier de check").click();
  await currentLevel("Dossier de check").waitFor({ timeout: 8_000 });
  // le bouton du niveau pose le sous-dossier DANS le dossier visité (parent implicite)
  await page.getByRole("button", { name: "Nouveau dossier" }).first().click();
  await page.getByLabel("Nom").fill("Sous-dossier B");
  await page.getByRole("button", { name: /Créer le / }).click();
  // la création d'un dossier entre dedans (chemin « Tableaux / Dossier de check /
  // Sous-dossier B ») : remonter au parent via le chemin
  await currentLevel("Sous-dossier B").waitFor({ timeout: 8_000 });
  await page.locator("nav[aria-label='Chemin'] button", { hasText: "Dossier de check" }).first().click();
  await currentLevel("Dossier de check").waitFor({ timeout: 8_000 });
  // …et le niveau du dossier montre le MÉLANGE : canvas + sous-dossier
  await card("Canvas dans le dossier").waitFor({ timeout: 8_000 });
  await card("Sous-dossier B").waitFor({ timeout: 8_000 });
  check("ouvrir le dossier : canvas et sous-dossier côte à côte", true);
  await page.screenshot({ path: `${SHOT_DIR}/v162-contenu-mixte.png` });

  /* 4 — « Déplacer vers… » propose TOUS les tableaux (v1.6.3 : chaque tableau
     range — les canvas aussi ; l'atelier est visible et rangé) */
  await card("Canvas dans le dossier").hover();
  await card("Canvas dans le dossier").locator('button[title="Déplacer vers…"]').click();
  await page.getByText(/Déplacer « Canvas dans le dossier » vers…/).waitFor({ timeout: 8_000 });
  const modal = page.locator("div.fixed", { hasText: "Déplacer « Canvas dans le dossier » vers…" });
  // l'atelier doit être proposé (visible !) et Perso aussi (un canvas range)
  const targetTexts = await modal.locator("button").allInnerTexts();
  check("cibles = tous les tableaux + « À la racine »", targetTexts.some((t) => t.includes("Atelier")) && targetTexts.some((t) => t.includes("Perso")), targetTexts.join(" | ").slice(0, 120));
  await modal.locator("button", { hasText: "À la racine" }).click();
  await page.getByText(/rangé dans la racine/).waitFor({ timeout: 8_000 });
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
  await page.getByText(/rangé dans « Dossier de check »/).waitFor({ timeout: 8_000 });
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
  // le bouton de retour nomme le niveau d'où l'on vient (v1.6.4 : le libellé suit
  // la nature réelle du niveau, au lieu de « Dossier » ou « Tableaux » au hasard)
  await page.getByRole("button", { name: "Tableaux" }).first().click();
  await page.getByText(/\d+ tableau\(x\)/).waitFor({ timeout: 8_000 });

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

  /* 8 — le clic droit (v1.6.3) : créer canvas et dossier où l'on clique */
  // le FOND du niveau : l'événement part de la ligne de compteurs (déterministe —
  // des coordonnées libres risquent de tomber sur une carte) et bouillonne
  // jusqu'à la section. C'est l'ancien <h1>Tableaux</h1>, supprimé comme doublon
  // de la sidebar ; le texte des compteurs est l'ancrage le plus proche du fond.
  await page.getByText(/\d+ tableau\(x\)/).dispatchEvent("contextmenu");
  await page.getByText("Créer à la racine").waitFor({ timeout: 8_000 });
  check("le menu du fond À LA RACINE le dit (plus de « Créer ici » ambigu)", true);
  await page.getByText("Nouveau canvas ici").click();
  await page.getByLabel("Nom").fill("Canvas clic droit");
  await page.getByRole("button", { name: /Créer le / }).click();
  await card("Canvas clic droit").waitFor({ timeout: 8_000 });
  check("clic droit fond → « Nouveau canvas ici » → créé à la racine, grille restée", true);

  // clic droit SUR une carte dossier : les entrées « dedans » s'y trouvent
  await page.getByRole("button", { name: "Nouveau dossier" }).first().click();
  await page.getByLabel("Nom").fill("Dossier clic droit");
  await page.getByRole("button", { name: /Créer le / }).click();
  await currentLevel("Dossier clic droit").waitFor({ timeout: 8_000 });
  await backToRoot();
  await card("Dossier clic droit").click({ button: "right" });
  await page.getByText("Nouveau canvas dedans").click();
  await page.getByLabel("Nom").fill("Canvas dedans");
  await page.getByRole("button", { name: /Créer le / }).click();
  await card("Canvas dedans").waitFor({ timeout: 8_000 });
  check("clic droit carte dossier → « Nouveau canvas dedans » → créé DEDANS", true);
  // le canvas est dans « Dossier clic droit » : on l'y retrouve depuis la racine
  check("le canvas créé par clic droit vit dans le dossier", (await card("Canvas dedans").count()) === 1);
  await backToRoot();

  /* 9 — glisser-déposer de fichiers sur une carte canvas (v1.6.3) : le dépôt
     part DIRECTEMENT vers CE canvas (plus besoin d'ouvrir le plein écran). */
  // contenu unique par run : le doublon de contenu est un 409 nommé — un run
  // crashé sans nettoyage ne doit pas faire échouer le run suivant
  const payload = Buffer.from(`# Check v163\n\nDéposé à ${new Date().toISOString()} par le check navigateur.\n`);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator('div.cursor-pointer', { hasText: "Canvas clic droit" }).first().scrollIntoViewIfNeeded();
  const file = { name: "check-v163.txt", mimeType: "text/plain", buffer: payload.toString("base64") };
  const dt = dataTransfer;
  await page.evaluate(([d, f]) => {
    const transfer = d;
    const bytes = Uint8Array.from(atob(f.buffer), (ch) => ch.charCodeAt(0));
    transfer.items.add(new File([bytes], f.name, { type: f.mimeType }));
  }, [dt, file]);
  const target = page.locator('div.cursor-pointer', { hasText: "Canvas clic droit" }).first();
  await target.dispatchEvent("dragenter", { dataTransfer: dt });
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  check("survol : l'anneau « Ranger dans » apparaît sur la carte", await page.getByText(/Ranger dans « Canvas clic droit »/).isVisible());
  await target.dispatchEvent("drop", { dataTransfer: dt });
  await page.getByText(/1 fichier\(s\) déposé\(s\) dans « Canvas clic droit »/).waitFor({ timeout: 10_000 });
  check("drop sur la carte → fichier créé DANS ce canvas (notice nommée)", true);
  await page.screenshot({ path: `${SHOT_DIR}/v163-drop-carte.png` });

  /* 10 — un dossier n'intercepte PAS le dépôt de FICHIERS : le survol retombe sur
     le fond (le dépôt irait à l'atelier) — jamais un anneau sur le dossier pour
     des fichiers (l'API les refuse : « un dossier ne reçoit pas de fichier »). */
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["x"], "survol-dossier.txt", { type: "text/plain" }));
    const cards = [...document.querySelectorAll('div.cursor-pointer')];
    const card = cards.find((el) => el.textContent.includes("Dossier clic droit"));
    card.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForTimeout(200);
  check("dragover fichiers sur une carte dossier : pas d'anneau sur la carte", (await page.getByText("Ranger dans « Dossier clic droit »").count()) === 0);
  // le fond reprend le relais : la bannière nomme le réceptacle du niveau (l'atelier ici)
  check("le fond reprend le relais (dépôt irait à l'atelier)", await page.getByText(/Lâchez pour déposer dans « Atelier »/).isVisible());

  /* 10 bis — le DROIT d'un dossier, lui, accepte un tableau : le glisser d'une
     carte sur une carte dossier le RANGE dedans. Le geste existait déjà (la carte
     était `draggable`) mais aucun drop ne consommait la donnée : le curseur de
     déplacement s'affichait et rien ne se passait. */
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("application/x-canvas-id", "inconnu-à-ce-niveau");
    transfer.setData("text/plain", "Dossier clic droit");
    const cards = [...document.querySelectorAll('div.cursor-pointer')];
    const card = cards.find((el) => el.textContent.includes("Dossier clic droit"));
    card.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForTimeout(200);
  check("dragover d'une carte sur un dossier : l'anneau « Ranger dans » apparaît", await page.getByText("Ranger dans « Dossier clic droit »").isVisible());

  /* 12 — LE scénario signalé (v1.6.3-bis) : « dans l'Atelier, le clic droit
     crée à la racine ». En vue plan de l'atelier : le menu du fond doit nommer
     l'atelier, et le dossier doit naître DEDANS. */
  // la carte ATELIER est un canvas (titre de clic « ouvrir ») : hasText « Atelier »
  // matcherait aussi un résidu « Dossier dans l'atelier » (carte dossier)
  await page.locator('div.cursor-pointer', { hasText: "Atelier" }).first().click();
  await page.getByRole("heading", { name: /Atelier/ }).waitFor({ timeout: 8_000 });
  check("clic carte Atelier → vue plan de l'atelier", true);
  await page.getByRole("heading", { name: /Atelier/ }).dispatchEvent("contextmenu");
  // le menu NE MENT PAS : il annonce le canvas ouvert
  await page.getByText("Créer dans « Atelier »").waitFor({ timeout: 8_000 });
  check("le menu du fond nomme le canvas ouvert (plus de mensonge)", true);
  await page.getByText("Nouveau dossier ici").click();
  await page.getByLabel("Nom").fill("Dossier dans l'atelier");
  await page.getByRole("button", { name: /Créer le / }).click();
  await page.waitForTimeout(400);
  // la vérité est en base, pas dans un DOM périmé : le parent du créé (snapshot /api/explorer)
  const created = (await fetch(`${BASE}/api/explorer`).then((r) => r.json())).canvases;
  check("le dossier créé par clic droit VIT dans l'atelier", created.some((c) => c.label === "Dossier dans l'atelier" && c.parent_id === "canvas-atelier"), JSON.stringify(created.find((c) => c.label === "Dossier dans l'atelier")));
  // la création d'un dossier fait ENTRER dedans (comportement standard) : le plan
  // s'est refermé — revenir à la racine puis rouvrir le plan de l'atelier
  await currentLevel("Dossier dans l'atelier").waitFor({ timeout: 8_000 });
  await backToRoot();
  await page.locator('div.cursor-pointer', { hasText: "Atelier" }).first().click();
  await page.getByRole("heading", { name: /Atelier/ }).waitFor({ timeout: 8_000 });
  check("retour sur le plan de l'atelier après création du dossier", true);
  // le dépôt de fichiers sur le fond en vue plan va AUSSI au canvas ouvert
  const dataTransferPlan = await page.evaluateHandle(() => new DataTransfer());
  const planB64 = Buffer.from(`# drop fond plan ${Date.now()}`).toString("base64");
  await page.evaluate(([d, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    d.items.add(new File([bytes], "drop-fond-plan.txt", { type: "text/plain" }));
  }, [dataTransferPlan, planB64]);
  const h1Plan = page.getByRole("heading", { name: /Atelier/ });
  await h1Plan.dispatchEvent("dragover", { dataTransfer: dataTransferPlan });
  await h1Plan.dispatchEvent("drop", { dataTransfer: dataTransferPlan });
  await page.getByText(/fichier\(s\) déposé\(s\) dans « Atelier »/).waitFor({ timeout: 10_000 });
  check("drop sur le fond du plan → fichier DANS l'atelier ouvert", true);
  // retour + nettoyage : fermer le plan (browseIn est null → « Tableaux »),
  // puis « Contenu (n) » — la nouvelle entrée v1.6.3-bis — pour voir ce que
  // l'atelier RANGE et supprimer le dossier dedans
  await page.getByRole("button", { name: "Tableaux" }).click();
  await page.getByText(/\d+ tableau\(x\)/).waitFor({ timeout: 8_000 });
  await page.locator('div.cursor-pointer', { hasText: "Atelier" }).first().click();
  await page.getByRole("heading", { name: /Atelier/ }).waitFor({ timeout: 8_000 });
  await page.getByRole("button", { name: /Contenu \(/ }).click();
  await currentLevel("Atelier").waitFor({ timeout: 8_000 });
  check("« Contenu (n) » montre ce que le canvas range", await card("Dossier dans l'atelier").count() === 1);
  await deleteCanvas("Dossier dans l'atelier");
  await backToRoot();
  const cleanPlan = async (name) => {
    const all = await fetch(`${BASE}/api/sources`).then((r) => r.json());
    for (const hit of all.filter((s) => s.title === name)) {
      await fetch(`${BASE}/api/sources/${hit.id}`, { method: "DELETE" });
    }
  };
  await cleanPlan("drop-fond-plan.txt");

  /* 13 — nettoyage du pass v1.6.3 (DELETE /api/sources/:id existe) */
  const cleanSource = async (name) => {
    const res = await fetch(`${BASE}/api/sources`);
    const all = await res.json();
    const hits = all.filter((s) => s.title === name);
    if (hits.length === 0) return false;
    for (const hit of hits) {
      const del = await fetch(`${BASE}/api/sources/${hit.id}`, { method: "DELETE" });
      if (del.status !== 200 && del.status !== 204) return false;
    }
    return true;
  };
  const cleaned1 = await cleanSource("check-v163.txt");
  check("nettoyage : la source du check est partie", cleaned1 === true);
  await deleteCanvas("Canvas clic droit"); // à la racine
  // « Canvas dedans » vit DANS « Dossier clic droit » : entrer, supprimer, sortir
  await card("Dossier clic droit").click();
  await currentLevel("Dossier clic droit").waitFor({ timeout: 8_000 });
  await deleteCanvas("Canvas dedans");
  await backToRoot();
  await deleteCanvas("Dossier clic droit");
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
// Pas de double comptage ici : la boucle ci-dessous recompte chaque check en
// échec. Incrémenter aussi `failed` selon `consoleErrors` faisait annoncer
// « 28/30 » pour **une** seule erreur — un résumé qui ment sur son propre échec.
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);
