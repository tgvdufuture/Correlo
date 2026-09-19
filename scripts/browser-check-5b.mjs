#!/usr/bin/env node
/**
 * Vérification navigateur Phase 5B — l'écran /syntheses.
 *   node scripts/browser-check-5b.mjs [base-url]
 *
 * À lancer contre un serveur sur une **copie jetable** de la base : le script tranche
 * des synthèses (accept + reject persistants) et vérifie ce que l'écran montre.
 * Toutes les détections sont par **rôle/accessible name** ou texte réel — aucun id
 * inventé côté test : si le libellé change, le test échoue au lieu de passer à côté.
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
  await page.goto(`${BASE}/syntheses`, { waitUntil: "networkidle" });

  /* 1 — le feed est rendu avec ses cartes (scope : li portant une Card shadcn) */
  const CARD = 'li:has([data-slot="card"])';
  const cards = page.locator(CARD);
  await cards.first().waitFor({ timeout: 10_000 });
  const cardCount = await cards.count();
  check("feed rendu (≥ 1 carte)", cardCount >= 1, `${cardCount} cartes`);
  check(
    "pas de 'Chargement…' restant",
    (await page.getByText("Chargement…").count()) === 0
  );
  await page.getByRole("button", { name: /Recharger/ }).waitFor({ timeout: 10_000 });

  /* 2 — l'en-tête d'une carte : thème, confiance, statut épistémique */
  const first = cards.first();
  const header = await first.locator("p").first().innerText();
  check("carte porte un thème", /Thème\s*«/.test(header), header.replace(/\s+/g, " "));
  const badges = await first.locator("[data-slot=badge]").allInnerTexts();
  check(
    "badges confiance + statut présents",
    badges.some((b) => /confiance/.test(b)) && badges.some((b) => /^(INFERENCE|HYPOTHESIS|SPECULATION)$/.test(b)),
    JSON.stringify(badges)
  );

  /* 3 — les preuves se déploient et sont citables (titre de source + locator + texte) */
  await first.getByRole("button", { name: /les preuves \(\d+\)/ }).click();
  const proofItems = first.locator("ol > li");
  await proofItems.first().waitFor({ timeout: 5_000 });
  const proofCount = await proofItems.count();
  check("preuves affichées (≥ 2 : règle 5A)", proofCount >= 2, `${proofCount} preuves`);
  const proofText = await proofItems.first().innerText();
  check(
    "preuve = source · locator · texte",
    /·/.test(proofText) && proofText.trim().length > 40,
    proofText.replace(/\s+/g, " ").slice(0, 120)
  );
  await page.screenshot({ path: `${SHOT_DIR}/5b-preuves-deployees.png` });

  /* 4 — accepter une synthèse : notice, retrait du feed, persistance vérifiée plus bas */
  const beforeAccept = cardCount;
  await first.getByRole("button", { name: "Accepter" }).click();
  await page.getByText("Synthèse acceptée").waitFor({ timeout: 8_000 });
  await page.screenshot({ path: `${SHOT_DIR}/5b-accept-notice.png` });
  await page.waitForFunction(
    ([sel, n]) => document.querySelectorAll(sel).length === n,
    [CARD, beforeAccept - 1],
    { timeout: 8_000 }
  );
  check(
    "accept → notice + carte sortie du feed",
    (await page.locator(CARD).count()) === beforeAccept - 1,
    `${beforeAccept} → ${await page.locator(CARD).count()}`
  );

  /* 5 — rejeter une autre : notice + retrait */
  const second = page.locator(CARD).first();
  const rejectedSeed = await second.locator("p").first().innerText();
  await second.getByRole("button", { name: "Rejeter" }).click();
  await page.getByText("Synthèse rejetée").waitFor({ timeout: 8_000 });
  await page.waitForFunction(
    ([sel, n]) => document.querySelectorAll(sel).length === n,
    [CARD, beforeAccept - 2],
    { timeout: 8_000 }
  );
  check(
    "reject → notice + carte sortie du feed",
    (await page.locator(CARD).count()) === beforeAccept - 2,
    rejectedSeed.replace(/\s+/g, " ").slice(0, 60)
  );

  /* 6 — recharger : les tranchées ne reviennent pas (AC3 côté écran) */
  await page.getByRole("button", { name: /Recharger/ }).click();
  await page.waitForFunction(
    ([sel, n]) => document.querySelectorAll(sel).length === n,
    [CARD, beforeAccept - 2],
    { timeout: 8_000 }
  );
  check(
    "reload : les tranchées ne reviennent pas",
    (await page.locator(CARD).count()) === beforeAccept - 2
  );

  /* 7 — tri du feed : confiance non croissante à l'intérieur de chaque thème */
  const confRanks = [];
  const themes = [];
  for (const li of await page.locator(CARD).all()) {
    const badges = await li.locator("[data-slot=badge]").allInnerTexts();
    const c = badges.find((b) => /confiance/.test(b)) ?? "";
    confRanks.push(/haute/.test(c) ? 0 : /moyenne/.test(c) ? 1 : 2);
    const h = await li.locator("p").first().innerText();
    themes.push((h.match(/Thème\s*«\s*([^»]*)/) ?? [])[1]?.trim() ?? "");
  }
  let breaks = 0;
  for (let i = 1; i < themes.length; i++) {
    if (themes[i] === themes[i - 1] && confRanks[i] < confRanks[i - 1]) breaks++;
  }
  check("ordre du feed : confiance non croissante par thème", breaks === 0, `${breaks} remontée(s)`);

  /* 8 — capture d'écran (preuve) : état final du feed après décisions */
  await page.screenshot({ path: `${SHOT_DIR}/5b-feed-final.png`, fullPage: false });
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  const navLink = page.getByRole("link", { name: /^Synthèses/ });
  check("entrée de nav « Synthèses »", (await navLink.count()) === 1);
  await navLink.click();
  await page.waitForURL("**/syntheses");
  check("nav → /syntheses", page.url().endsWith("/syntheses"));
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
if (consoleErrors.length || failedRequests.length) failed++;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);
