#!/usr/bin/env node
/**
 * Vérification navigateur v1.6 étape 3 — l'atelier focalisé `/canvas/[id]`.
 *   node scripts/browser-check-canvas-focused.mjs [base-url]
 *
 * À lancer contre un serveur sur une **copie jetable** de la base (l'écran écrit :
 * création de frame, déplacements). Détections par **rôle / texte réel**.
 *
 * L'AC2 visé : la vignette de l'explorateur ouvre l'atelier **focalisé sur la
 * frame** — centre + zoom —, et le focalisé écrit dans **son** tableau (011 :
 * un item posé hors frame chez lui y reste, jamais re-logé à l'atelier).
 *
 * Prérequis : une base enrichie d'un second tableau « Veille vérification »
 * portant une frame « Zone de vérification » (cf. data/eval/v16-check.db).
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
  /* 0 — la page du focalisé existe et sert le bon tableau */
  const veilleId = process.env.VEILLE_CANVAS_ID;
  if (!veilleId) throw new Error("VEILLE_CANVAS_ID requis (id du 2e tableau de la copie)");
  await page.goto(`${BASE}/canvas/${veilleId}`, { waitUntil: "networkidle" });

  // CanvasFrameBox est un div[data-frame], pas un bouton : détection par son étiquette
  const frameInPage = page.locator("[data-frame]", { hasText: "Zone de vérification" });
  await frameInPage.waitFor({ timeout: 10_000 });
  check("focalisé /canvas/[id] : la frame du tableau est rendue", true);

  /* 1 — AC2 : un lien avec ?frame= centre et zoome sur la frame */
  const zoomText = () => page.locator("text=/\\d+ %/").first().innerText();
  await page.goto(`${BASE}/canvas/${veilleId}?frame=NEANT`, { waitUntil: "networkidle" });
  // une frame inconnue ne casse pas l'écran (pas de focus, comportement normal)
  await page.locator("[data-frame]", { hasText: "Zone de vérification" }).waitFor({ timeout: 10_000 });
  check("frame inconnue en ?frame= → écran normal (pas de crash)", true);

  /* 2 — les boutons zoom/pan fonctionnent toujours (AC7 : aucune régression) */
  await page.getByRole("button", { name: "Zoom avant" }).click();
  const zoomed = await zoomText();
  check("zoom + : le pourcentage change", zoomed !== "100 %", zoomed);

  /* 3 — écriture scopée : créer une frame ici, elle appartient à CE tableau */
  await page.getByRole("button", { name: /Cadre/ }).click();
  await page.getByRole("button", { name: /Cadre/ }).waitFor({ timeout: 5_000 }).catch(() => {});
  // le clic « Cadre » crée un cadre autour de la sélection (vide ici) — vérifier
  // en base via l'API : le canvas des frames doit être veilleId, pas l'atelier
  const state = await page.evaluate(async (id) => {
    const res = await fetch(`/api/canvas?canvas=${id}`);
    return res.json();
  }, veilleId);
  const stateFrameCanvas = await page.evaluate(async () => {
    const res = await fetch(`/api/canvas`);
    return res.json();
  });
  check(
    "GET ?canvas= renvoie le tableau demandé (et pas l'atelier)",
    JSON.stringify(state.frames.map((f) => f.id)) === JSON.stringify(stateFrameCanvas.frames.map((f) => f.id)) === false || state.canvas?.id === veilleId,
    `canvas=${state.canvas?.id ?? "?"}`
  );
  check("l'état du focalisé porte le label du tableau", state.canvas?.label === "Veille vérification", state.canvas?.label);

  /* 4 — retour explorateur : la vignette ouvre le focalisé avec ?frame= */
  await page.goto(`${BASE}/explorer`, { waitUntil: "networkidle" });
  // le check précède l'explorateur sur cette copie (atelier + Veille + une carte
  // « Perso » de l'usage réel) : ouvrir **Veille**, qui porte la frame à focaliser
  const veille = page.locator("div[title='Cliquer : ouvrir le tableau']", { hasText: "Veille vérification" });
  await veille.waitFor({ timeout: 8_000 });
  await veille.click();
  const frameChip = page.locator("section button", { hasText: "Zone de vérification" }).last();
  await frameChip.waitFor({ timeout: 8_000 });
  // ouvrir la frame dans l'aperçu d'abord
  await frameChip.click();
  await page.getByText(/Objets de la frame/).waitFor({ timeout: 8_000 });
  const href = await page.locator("a", { hasText: "Plein écran" }).first().getAttribute("href");
  check(
    "l'aperçu frame → lien « Plein écran » avec ?frame=",
    href !== null && href.includes("?frame="),
    href ?? "absent"
  );
  await page.screenshot({ path: `${SHOT_DIR}/v16-focus-lien.png` });

  /* 5 — le lien mené à terme : le focalisé centre la frame (AC2, la mesure).
     Le centre pertinent est celui de la **surface** du plan (elle est flanquée
     du panneau de liens), pas celui du viewport. */
  await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
  await page.locator("[data-frame]", { hasText: "Zone de vérification" }).waitFor({ timeout: 10_000 });
  const box = await page.locator("[data-frame]").first().boundingBox();
  const surface = await page.locator("[aria-label='Plan de travail']").boundingBox();
  const centered =
    Math.abs(box.x + box.width / 2 - (surface.x + surface.width / 2)) < 80 &&
    Math.abs(box.y + box.height / 2 - (surface.y + surface.height / 2)) < 80;
  check(
    "focus : la frame est centrée dans la surface à l'ouverture",
    centered,
    `frame (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)}) vs surface (${Math.round(surface.x + surface.width / 2)}, ${Math.round(surface.y + surface.height / 2)})`
  );
  await page.screenshot({ path: `${SHOT_DIR}/v16-focus-centre.png` });
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
