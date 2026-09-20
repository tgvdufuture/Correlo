import { isIP } from "node:net";
import { LlmRateLimitError, LlmTransientError } from "@/lib/llm/errors";
import { MAX_PROVIDER_ATTEMPTS, providerRetryDelayMs } from "@/lib/llm/retry";
import {
  WebRefusalError,
  assertPublicHttpUrl,
  isPrivateAddress,
} from "@/lib/agent/web-guard";

/**
 * Connecteur de recherche web (Phase 6, amendement v1.3 §13.4).
 *
 * **Écrit à la main, en `fetch` direct.** Le projet n'a aucun SDK tiers : ses providers
 * (chat, embeddings) sont des `fetch` avec la politique de retry/timeout partagée
 * (`lib/llm/retry.ts`). Ajouter un SDK pour un `POST` serait une déviation gratuite, et
 * l'interface ci-dessous est assez petite pour qu'un second connecteur n'ait qu'à
 * l'implémenter.
 *
 * **Ce que le connecteur ne fait PAS : rendre le texte des pages.** On demande des
 * *résultats* (titre, URL, date), pas du contenu : c'est `read_page` qui lit une page, par
 * le chemin durci (`lib/agent/web-guard.ts`), et c'est cette lecture-là qui devient
 * citable, datée. Un texte rendu par le connecteur serait du contenu dont on ne saurait ni
 * par quel chemin il est entré, ni quand il a été lu — précisément ce que la §13.3 refuse.
 *
 * Les adresses des résultats sont **filtrées à l'exposition** : schéma et identifiants
 * (`assertPublicHttpUrl`), plus le cas d'un littéral d'adresse privée
 * (`http://127.0.0.1/…`) — filtrer ce qu'on peut constater sans réseau coûte zéro et
 * évite de proposer au modèle une porte qu'on refusera ensuite. Un hôte **nommé** qui
 * résoudrait vers une adresse privée ne peut pas être filtré ici : c'est la lecture qui le
 * refuse, après résolution, et à chaque redirection.
 */

export interface WebSearchResult {
  title: string | null;
  url: string;
  /** Repère de choix (date, auteur) — **jamais citable** : seule une page lue l'est. */
  snippet: string | null;
  published_at: string | null;
}

export interface WebSearchProvider {
  /** Nom du connecteur, journalisé et affiché dans la trace du tour. */
  name: string;
  search(query: string): Promise<WebSearchResult[]>;
}

export interface ExaSearchOptions {
  apiKey: string;
  baseUrl?: string;
  numResults?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Timeout d'une recherche : c'est un appel d'index, pas une lecture de page. */
export const WEB_SEARCH_TIMEOUT_MS = 20_000;

export const DEFAULT_EXA_BASE_URL = "https://api.exa.ai";

/**
 * Connecteur Exa. Le corps envoyé est **minimal et documenté** (`query`, `numResults`,
 * `type`) : on ne demande ni texte ni résumé, donc rien de ce qui revient n'a de valeur de
 * preuve, et une évolution de l'API des contenus ne peut pas casser une recherche.
 */
export function createExaSearchProvider(opts: ExaSearchOptions): WebSearchProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_EXA_BASE_URL).replace(/\/+$/, "");
  const numResults = opts.numResults ?? 5;
  const timeoutMs = opts.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    name: "exa",

    async search(query: string): Promise<WebSearchResult[]> {
      for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
        try {
          return await runSearch(query);
        } catch (e) {
          const delay = providerRetryDelayMs(e, attempt);
          if (delay === null || attempt === MAX_PROVIDER_ATTEMPTS - 1) throw e;
          console.warn(
            `[web] recherche en incident — tentative ${attempt + 1}/${MAX_PROVIDER_ATTEMPTS} ` +
              `dans ${Math.round(delay / 1000)}s : ${(e as Error).message.slice(0, 140)}`
          );
          await sleep(delay);
        }
      }
      throw new WebRefusalError("lecture_echec", "Recherche web sans résultat après tentatives");
    },
  };

  async function runSearch(query: string): Promise<WebSearchResult[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/search`, {
        method: "POST",
        signal: ctrl.signal,
        redirect: "error",
        headers: {
          "x-api-key": opts.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, numResults, type: "auto" }),
      });
    } catch (e) {
      // incident réseau du provider : passager par nature, donc réessayable (politique
      // partagée) — un 429 et un 503 méritent le même traitement qu'en chat
      throw new LlmTransientError(`Recherche web injoignable : ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const after = Number(res.headers.get("retry-after") ?? "");
      throw new LlmRateLimitError(Number.isFinite(after) && after > 0 ? after : 60);
    }
    if (res.status >= 500) {
      throw new LlmTransientError(`Recherche web : HTTP ${res.status}`);
    }
    if (!res.ok) {
      // refus définitif (clé invalide, requête refusée) : réessayer ne changerait rien
      throw new WebRefusalError("http_echec", `Recherche web refusée (HTTP ${res.status})`);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new WebRefusalError("lecture_echec", "Recherche web : réponse illisible");
    }
    return parseResults(payload);
  }
}

/** Lecture **tolérante** de la réponse : un champ renommé ne doit pas tuer la recherche. */
function parseResults(payload: unknown): WebSearchResult[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: WebSearchResult[] = [];
  for (const raw of results) {
    const item = raw as {
      title?: unknown;
      url?: unknown;
      publishedDate?: unknown;
      author?: unknown;
    };
    if (typeof item?.url !== "string") continue;
    const url = exposableUrl(item.url);
    // une adresse qui ne passerait pas le contrôle n'est pas montrée du tout : la filtrer
    // vaut mieux que la refuser à la lecture, plus tard, et de faire payer une étape
    if (url === null) continue;
    const published =
      typeof item.publishedDate === "string" && !Number.isNaN(Date.parse(item.publishedDate))
        ? new Date(item.publishedDate).toISOString()
        : null;
    const author = typeof item.author === "string" ? item.author.trim() : "";
    const snippet = [author || null, published ? `publié le ${published.slice(0, 10)}` : null]
      .filter(Boolean)
      .join(" · ");
    out.push({
      title: typeof item.title === "string" ? item.title.trim() || null : null,
      url,
      snippet: snippet || null,
      published_at: published,
    });
  }
  return out;
}

/** L'URL d'un résultat, ou `null` si elle ne doit pas être proposée au modèle. */
export function exposableUrl(raw: string): string | null {
  let url: URL;
  try {
    url = assertPublicHttpUrl(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isPrivateAddress(host)) return null;
  return url.href;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
