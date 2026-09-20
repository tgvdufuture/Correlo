import { WEB_STEP_BUDGET } from "@/lib/agent/conversation-types";
import { readWebPage, type WebPage, type ReadPageOptions } from "@/lib/agent/web-page";
import {
  createExaSearchProvider,
  type WebSearchProvider,
} from "@/lib/agent/web-search";

/**
 * Assemblage des outils web d'un tour de conversation (Phase 6, amendement v1.3 §13.4).
 *
 * Une seule fonction, parce que la règle d'exposition est un **fait serveur** : le web est
 * `enabled` si et seulement si l'interrupteur est `on` **et** qu'un connecteur existe. Sans
 * connecteur, il n'y a pas de repli — les outils n'existent pas.
 *
 * `WEB_ACCESS=off` retire les outils **quel que soit le constat d'insuffisance** (AC2′c) :
 * c'est le seul chemin qui garantit qu'aucune requête ne sort, et il doit être lisible
 * d'un seul coup d'œil dans le réglage.
 *
 * Le plafond d'étapes web est clampé **dur** à `WEB_STEP_BUDGET`, comme le budget interne
 * l'est à `CONVERSATION_STEP_BUDGET` : une valeur d'environnement plus grande n'a pas
 * d'effet, elle est lue pour que le réglage se voie là où les autres se voient.
 */

export interface WebToolsConfig {
  /** `WEB_ACCESS` (`on` | `off`). */
  access: "on" | "off";
  /** `SEARCH_PROVIDER` (`exa` | `none`). */
  provider: "exa" | "none";
  /** `EXA_API_KEY` — requise si `provider = exa` (le boot l'exige déjà). */
  exaApiKey?: string | null;
  /** `WEB_MAX_STEPS` (clampé). */
  maxSteps: number;
  /** `WEB_UNLOCK_MIN_EVIDENCE`. */
  unlockMinEvidence: number;
  /** `WEB_SEARCH_RESULTS`. */
  searchResults?: number;
}

export interface WebTools {
  /** Le web peut-il être **exposé** (interrupteur + connecteur) ? */
  enabled: boolean;
  /** Pourquoi il ne l'est pas — dit à l'écran, jamais tu. */
  disabledReason?: "acces_desactive" | "connecteur_absent";
  provider: string | null;
  /** Étape web au plus (déjà clampée). */
  maxSteps: number;
  unlockMinEvidence: number;
  /** `null` quand le web est désactivé ou sans connecteur. */
  search: WebSearchProvider | null;
  /** Lecture durcie d'une URL (`fetchGuarded` → Readability). */
  read: (url: string) => Promise<WebPage>;
}

export function createWebTools(
  config: WebToolsConfig,
  overrides?: {
    search?: WebSearchProvider;
    read?: (url: string) => Promise<WebPage>;
    fetchImpl?: typeof fetch;
  }
): WebTools {
  const maxSteps = Math.min(config.maxSteps, WEB_STEP_BUDGET);
  const readOptions: ReadPageOptions = { fetchImpl: overrides?.fetchImpl };
  const base = {
    maxSteps,
    unlockMinEvidence: config.unlockMinEvidence,
    read: overrides?.read ?? ((url: string) => readWebPage(url, readOptions)),
  };

  if (config.access === "off") {
    return {
      ...base,
      enabled: false,
      disabledReason: "acces_desactive",
      provider: null,
      search: null,
    };
  }
  if (config.provider === "none" || !config.exaApiKey) {
    return {
      ...base,
      enabled: false,
      disabledReason: "connecteur_absent",
      provider: null,
      search: null,
    };
  }

  const search =
    overrides?.search ??
    createExaSearchProvider({
      apiKey: config.exaApiKey,
      numResults: config.searchResults,
      fetchImpl: overrides?.fetchImpl,
    });
  return { ...base, enabled: true, provider: search.name, search };
}
