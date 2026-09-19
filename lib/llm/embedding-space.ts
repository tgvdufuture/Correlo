import type { Db } from "@/lib/db/client";

/**
 * Espace vectoriel d'un fragment — identité **du corpus**, pas du code.
 *
 * Un vecteur n'a de sens que dans l'espace qui l'a produit : comparer un
 * `nomic-embed-text` (768 dims) à un `nemotron-3-embed-1b` (2048 dims) n'est pas
 * « moins précis », c'est **dépourvu de sens**. Or `dotProduct(a, b, dims)` lit
 * `dims` valeurs dans chaque vecteur : sur un corpus mixte il lit les 768
 * premières valeurs d'un vecteur de 2048 et rend une cosine **fausse mais
 * plausible** — donc des suggestions plausibles et fausses, le pire cas.
 *
 * D'où les deux niveaux de cette unité :
 *   - `assertSingleEmbeddingSpace` : **invariant dur** d'un run (un corpus
 *     multi-espaces fait échouer le run au lieu de produire du bruit) ;
 *   - `listCorpusSpaces` : ce que l'UI montre pour rendre la bascule de
 *     connecteur visible (`npm run reembed` remet le corpus d'aplomb).
 */
export interface EmbeddingSpace {
  model: string;
  dimensions: number;
  version: string;
}

/** Un espace présent en base, avec son poids (fragments et sources distinctes). */
export interface CorpusSpace extends EmbeddingSpace {
  fragments: number;
  sources: number;
}

/** Espaces coexistants dans un corpus : le run est refusé (voir l'unité ci-dessus). */
export class EmbeddingSpaceMismatchError extends Error {
  // Champs explicites plutôt que propriétés de constructeur : Node refuse
  // (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) ce raccourci en mode « strip-only », et ce
  // module est importé par `scripts/reembed.mjs` — qui doit voir **le même** espace
  // que l'app, pas une copie de la règle.
  readonly spaces: CorpusSpace[];

  constructor(spaces: CorpusSpace[], context: string) {
    super(
      `Corpus multi-espaces vectoriels (${context}) : ` +
        spaces.map((s) => `${spaceLabel(s)} × ${s.fragments} fragments`).join(" | ") +
        ". Comparer ces vecteurs produirait des similarités fausses : " +
        "re-vectorise le corpus avec le connecteur actif (`npm run reembed`)."
    );
    this.spaces = spaces;
    this.name = "EmbeddingSpaceMismatchError";
  }
}

/** Libellé lisible : `nemotron-3-embed-1b (2048 dims, v1)`. */
export function spaceLabel(s: EmbeddingSpace): string {
  return `${s.model} (${s.dimensions} dims, ${s.version})`;
}

/** Les deux espaces sont-ils le même ? (identité complète, pas seulement les dims) */
export function sameSpace(a: EmbeddingSpace, b: EmbeddingSpace): boolean {
  return a.model === b.model && a.dimensions === b.dimensions && a.version === b.version;
}

/**
 * Espaces présents parmi les fragments des sources données (tout le corpus si
 * `sourceIds` est absent), du plus fourni au moins fourni.
 *
 * Les sources distinctes sont comptées : une source dont **aucun** fragment n'est
 * dans l'espace actif est un fichier entier à re-vectoriser, ce que le nombre de
 * fragments seul ne dit pas.
 */
export function listCorpusSpaces(db: Db, sourceIds?: string[]): CorpusSpace[] {
  const args = sourceIds ?? [];
  const filter = sourceIds && sourceIds.length > 0 ? `WHERE f.source_id IN (${args.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(
      `SELECT f.embedding_model AS model, f.embedding_dimensions AS dimensions,
              f.embedding_version AS version, COUNT(*) AS fragments,
              COUNT(DISTINCT f.source_id) AS sources
       FROM fragments f ${filter}
       GROUP BY f.embedding_model, f.embedding_dimensions, f.embedding_version
       ORDER BY fragments DESC`
    )
    .all(...args) as CorpusSpace[];
  return rows;
}

/**
 * Invariant d'un run : le corpus qu'il va comparer ne contient **qu'un seul**
 * espace vectoriel. Renvoie l'espace unique (`null` si aucun fragment — run vide,
 * ce n'est pas une erreur) et lève `EmbeddingSpaceMismatchError` sinon.
 */
export function assertSingleEmbeddingSpace(db: Db, sourceIds: string[], context: string): CorpusSpace | null {
  const spaces = listCorpusSpaces(db, sourceIds);
  if (spaces.length > 1) throw new EmbeddingSpaceMismatchError(spaces, context);
  return spaces[0] ?? null;
}
