#!/usr/bin/env node
/**
 * Vérification navigateur — le **panneau d'inspection** de l'écran Tableaux.
 *   node scripts/browser-check-inspector.mjs [base-url]
 *
 * Ce check existe parce que `tsc`, `eslint` et `vitest` **ne voient rien** de
 * tout cela : au moment où le panneau d'inspection a été livré, les trois
 * contrôles passes, et c'est en pilotant Chrome qu'on a trouvé un mismatch
 * d'hydratation dans la console, un calage qui éclaircissait l'écran en thème
 * sombre au lieu de l'assombrir, et une légende qui annonçait un aperçu à droite
 * supprimé deux commits plus tôt. Un clic n'est pas une assertion TypeScript.
 *
 * **Lecture seule** : le script n'écrit rien (ni création, ni déplacement, ni
 * dépôt). Il peut donc tourner sur la vraie base, contrairement à
 * `browser-check-explorer.mjs` qui exige `data/eval/v16-check.db`
 * (`node scripts/make-v16-fixture.mjs`).
 *
 * Ce qu'il prouve :
 *  - au repos, l'écran Tableaux n'a **qu'une seule colonne** (c'était le grief :
 *    deux barres verticales) et aucun panneau ;
 *  - le détail s'ouvre au clic sur un objet, sur une frame, et via « Détails » ;
 *  - il se ferme par le ✕, par Échap et par le clic sur le calage ;
 *  - les gestes de l'ancien aperçu sont bien là : « Discuter de ça », « Liens IA »,
 *    Investiguer/Synthétiser, Plein écran ;
 *  - **non-régression** : « Déplacer vers… » ouvre sa modale sans ouvrir le
 *    panneau — les deux partagent `sel`, et c'est l'état `inspect` qui les
 *    distingue (voir le commentaire dans explorer-screen.tsx).
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const SHOT_DIR = "data/eval/screenshots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const BASE = process.argv[2] ?? "http://localhost:3000";
const CHROME =
  process.env.CHECK_CHROME ??
  "C:/Users/timot/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe";

/** Le panneau : l'aperçu d'avant, mais coulissant et fermé au repos. */
const PANEL = '[role="dialog"][aria-label="Détail"]';
/** La carte d'un tableau : plus de `title`, on cible sa classe de carte cliquable. */
const CARD = "div.cursor-pointer";

const results = [];
const check = (name, ok, detail = "") =>
  results.push({ name, ok, detail: String(detail).slice(0, 220) });

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
const failedRequests = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) =>
  failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`)
);

/** Les intertitres du panneau sont en `uppercase` (CSS) : la recherche ignore la casse. */
const has = (text, needle) => text.toLowerCase().includes(needle.toLowerCase());
const isOpen = async () => (await page.locator(PANEL).count()) > 0;
const shot = async (name) => {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
};

try {
  await page.goto(`${BASE}/explorer`, { waitUntil: "networkidle" });
  /* La grille est un composant client : on attend les cartes, pas un délai fixe. */
  await page.waitForSelector(`${CARD} p.font-medium`, { timeout: 30_000 });
  await page.waitForTimeout(500);

  /* 1 — au repos : UNE seule colonne, aucun panneau, sidebar présente */
  check(
    "pas de colonne d'aperçu permanente",
    (await page.locator("aside.w-\\[360px\\]").count()) === 0
  );
  check("la sidebar globale est là", (await page.locator("aside").count()) >= 1);
  check("aucun panneau au repos", (await isOpen()) === false);
  await shot("inspector-01-repos");

  /* 2 — ouvrir un tableau qui a des objets (l'atelier du jeu réel) */
  await page.locator(`${CARD} p.font-medium`).filter({ hasText: /^Atelier/ }).first().click();
  await page.waitForTimeout(1200);
  const nodeCount = await page.locator("button.bg-card").count();
  check("le plan est rendu", nodeCount > 0, `${nodeCount} objets cliquables`);
  check("ouvrir un tableau n'ouvre pas le panneau", (await isOpen()) === false);

  /* 3 — « Détails » : la fiche du tableau (frames + conversations ancrées) */
  await page.getByRole("button", { name: "Détails" }).click();
  await page.locator(PANEL).waitFor({ timeout: 10_000 });
  check("« Détails » ouvre le panneau", await isOpen());
  const fiche = await page.locator(PANEL).innerText();
  check("la fiche liste ses frames", has(fiche, "Frames"), fiche.slice(0, 60));
  check("et ses conversations ancrées", has(fiche, "Conversations ancrées"));
  check("« Discuter de ça » est de retour", has(fiche, "Discuter de ça"));
  await shot("inspector-02-details");
  await page.locator(PANEL).getByRole("button", { name: "Fermer", exact: true }).click();
  await page.locator(PANEL).waitFor({ state: "detached", timeout: 10_000 });
  check("le ✕ referme le panneau", (await isOpen()) === false);

  /* 4 — une frame (chip ▦) : son détail et ses objets */
  const chip = page.locator("button", { hasText: "▦" }).first();
  if (await chip.count()) {
    await chip.click();
    await page.locator(PANEL).waitFor({ timeout: 10_000 });
    check("le clic sur une frame ouvre le panneau", await isOpen());
    const frame = await page.locator(PANEL).innerText();
    check("le panneau décrit la frame", has(frame, "Frame du tableau"), frame.slice(0, 60));
    check("et propose ses objets", has(frame, "Objets de la frame"));
    await shot("inspector-03-frame");
    await page.keyboard.press("Escape");
    await page.locator(PANEL).waitFor({ state: "detached", timeout: 10_000 });
    check("Échap referme le panneau", (await isOpen()) === false);
  } else {
    check("un chip de frame existe (scénario sauté)", false);
  }

  /* 5 — un objet du plan : Liens IA et les gestes */
  await page.locator("button.bg-card").first().click();
  await page.locator(PANEL).waitFor({ timeout: 10_000 });
  check("le clic sur un objet ouvre le panneau", await isOpen());
  const objet = await page.locator(PANEL).innerText();
  check("le panneau montre « Liens IA »", has(objet, "Liens IA"), objet.slice(0, 60));
  check("« Discuter de ça » est là", has(objet, "Discuter de ça"));
  check(
    "un geste vers les écrans experts ou le plein écran existe",
    /Investiguer|Synthétiser|Plein écran/.test(objet)
  );
  await shot("inspector-04-objet");

  /* 6 — le calage referme, et le fond ne reçoit pas le clic */
  await page.locator('button[aria-label="Fermer le détail"]').click({ position: { x: 200, y: 500 } });
  await page.locator(PANEL).waitFor({ state: "detached", timeout: 10_000 });
  check("le clic sur le calage referme le panneau", (await isOpen()) === false);

  /* 7 — non-régression : « Déplacer vers… » ne doit PAS ouvrir le panneau.
     `sel.kind === "canvas"` désigne cette modale : ouvrir le panneau sur `sel`
     ferait s'ouvrir les deux, et fermer l'un fermerait l'autre. */
  await page.getByRole("button", { name: "Tableaux" }).click();
  await page.waitForSelector(`${CARD} p.font-medium`, { timeout: 30_000 });
  /* Les boutons icônes n'apparaissent qu'au survol du groupe. */
  await page.locator(CARD).first().hover();
  await page.waitForTimeout(300);
  await page.getByTitle("Déplacer vers…").first().click({ timeout: 15_000 });
  await page.waitForTimeout(700);
  check(
    "« Déplacer vers… » ouvre sa modale",
    (await page.getByText(/Déplacer « .* » vers/).count()) > 0
  );
  check("et n'ouvre PAS le panneau d'inspection", (await isOpen()) === false);
  await shot("inspector-05-deplacer");
} catch (e) {
  check("ERREUR de parcours", false, e.message);
} finally {
  await browser.close();
}

let failed = 0;
/* Les préfetch Next (`?_rsc=`) abandonnés par une navigation sont bénins
   (constat PROGRESS.md : une requête en vol est tuée par la navigation suivante). */
const realFailures = failedRequests.filter((r) => !r.includes("_rsc="));
check("0 erreur console", consoleErrors.length === 0, consoleErrors.join(" | "));
check("0 requête en échec", realFailures.length === 0, realFailures.join(" | "));
/* Pas de double comptage : la boucle ci-dessous recompte chaque check en échec. */
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);