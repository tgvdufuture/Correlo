import fs from "node:fs";
import path from "node:path";
import { decodeTextBytes } from "@/lib/ingest/decoding";
import type { WorkspaceRefusal } from "@/lib/agent/workspace-refusals";

/**
 * Le **workspace** d'un tour de conversation (Phase 6, amendement v1.3 §13.5, AC3).
 *
 * Un seul outil, et c'est le seul endroit de tout le projet où l'agent touche au système de
 * fichiers : `read_file(chemin, de_ligne, à_ligne)`, **lecture seule**, confiné à une racine
 * (`WORKSPACE_ROOT`) désignée par l'utilisateur. Aucune écriture, aucune création, aucune
 * suppression, **aucune énumération de dossier** : on ne peut lire qu'un fichier *nommé*.
 * Un outil qui listerait un dossier serait une carte du disque de l'utilisateur offerte au
 * modèle, et personne ne l'a demandée.
 *
 * **Pourquoi synchrone.** Les appels `node:fs` de ce module sont volontairement synchrones.
 * Deux raisons, et la seconde décide : la lecture est locale, plafonnée (1 Mo au plus) et ne
 * bloque donc rien d'observable ; surtout, la **vérification à la relecture** d'une citation
 * (`conversation-citations.ts`) est synchrone — elle vit dans le même service de lecture que
 * la revérification des fragments, elle-même synchrone depuis la Phase 4 — et deux chemins
 * (un `async` pour le tour, un `sync` pour la relecture) donneraient deux règles de
 * confinement, donc une divergence invisible. Un seul chemin, une seule règle.
 *
 * **Le durcissement, dans l'ordre — et l'ordre compte :**
 *  1. racine résolue (`realpathSync`) **à chaque lecture** : une racine qui est elle-même un
 *     lien symbolique est légitime, et c'est la cible qui compte. La résoudre une seule fois
 *     à la construction a été essayé, et mesuré faux à la vérification navigateur : le
 *     serveur démarre avant que le dossier existe (c'est le cas du script de vérification, et
 *     celui d'un utilisateur qui crée son dossier après avoir lancé l'app) — le lecteur
 *     gardait alors `null` **à vie** et chaque lecture refusait `racine_invalide` jusqu'au
 *     redémarrage. Aucun état caché : le disque est la seule vérité, et la résolution n'est
 *     qu'un appel de chemin ;
 *  2. chemin demandé résolu contre la racine, puis **liens symboliques résolus**
 *     (`realpathSync`) — un `..` ou un lien qui sort se voit **après** résolution, jamais
 *     avant (`a/../../secret` et `lien_vers_dehors/secret` sont le même problème) ;
 *  3. refus si le résultat n'est pas **dans** la racine (`path.relative`, donc insensible à
 *     la casse du volume sur Windows) ;
 *  4. fichier **ordinaire** seulement (`statSync().isFile()`) : un dossier, un FIFO ou un
 *     périphérique se refusent **avant** toute lecture — un FIFO bloquerait le worker ;
 *  5. plafonds : 1 Mo pour le fichier, 256 Ko pour la copie rendue (AC3) ;
 *  6. **texte seulement** : un octet nul dans le fichier ⇒ refus. Ce n'est pas une devinette
 *     d'extension (un `.txt` binaire existe, un PDF sans extension aussi) mais un constat sur
 *     le contenu ;
 *  7. le texte extrait est une **donnée, jamais une instruction** : la règle v1.2 s'applique
 *     telle quelle (le prompt le dit au modèle, et ce module n'exécute rien).
 *
 * **Ce que ce module ne fait pas** : juger si le fichier est *pertinent*, ni s'il appartient
 * à l'utilisateur (la racine est le périmètre, il n'y en a pas d'autre).
 */

/** Plafond du fichier lu **en entier** pour en extraire une plage (au-delà : refus). */
export const WORKSPACE_MAX_FILE_BYTES = 1_048_576;

/** Plafond de la **copie** rendue par une lecture (AC3 : ≤ 256 Ko par lecture). */
export const WORKSPACE_MAX_READ_BYTES = 262_144;

/** Longueur de la copie conservée avec une citation (`chemin:ligne`), et affichée. */
export const WORKSPACE_EXCERPT_CHARS = 1_200;

/**
 * Fenêtre par défaut quand la fin n'est pas demandée : 200 lignes. Un défaut explicite
 * plutôt que « jusqu'à la fin » — sur un fichier long, « jusqu'à la fin » produirait un refus
 * `plage_trop_longue` pour une demande qui n'avait rien d'excessif.
 */
export const WORKSPACE_DEFAULT_LINES = 200;

/** Motif de refus, typé — le service en fait une étape tracée, jamais une exception nue. */
export class WorkspaceRefusalError extends Error {
  constructor(
    readonly refusal: WorkspaceRefusal,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceRefusalError";
  }
}

export interface WorkspaceReadResult {
  /** Chemin **relatif à la racine**, séparateurs `/` — c'est ce qui est affiché et cité. */
  path: string;
  /** Chemin absolu réellement lu (résolu, liens compris). Jamais cité, jamais montré. */
  absolute: string;
  /** Première ligne incluse (1-based). */
  from_line: number;
  /** Dernière ligne incluse (1-based). */
  to_line: number;
  lines: number;
  bytes: number;
  /** Copie de la plage, plafonnée à `WORKSPACE_MAX_READ_BYTES`. */
  text: string;
}

export interface WorkspaceReadInput {
  /** Chemin demandé par le modèle : relatif à la racine, ou absolu **dans** la racine. */
  path: string;
  /** Début de plage (1-based). Défaut : 1. */
  from?: number;
  /** Fin incluse. Défaut : `from + WORKSPACE_DEFAULT_LINES - 1`, bornée à la fin du fichier. */
  to?: number;
}

/**
 * Le lecteur confiné. `enabled: false` quand aucune racine n'est configurée : l'outil
 * n'existe alors pas dans la liste exposée au modèle — et un appel direct **refuse** aussi,
 * plutôt que de lire quoi que ce soit. Les deux moitiés de l'AC3 sont donc tenues par
 * construction, pas par la discipline des appelants.
 */
export interface WorkspaceReader {
  enabled: boolean;
  /** Racine **configurée** (telle quelle), ou `null`. Affichée par l'écran, jamais choisie. */
  root: string | null;
  /** Racine réellement résolue **maintenant** (liens compris), ou `null` si elle est inutilisable. */
  resolve(): string | null;
  read(input: WorkspaceReadInput): WorkspaceReadResult;
}

/** Traduit un chemin relatif en forme affichable, quel que soit le séparateur du système. */
function portable(relative: string): string {
  return relative.split(path.sep).join("/");
}

/**
 * Construit le lecteur. **Aucune exception à la construction** : une racine vide donne un
 * lecteur désactivé (le cas normal), une racine illisible un lecteur actif qui refuse
 * `racine_invalide` — un défaut de réglage se dit dans la trace du tour, il ne tue pas le
 * démarrage du worker.
 */
export function createWorkspace(root?: string | null): WorkspaceReader {
  const configured = root && root.trim().length > 0 ? root.trim() : null;
  /**
   * Résolution **à la demande** : aucune copie de l'état du disque n'est gardée. Un réglage
   * qui se met à désigner un dossier valide (ou qui cesse de le faire) est vu à la lecture
   * suivante, sans redémarrage — et le refus `racine_invalide` reste le seul chemin d'échec.
   */
  const resolve = (): string | null => {
    if (configured === null) return null;
    try {
      const real = fs.realpathSync(path.resolve(configured));
      return fs.statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  };

  if (configured === null) {
    return {
      enabled: false,
      root: null,
      resolve: () => null,
      read() {
        throw new WorkspaceRefusalError(
          "racine_absente",
          "workspace : aucune racine configurée (WORKSPACE_ROOT)"
        );
      },
    };
  }

  // un avertissement **au démarrage** reste utile : un réglage illisible se dit une fois,
  // bruyamment, même si la lecture, elle, retente à chaque appel
  if (resolve() === null) {
    console.warn(`[workspace] WORKSPACE_ROOT inutilisable pour l'instant : ${configured}`);
  }

  return {
    enabled: true,
    root: configured,
    resolve,
    read(input: WorkspaceReadInput): WorkspaceReadResult {
      const base = resolve();
      if (base === null) {
        throw new WorkspaceRefusalError(
          "racine_invalide",
          `workspace : racine illisible (${configured})`
        );
      }
      const requested = typeof input.path === "string" ? input.path.trim() : "";
      if (requested.length === 0 || requested.includes("\0")) {
        throw new WorkspaceRefusalError("chemin_invalide", "workspace : chemin vide ou illisible");
      }
      // un séparateur `\` écrit par le modèle désigne le même dossier que `/` (Windows) :
      // on ne demande pas au modèle de connaître le système de fichiers
      const normalized = requested.replace(/\\/g, path.sep);

      // 2. résolution puis **liens symboliques résolus** : c'est la résolution qui décide,
      //    jamais la forme du chemin écrit (un `..` légitime ne doit pas être refusé)
      let real: string;
      try {
        real = fs.realpathSync(
          path.isAbsolute(normalized) ? normalized : path.join(base, normalized)
        );
      } catch {
        throw new WorkspaceRefusalError(
          "chemin_introuvable",
          `workspace : chemin introuvable (${requested})`
        );
      }

      // 3. dans la racine ? `path.relative` rend `..` ou un chemin absolu dès qu'on sort ;
      //    sur Windows la comparaison est insensible à la casse, comme le volume
      const relative = path.relative(base, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new WorkspaceRefusalError(
          "chemin_hors_racine",
          `workspace : chemin hors de la racine (${requested})`
        );
      }
      if (relative === "") {
        // la racine elle-même : c'est un dossier, et l'énumération n'existe pas
        throw new WorkspaceRefusalError(
          "cible_non_fichier",
          `workspace : la cible est la racine (${requested})`
        );
      }

      // 4. fichier ordinaire seulement, et **avant** de lire : un FIFO bloquerait le worker
      let size: number;
      try {
        const stat = fs.statSync(real);
        if (!stat.isFile()) {
          throw new WorkspaceRefusalError(
            "cible_non_fichier",
            `workspace : cible non fichier (${requested})`
          );
        }
        size = stat.size;
      } catch (e) {
        if (e instanceof WorkspaceRefusalError) throw e;
        throw new WorkspaceRefusalError("lecture_echec", `workspace : stat échoué (${requested})`);
      }
      if (size > WORKSPACE_MAX_FILE_BYTES) {
        throw new WorkspaceRefusalError(
          "fichier_trop_gros",
          `workspace : fichier de ${size} octets (plafond ${WORKSPACE_MAX_FILE_BYTES})`
        );
      }

      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(real);
      } catch {
        throw new WorkspaceRefusalError("lecture_echec", `workspace : lecture échouée (${requested})`);
      }

      // 6. texte seulement : un octet nul est un constat sur le contenu, pas une extension
      if (bytes.includes(0)) {
        throw new WorkspaceRefusalError(
          "fichier_binaire",
          `workspace : fichier non textuel (${requested})`
        );
      }
      // même chaîne de décodage qu'à l'ingestion : un fichier lu par l'agent et le même
      // fichier ingéré dans le corpus doivent dire la même chose
      const text = decodeTextBytes(bytes).text;

      const lines = text.split(/\r\n|\n/);
      const from = input.from ?? 1;
      if (!Number.isInteger(from) || from < 1) {
        throw new WorkspaceRefusalError(
          "plage_invalide",
          `workspace : début de plage invalide (${String(input.from)})`
        );
      }
      const requestedTo = input.to ?? from + WORKSPACE_DEFAULT_LINES - 1;
      if (!Number.isInteger(requestedTo)) {
        throw new WorkspaceRefusalError(
          "plage_invalide",
          `workspace : fin de plage invalide (${String(input.to)})`
        );
      }
      if (requestedTo < from) {
        throw new WorkspaceRefusalError(
          "plage_invalide",
          `workspace : plage ${from}-${requestedTo} incohérente`
        );
      }
      if (from > lines.length) {
        throw new WorkspaceRefusalError(
          "plage_hors_texte",
          `workspace : la ligne ${from} dépasse les ${lines.length} lignes de ${requested}`
        );
      }
      const to = Math.min(requestedTo, lines.length);
      const slice = lines.slice(from - 1, to).join("\n");
      const sliceBytes = Buffer.byteLength(slice, "utf8");
      if (sliceBytes > WORKSPACE_MAX_READ_BYTES) {
        throw new WorkspaceRefusalError(
          "plage_trop_longue",
          `workspace : plage de ${sliceBytes} octets (plafond ${WORKSPACE_MAX_READ_BYTES})`
        );
      }

      return {
        path: portable(relative),
        absolute: real,
        from_line: from,
        to_line: to,
        lines: to - from + 1,
        bytes: sliceBytes,
        text: slice,
      };
    },
  };
}

/**
 * Copie normalisée d'une plage : c'est **elle** qui est conservée avec la citation et
 * comparée à la relecture. Même parti pris que `webExcerpt` : jamais un extrait recopié par
 * le modèle (rien ne pourrait le vérifier), toujours la copie du serveur.
 */
export function workspaceExcerpt(
  text: string,
  max: number = WORKSPACE_EXCERPT_CHARS
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
