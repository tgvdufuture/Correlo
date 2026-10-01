import type { Db } from "@/lib/db/client";
import { decodeEmbedding } from "@/lib/llm/embedding-codec";
import { dotProduct } from "@/lib/cluster/kmeans";
import { contentWords, documentFrequency, stemOf } from "@/lib/quality/lexical-anchor";
import { looksStructural } from "@/lib/synth/select";

/**
 * Index local du corpus pour l'investigation (Phase 4) et la conversation (Phase 6).
 *
 * L'enquête dispose de deux outils, tous les deux **hors ligne et déterministes** :
 *  1. `search(query)` — recherche **hybride** : lexicale (un fragment est un candidat si l'un
 *     de ses termes de contenu partage la racine (préfixe de 5 lettres) d'un terme de
 *     la requête ; le score est la somme des poids IDF des racines trouvées) **et**
 *     sémantique (cosine entre l'embedding de la requête et ceux du corpus, encodés par
 *     le connecteur local — aucune donnée ne sort de la machine, G3 préservé). La partie
 *     lexicale seule était aveugle aux synonymes : « LLM » ne trouvait pas un corpus qui
 *     écrit « modèle de langage ». La fusion est un rangement, pas une somme : les deux
 *     listes sont intercalées par ordre décroissant de leur propre score, sans recalibrage
 *     d'échelle entre elles.
 *  2. `neighbours(fragment)` — voisinage **vectoriel** d'un fragment déjà vu : les
 *     embeddings sont en base, donc aucune requête n'est encodée, et c'est `cosine`
 *     sur les vecteurs du corpus qui ordonne le voisinage (même opération que
 *     l'échantillonneur de la Phase 2A).
 *
 * **Reproductibilité.** La partie lexicale reste reproductible au bit près (même règle
 * qu'en Phase 4) quand **aucun** encodeur n'est fourni — un test sans réseau obtient
 * exactement l'ancien comportement. Quand un encodeur est fourni, `search` devient
 * asynchrone et la partie sémantique entre dans le rangement ; la partie lexicale garde
 * le même score, donc le même ordre relatif.
 *
 * Appareil exclu des **résultats** : un sommaire, un index ou une ligne de notes n'est
 * pas une preuve exploitable (constat mesuré en Phase 5A). Les fragments d'appareil
 * restent dans l'index (`get` les retrouve, donc une graine peut être étendue) mais ne
 * sont **jamais proposés** par `search` ni par `neighbours`.
 */

/** Plafond de l'index : la NFR « échantillonnage en mémoire ≤ 5 000 fragments ». */
export const INDEX_FRAGMENT_LIMIT = 5_000;

/**
 * Encodeur de **requête** — l'autre bout de l'espace vectoriel du corpus. `LlmProvider.embed`
 * convient tel quel (Ollama local) ; injecté pour que les tests restent hors réseau et que
 * le tour décide s'il veut payer l'encodage (une panne du connecteur dégrade en lexical
 * pur au lieu de faire échouer le tour).
 */
export type QueryEmbedder = (text: string) => Promise<number[]>;

export interface IndexedFragment {
  id: string;
  sourceId: string;
  sourceTitle: string | null;
  chunkIndex: number;
  locator: string;
  text: string;
  embedding: Float32Array;
  /** Fragment d'appareil (sommaire, index, notes) : jamais proposé à l'agent. */
  structural?: boolean;
}

export interface CorpusIndex {
  /** Fragments réellement indexés (appareil exclu). */
  size: number;
  /** Fragment par id, pour retrouver une graine (le cas échéant). */
  get(fragmentId: string): IndexedFragment | undefined;
  /** Recherche hybride : au plus `k` fragments, ordre déterministe. */
  search(query: string, k: number): IndexedFragment[];
  /** Recherche sémantique seule (cosine sur l'embedding de la requête), au plus `k`. */
  semanticSearch(query: string, k: number): Promise<IndexedFragment[]>;
  /** Voisins vectoriels d'un fragment, **hors de sa propre source**, au plus `k`. */
  neighbours(fragmentId: string, k: number): IndexedFragment[];
}

export function buildCorpusIndex(
  db: Db,
  opts?: { limit?: number; embedQuery?: QueryEmbedder }
): CorpusIndex {
  const limit = opts?.limit ?? INDEX_FRAGMENT_LIMIT;
  const rows = db
    .prepare(
      `SELECT f.id, f.source_id, f.chunk_index, f.locator, f.text, f.embedding,
              f.embedding_dimensions AS dims, s.title AS source_title
       FROM fragments f JOIN sources s ON s.id = f.source_id
       ORDER BY f.source_id ASC, f.chunk_index ASC
       LIMIT ?`
    )
    .all(limit) as {
    id: string;
    source_id: string;
    chunk_index: number;
    locator: string;
    text: string;
    embedding: Buffer;
    dims: number;
    source_title: string | null;
  }[];

  // Dimension de référence : `decodeEmbedding` contrôle la longueur annoncée, donc
  // un fragment d'un autre espace vectoriel est écarté ici au lieu de rendre une
  // cosine fausse mais plausible (même invariant qu'en Phase 2A/5A).
  const dims = rows.length > 0 ? rows[0].dims : 0;
  const fragments: IndexedFragment[] = [];
  for (const r of rows) {
    if (r.dims !== dims) continue;
    fragments.push({
      id: r.id,
      sourceId: r.source_id,
      sourceTitle: r.source_title,
      chunkIndex: r.chunk_index,
      locator: r.locator,
      text: r.text,
      embedding: new Float32Array(decodeEmbedding(r.embedding, r.dims)),
      structural: looksStructural(r.text, r.locator),
    });
  }

  return makeIndex(fragments, dims, opts?.embedQuery);
}

/**
 * Construit l'index à partir de fragments déjà chargés (les tests l'utilisent
directement ; `buildCorpusIndex` est la voie normale en production).
 */
export function makeIndex(
  fragments: IndexedFragment[],
  dims: number,
  embedQuery?: QueryEmbedder
): CorpusIndex {
  const byId = new Map(fragments.map((f) => [f.id, f]));
  // Racines de contenu de chaque fragment, calculées une fois : `search` ne doit
  // pas re-tokeniser 3 800 fragments à chaque étape de l'agent.
  const stems = new Map<string, Set<string>>();
  for (const f of fragments) {
    stems.set(f.id, new Set(contentWords(f.text).map(stemOf)));
  }
  // Poids d'une racine : la meilleure rareté parmi les mots qui la partagent.
  const df = documentFrequency(fragments.map((f) => f.text));
  const n = Math.max(1, fragments.length);
  const weight = new Map<string, number>();
  for (const [w, d] of df) {
    const s = stemOf(w);
    const value = Math.log(1 + n / (1 + d));
    if (value > (weight.get(s) ?? 0)) weight.set(s, value);
  }

  const byNaturalOrder = (
    a: { f: IndexedFragment; score: number },
    b: { f: IndexedFragment; score: number }
  ): number =>
    b.score - a.score || a.f.sourceId.localeCompare(b.f.sourceId) || a.f.chunkIndex - b.f.chunkIndex;

  return {
    size: fragments.length,
    get: (fragmentId) => byId.get(fragmentId),

    search(query, k) {
      const queryStems = new Set(contentWords(query).map(stemOf));
      if (queryStems.size === 0) return [];
      const scored: { f: IndexedFragment; score: number }[] = [];
      for (const f of fragments) {
        if (f.structural) continue;
        const own = stems.get(f.id) as Set<string>;
        let score = 0;
        for (const s of queryStems) {
          if (own.has(s)) score += weight.get(s) ?? 1;
        }
        if (score > 0) scored.push({ f, score });
      }
      return pick(scored, k);
    },

    async semanticSearch(query, k) {
      if (!embedQuery) return [];
      // Les vecteurs sont L2-normalisés en base et le codec normalise la requête :
      // le produit scalaire est une cosine. Une panne du connecteur dégrade en
      // lexical pur — un outil d'exploration ne doit pas tuer le tour.
      let vec: Float32Array;
      try {
        vec = new Float32Array(await embedQuery(query));
      } catch {
        return [];
      }
      const scored: { f: IndexedFragment; score: number }[] = [];
      for (const f of fragments) {
        if (f.structural || f.embedding.length !== vec.length) continue;
        scored.push({ f, score: dotProduct(vec, f.embedding, vec.length) });
      }
      return pick(scored, k);
    },

    neighbours(fragmentId, k) {
      const a = byId.get(fragmentId);
      if (!a) return [];
      const scored: { f: IndexedFragment; score: number }[] = [];
      for (const f of fragments) {
        if (f.structural || f.sourceId === a.sourceId || f.id === a.id) continue;
        scored.push({ f, score: dotProduct(a.embedding, f.embedding, dims) });
      }
      return pick(scored, k);
    },
  };

  function pick(scored: { f: IndexedFragment; score: number }[], k: number): IndexedFragment[] {
    return scored
      .sort((x, y) => byNaturalOrder(x, y))
      .slice(0, Math.max(0, k))
      .map((s) => s.f);
  }
}

/**
 * Fusion de deux classements par rang : lexical d'abord, sémantique ensuite, sans doublon.
 * Exportée pour que le service qui paie l'encodage de requête fusionne avec **la même**
 * règle que les tests — un seul endroit décide de l'ordre des candidats.
 */
export function interleave(
  lexical: IndexedFragment[],
  semantic: IndexedFragment[],
  k: number
): IndexedFragment[] {
  const seen = new Set<string>();
  const out: IndexedFragment[] = [];
  for (let i = 0; out.length < k && (i < lexical.length || i < semantic.length); i++) {
    for (const f of [lexical[i], semantic[i]]) {
      if (!f || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
      if (out.length >= k) break;
    }
  }
  return out;
}
