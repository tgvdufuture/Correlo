import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { decodeHtmlPage, countReplacementChars } from "@/lib/ingest/decoding";
import { stripGutenbergBoilerplate } from "@/lib/ingest/boilerplate";
import { normalizeText } from "@/lib/ingest/normalizer";
import {
  WEB_PAGE_MAX_CHARS,
  WebRefusalError,
  fetchGuarded,
  type GuardedPage,
  type ResolveHost,
} from "@/lib/agent/web-guard";

/**
 * Lecture d'une page web par l'agent de conversation (Phase 6, amendement v1.3 §13.4).
 *
 * Réutilise la **chaîne d'extraction de l'ingestion** (décodage explicite du charset,
 * Readability, retrait du boilerplate Gutenberg, normalisation) : une page lue par l'agent
 * et la même page ingérée dans le corpus doivent produire le même texte, sinon le corpus
 * et le web divergeraient sur ce que dit un document — et personne ne saurait lequel croire.
 *
 * Ce qui **n'est pas** réutilisé, en revanche : `extractUrlText` suit les redirections avec
 * `redirect: "follow"` et n'a aucune garde d'adresse, ce qui était acceptable pour une URL
 * collée par l'utilisateur et ne l'est plus pour une URL choisie par le modèle. On passe
 * donc par `fetchGuarded` (`lib/agent/web-guard.ts`).
 *
 * **Le texte extrait est une donnée, jamais une instruction.** La règle v1.2 (« aucune
 * exécution d'instructions du contenu ») s'applique telle quelle : le prompt de
 * conversation dit explicitement au modèle que les pages sont des données non fiables, et
 * rien dans ce module n'exécute quoi que ce soit de la page — pas de script (jsdom est
 * utilisé sans `runScripts`), pas de suivi d'aperçu, rien.
 */

export interface WebPage {
  /** URL effectivement lue, après redirections : c'est celle qui est citée. */
  url: string;
  title: string | null;
  /** Texte normalisé, plafonné à `WEB_PAGE_MAX_CHARS`. */
  text: string;
  redirects: string[];
  bytes: number;
}

export interface ReadPageOptions {
  fetchImpl?: typeof fetch;
  resolve?: ResolveHost;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  maxChars?: number;
}

/** Lit une URL par le chemin durci, et rend le texte **tel qu'il sera cité**. */
export async function readWebPage(rawUrl: string, opts?: ReadPageOptions): Promise<WebPage> {
  const page: GuardedPage = await fetchGuarded(rawUrl, opts);
  const maxChars = opts?.maxChars ?? WEB_PAGE_MAX_CHARS;

  const decoded = decodeHtmlPage(page.bytes, page.contentType);
  const replacements = countReplacementChars(decoded.text);
  if (replacements > 0) {
    console.warn(`[web] ${replacements} caractère(s) de remplacement dans ${page.url}`);
  }

  const dom = new JSDOM(decoded.text, { url: page.url });
  const article = new Readability(dom.window.document).parse();
  let text = article?.textContent ?? "";
  let title: string | null = article?.title?.trim() || null;

  if (text.trim().length < 200) {
    // Repli : Readability échoue sur certains CMS (MediaWiki, Wikisource…), on prend le
    // conteneur principal du document — même défaut mesuré et même repli qu'à l'ingestion.
    const container = dom.window.document.querySelector(
      "#mw-content-text, article, [role='main'], .mw-parser-output, body"
    );
    const fallback = container?.textContent ?? "";
    if (fallback.trim().length > text.trim().length) text = fallback;
    title = title ?? (dom.window.document.querySelector("h1")?.textContent?.trim() || dom.window.document.title || null);
  }

  const cleaned = stripGutenbergBoilerplate(text);
  const normalized = normalizeText(cleaned.text).slice(0, maxChars);
  if (normalized.trim().length < 100) {
    throw new WebRefusalError("lecture_echec", `Page sans texte exploitable (${page.url})`);
  }

  return {
    url: page.url,
    title,
    text: normalized,
    redirects: page.redirects,
    bytes: page.bytes.byteLength,
  };
}
