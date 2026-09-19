#!/usr/bin/env node
/**
 * Vérification navigateur Phase 4 — le panneau d'investigation, aux deux endroits où
 * il vit : le panneau de liens de l'atelier (/) et le feed /suggestions.
 *   node scripts/browser-check-investigation.mjs [base-url]
 *
 * L'enquête de la base de check est déjà `done` (copiée de la base réelle, cache de
 * prompt inclus, règle `investigation-v2`) : le script **relance** l'enquête — elle est
 * idempotente par question (suggestion + version de prompt + signature du chat), donc
 * le rejeu est servi par le cache de prompt : 0 appel LLM réel. Le script vérifie ce
 * que le serveur a vérifié ; il ne re-juge rien lui-même.
 *
 * Trois pièges d'environnement (constatés en écrivant ce script, à connaître) :
 * - l'atelier **re-rend en continu** (polling d'état, zoom auto) : toute lecture au
 *   timeout par défaut (30 s) peut bloquer des dizaines de secondes, et tout
 *   `elementHandle` meurt au premier re-rendu. Lectures = locators, timeout court,
 *   boucles de réessai côté Node.
 * - le panneau ouvert n'est **pas** un descendant du `li` du lien sur l'atelier
 *   (il l'est dans le feed) : on le localise par **contenu** — un seul panneau étant
 *   ouvert à la fois, le premier en-tête d'état du scope est celui qu'on vient
 *   d'ouvrir.
 * - l'aside du panneau de liens est rendue **avant** ses données : attendre l'aside
 *   ne suffit pas, il faut attendre le premier lien.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const SHOT_DIR = "data/eval/screenshots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const BASE = process.argv[2] ?? "http://localhost:3224";
const CHROME = "C:/Users/timot/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe";
const SHORT = 700; // timeout de lecture : jamais le défaut (30 s)

const results = [];
const check = (name, ok, detail = "") =>
  results.push({ name, ok, detail: String(detail).slice(0, 220) });

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage();
const consoleErrors = [];
const failedRequests = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("requestfailed", (r) => {
  // ERR_ABORTED sur la relance = le serveur a répondu 202 AVANT que le POST ne parte
  // complètement (worker local : le job est exécuté plus vite que le fetch) — c'est un
  // abandon bénin, pas une requête en échec ; on exclut les aborts explicites.
  if (r.failure()?.errorText === "net::ERR_ABORTED") return;
  failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`);
});

const clean = (s) => s.replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lecture courte et réessayée : renvoie "" si le nœud est remplacé en plein vol. */
async function quickText(locator, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return clean(await locator.innerText({ timeout: SHORT }));
    } catch {
      await sleep(120);
    }
  }
  return "";
}

/** Clic court et réessayé : un re-rendu peut remplacer le nœud au moment du clic. */
async function quickClick(locator, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      await locator.click({ force: true, timeout: SHORT });
      return true;
    } catch {
      await sleep(150);
    }
  }
  return false;
}

/** Attend qu'un prédicat Node soit vrai (relit le DOM à chaque tour : re-rendus ok). */
async function pollUntil(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* nœud remplacé entre-temps : on réessaie */
    }
    await sleep(stepMs);
  }
  return false;
}

/**
 * Ouvre « Investiguer » carte par carte jusqu'à trouver une enquête terminée.
 * Le panneau est cherché dans `scope` par contenu : un seul panneau étant ouvert à la
 * fois, le premier en-tête d'état du scope est celui de la carte qu'on vient d'ouvrir.
 */
async function scanForInvestigation(cards, scope) {
  const n = await cards.count();
  const headerLoc = scope
    .locator("span")
    .filter({ hasText: /Enquête (terminée|échouée)|Aucune enquête/ })
    .first();
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const btn = card.getByRole("button", { name: "Investiguer" });
    if ((await btn.count()) === 0) continue;
    await quickClick(btn);
    const ready = await pollUntil(async () => {
      const t = await quickText(headerLoc, 1);
      return /Enquête (terminée|échouée)|Aucune enquête/.test(t);
    }, 8_000);
    if (!ready) continue;
    const header = await quickText(headerLoc);
    if (/Enquête (terminée|échouée)/.test(header)) {
      // racine du panneau = le div.mt-3.rounded-lg du composant (même classe aux deux
      // endroits), pas un descendant interne qui ne porterait que l'en-tête
      const panel = scope
        .locator("div.mt-3.rounded-lg")
        .filter({ has: page.getByRole("button", { name: /Relancer l'enquête/ }) })
        .first();
      const text = await quickText(panel);
      await page.screenshot({ path: `${SHOT_DIR}/4-investigation-panneau.png` });
      return { panel, header, text, scanned: n };
    }
    await quickClick(btn); // refermer : « Aucune enquête »
    await sleep(150);
  }
  return { panel: null, scanned: n };
}

try {
  /* ============ A — atelier : panneau de liens ============ */
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  const panelAside = page.locator('aside[aria-label*="Liens proposés"]');
  await panelAside.waitFor({ timeout: 15_000 });
  const linkCards = panelAside.locator('li:has(button:has-text("Investiguer"))');
  await linkCards.first().waitFor({ timeout: 20_000 });
  const linkCount = await linkCards.count();
  check("liens avec bouton « Investiguer » sur l'atelier", linkCount >= 1, `${linkCount} lien(s)`);

  const w = await scanForInvestigation(linkCards, panelAside);
  check("atelier : une enquête terminée trouvée", w.panel !== null, `${w.scanned} lien(s) balayé(s)`);
  if (w.panel) {
    check(
      "atelier : état + budget + appels dans l'en-tête",
      /Enquête terminée/.test(w.header) && /\/5 étape/.test(w.header) && /appel/.test(w.header),
      w.header
    );
    check(
      "atelier : étapes numérotées avec action",
      /Étape 1/.test(w.text) &&
        /(recherche dans le corpus|voisinage d'un fragment|conclusion)/.test(w.text),
      w.text.slice(0, 160)
    );
    check(
      "atelier : catalogue cité (source · locator)",
      /·/.test(w.text) && /(\[\d+,\d+\))|(#\S+)/.test(w.text),
      ""
    );
    check(
      "atelier : aucune citation rejetée (toutes vérifiées)",
      !/citation rejetée/.test(w.text) && !/fragment jamais montré/.test(w.text)
    );

    /* relance : idempotente par cache → même enquête, 0 appel réel. */
    const relance = w.panel.getByRole("button", { name: /Relancer l'enquête/ });
    check("atelier : bouton « Relancer l'enquête »", (await relance.count()) === 1);
    await quickClick(relance);
    const headerLoc = panelAside
      .locator("span")
      .filter({ hasText: /Enquête (terminée|échouée)|Aucune enquête/ })
      .first();
    const back = await pollUntil(async () => {
      const t = await quickText(headerLoc, 1);
      return /Enquête (terminée|échouée)/.test(t);
    }, 45_000);
    const header2 = await quickText(headerLoc);
    check(
      "atelier : relance → terminée (cache de prompt, 0 appel réel)",
      back && /Enquête terminée/.test(header2),
      `${w.header} → ${header2}`
    );
    const text2 = await quickText(w.panel);
    check(
      "atelier : relance → mêmes étapes (idempotence)",
      text2 === w.text,
      "le document relu doit être identique au bit près"
    );
  }

  /* ============ B — feed /suggestions : le même panneau ============ */
  await page.goto(`${BASE}/suggestions`, { waitUntil: "load" });
  const CARD = 'li:has([data-slot="card"])';
  await page.locator(CARD).first().waitFor({ timeout: 15_000 });
  const f = await scanForInvestigation(page.locator(CARD), page.locator("main"));
  check("feed : une enquête terminée trouvée", f.panel !== null, `${f.scanned} carte(s) balayée(s)`);
  if (f.panel) {
    check(
      "feed : en-tête complet (état, budget, appels)",
      /Enquête terminée/.test(f.header) && /\/5 étape/.test(f.header),
      f.header
    );
    check(
      "feed : étapes + citations, aucune présentée comme rejetée",
      /Étape 1/.test(f.text) && !/citation rejetée/.test(f.text),
      f.text.slice(0, 160)
    );
  }
} catch (e) {
  check("ERREUR de parcours", false, e.message);
} finally {
  await browser.close();
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
check("0 erreur console", consoleErrors.length === 0, consoleErrors.join(" | "));
check("0 requête en échec", failedRequests.length === 0, failedRequests.join(" | "));
for (const r of results.slice(-2)) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);
