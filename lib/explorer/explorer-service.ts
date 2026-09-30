import type { Db } from "@/lib/db/client";
import {
  createCanvasesRepo,
  recentCanvasIds,
  type CanvasKind,
  type CanvasRow,
} from "@/lib/repositories/canvases";
import type { CanvasFrameKind } from "@/lib/repositories/canvas";

/**
 * Le service de lecture de l'explorateur (v1.6 §14, étape 1).
 *
 * Il produit **un snapshot** : tout ce que l'écran doit dessiner (l'arbre, les
 * compteurs, la vignette, l'aperçu d'un tableau, l'activité récente), dérivé des
 * entités existantes — aucune écriture, aucune entité nouvelle. Les partitions
 * « un canvas par frame » et « un item par frame » sont **lues** ici en requêtes
 * groupées (jamais N+1 par tableau) puis assemblées en mémoire.
 *
 * Ce qu'il ne fait pas : ni `prune()` ni `placeMissing()` — ce sont des écritures,
 * elles restent la propriété du dépôt du canvas-atelier quand **son** écran s'ouvre.
 * L'explorateur montre l'état, il ne le répare pas en passant.
 */

export interface ExplorerFrameSummary {
  id: string;
  label: string;
  kind: CanvasFrameKind;
  color: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  constructions: number;
  sources: number;
}

/**
 * Les liens IA d'un objet (§14.5 AC3) : **des compteurs**, pas des listes —
 * l'aperçu montre « ce qui existe », l'écran expert (/suggestions, /syntheses)
 * montre le détail et porte les décisions. L'aperçu ne réinvente rien : chaque
 * action mène à l'écran existant.
 */
export interface ExplorerNodeLinks {
  /** Suggestions **ouvertes** (ni acceptées ni rejetées) concernant l'objet. */
  suggestions: number;
  /** Synthèses `proposed` qui citent l'objet parmi leurs sources parentes. */
  syntheses: number;
  /** Enquêtes (tout statut) sur les suggestions concernant l'objet. */
  investigations: number;
}

/**
 * Un objet **positionné** du plan — ce que la vignette dessine (§14.5 AC2 : depuis
 * les positions réelles). Deux formes possibles selon la nature :
 *  - `construction` : le texte de l'énoncé, son statut épistémique, sa peremption ;
 *  - `source` : le titre tel que la bibliothèque le dérive (jamais une copie).
 */
export type ExplorerNode =
  | ({
      kind: "construction";
      ref: string;
      frame_id: string | null;
      x: number;
      y: number;
      z: number;
      text: string;
      epistemic_status: string;
      stale: boolean;
    } & { links: ExplorerNodeLinks })
  | ({
      kind: "source";
      ref: string;
      frame_id: string | null;
      x: number;
      y: number;
      z: number;
      title: string;
      fragment_count: number;
    } & { links: ExplorerNodeLinks });

export interface ExplorerConversationRef {
  id: string;
  title: string;
  updated_at: string;
}

export interface ExplorerCanvasSummary {
  id: string;
  label: string;
  color: string | null;
  is_default: boolean;
  pinned: boolean;
  position: number;
  /** Le dossier qui contient celui-ci (v1.6.1, migration 012) — null = racine. */
  parent_id: string | null;
  /** La nature (v1.6.2, migration 013) : surface de travail ou conteneur. */
  kind: CanvasKind;
  updated_at: string;
  frames: ExplorerFrameSummary[];
  /** Items posés hors frame — ils appartiennent à l'atelier (le réceptacle). */
  unframed: { constructions: number; sources: number };
  conversations: ExplorerConversationRef[];
  totals: { frames: number; constructions: number; sources: number; conversations: number };
  /** Le plan positionné (AC2) : items joints aux entités, hors frame inclus. */
  nodes: ExplorerNode[];
}

export type ExplorerRecentEntry =
  | { kind: "canvas"; id: string; title: string; at: string }
  | { kind: "conversation"; id: string; title: string; at: string }
  | { kind: "synthesis"; id: string; title: string; at: string };

export interface ExplorerSnapshot {
  canvases: ExplorerCanvasSummary[];
  /** Dérivée (§14.3) : dernière écriture des canvases, conversations, synthèses. */
  recent: ExplorerRecentEntry[];
  generated_at: string;
}

/** Tronquage d'affichage (même règle que `conversationTitle`). */
function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function createExplorerService(db: Db) {
  const canvasesRepo = createCanvasesRepo(db);

  return {
    snapshot(): ExplorerSnapshot {
      const rows = canvasesRepo.list();
      const atelier = canvasesRepo.getAtelier();

      // ── les frames par canvas (une requête) ─────────────────────────────
      const frameRows = db
        .prepare(
          `SELECT id, canvas_id, label, kind, color, x, y, width, height, z
           FROM canvas_frames ORDER BY z ASC, rowid ASC`
        )
        .all() as (Pick<ExplorerFrameSummary, "id" | "label" | "kind" | "color" | "x" | "y" | "width" | "height" | "z"> & { canvas_id: string })[];
      const framesByCanvas = new Map<string, ExplorerFrameSummary[]>();
      for (const f of frameRows) {
        const list = framesByCanvas.get(f.canvas_id) ?? [];
        list.push({ ...f, constructions: 0, sources: 0 });
        framesByCanvas.set(f.canvas_id, list);
      }

      // ── les items par frame (une requête) + « hors frame » ──────────────
      // depuis la 011, chaque item porte **son** canvas : « hors frame » n'est plus
      // synonyme d'atelier — un tableau focalisé peut porter des objets libres
      const itemRows = db
        .prepare(
          `SELECT canvas_id, frame_id, item_kind, COUNT(*) AS n FROM canvas_items
           GROUP BY canvas_id, frame_id, item_kind`
        )
        .all() as {
        canvas_id: string;
        frame_id: string | null;
        item_kind: "construction" | "source";
        n: number;
      }[];
      const frameIndex = new Map<string, ExplorerFrameSummary>();
      for (const list of framesByCanvas.values()) {
        for (const f of list) frameIndex.set(f.id, f);
      }
      const unframedByCanvas = new Map<string, { constructions: number; sources: number }>();
      const unframedOf = (canvasId: string) => {
        const u = unframedByCanvas.get(canvasId) ?? { constructions: 0, sources: 0 };
        unframedByCanvas.set(canvasId, u);
        return u;
      };
      for (const r of itemRows) {
        if (r.frame_id !== null) {
          const f = frameIndex.get(r.frame_id);
          if (!f) continue; // frame inconnue : le dépôt du canvas la purge à son ouverture
          if (r.item_kind === "construction") f.constructions += r.n;
          else f.sources += r.n;
        } else {
          // posé hors frame ⇒ il appartient à **son** canvas (011, §14.2)
          const u = unframedOf(r.canvas_id);
          if (r.item_kind === "construction") u.constructions += r.n;
          else u.sources += r.n;
        }
      }

      // ── les nodes positionnés (AC2) : les items joints aux entités ──────
      // Une seule lecture de chaque table, quel que soit le nombre de tableaux.
      const placementRows = db
        .prepare(
          `SELECT item_kind, item_ref, x, y, z, canvas_id, frame_id FROM canvas_items
           ORDER BY z ASC, rowid ASC`
        )
        .all() as {
        item_kind: "construction" | "source";
        item_ref: string;
        x: number;
        y: number;
        z: number;
        canvas_id: string;
        frame_id: string | null;
      }[];
      const constructionRefs = placementRows.filter((p) => p.item_kind === "construction").map((p) => p.item_ref);
      const constructionRows =
        constructionRefs.length === 0
          ? []
          : (db
              .prepare(
                `SELECT c.id, c.text, c.epistemic_status, c.stale FROM constructions c
                 WHERE c.id IN (${constructionRefs.map(() => "?").join(",")})`
              )
              .all(...constructionRefs) as {
              id: string;
              text: string;
              epistemic_status: string;
              stale: number;
            }[]);
      const constructionById = new Map(constructionRows.map((c) => [c.id, c]));
      // ── les liens IA (AC3) — lectures groupées, jamais N+1 ─────────────
      // (1) par construction : sa suggestion parente et ses enquêtes (UNIQUE).
      const constructionLinks = new Map<
        string,
        { suggestionId: string | null; investigations: number; suggestions: number }
      >();
      if (constructionRefs.length > 0) {
        const rows = db
          .prepare(
            `SELECT c.id, c.suggestion_id,
               (SELECT COUNT(*) FROM investigations i WHERE i.suggestion_id = c.suggestion_id) AS investigations,
               (SELECT COUNT(*) FROM suggestions sg
                 WHERE sg.id = c.suggestion_id
                   AND sg.state NOT IN ('accepted', 'rejected')) AS suggestions
             FROM constructions c
             WHERE c.id IN (${constructionRefs.map(() => "?").join(",")})`
          )
          .all(...constructionRefs) as {
          id: string;
          suggestion_id: string | null;
          investigations: number;
          suggestions: number;
        }[];
        for (const r of rows) {
          constructionLinks.set(r.id, {
            suggestionId: r.suggestion_id,
            investigations: r.investigations,
            suggestions: r.suggestions,
          });
        }
      }
      // (2) par source : suggestions ouvertes la concernant (la paire passe par
      // les fragments), synthèses proposed qui la citent, enquêtes sur ces
      // suggestions — plafonnées implicitement par le COUNT (des compteurs).
      const sourceRefs = placementRows.filter((p) => p.item_kind === "source").map((p) => p.item_ref);
      const sourceRows =
        sourceRefs.length === 0
          ? []
          : (db
              .prepare(
                `SELECT s.id, s.title,
                   (SELECT COUNT(*) FROM fragments f WHERE f.source_id = s.id) AS fragment_count
                 FROM sources s
                 WHERE s.id IN (${sourceRefs.map(() => "?").join(",")})`
              )
              .all(...sourceRefs) as {
              id: string;
              title: string | null;
              fragment_count: number;
            }[]);
      const sourceById = new Map(sourceRows.map((s) => [s.id, s]));
      const sourceLinks = new Map<string, ExplorerNodeLinks>();
      if (sourceRefs.length > 0) {
        const rows = db
          .prepare(
            `SELECT s.id,
               (SELECT COUNT(*) FROM suggestions sg
                JOIN fragments fa ON fa.id = sg.fragment_a_id
                JOIN fragments fb ON fb.id = sg.fragment_b_id
                WHERE (fa.source_id = s.id OR fb.source_id = s.id)
                  AND sg.state NOT IN ('accepted', 'rejected')) AS suggestions,
               (SELECT COUNT(*) FROM syntheses sy
                WHERE sy.state = 'proposed'
                  AND EXISTS (SELECT 1 FROM json_each(sy.parent_source_ids) j WHERE j.value = s.id)) AS syntheses,
               (SELECT COUNT(*) FROM investigations i
                WHERE EXISTS (
                  SELECT 1 FROM suggestions sg
                  JOIN fragments fa ON fa.id = sg.fragment_a_id
                  JOIN fragments fb ON fb.id = sg.fragment_b_id
                  WHERE i.suggestion_id = sg.id
                    AND (fa.source_id = s.id OR fb.source_id = s.id)
                )) AS investigations
             FROM sources s
             WHERE s.id IN (${sourceRefs.map(() => "?").join(",")})`
          )
          .all(...sourceRefs) as {
          id: string;
          suggestions: number;
          syntheses: number;
          investigations: number;
        }[];
        for (const r of rows) {
          sourceLinks.set(r.id, {
            suggestions: r.suggestions,
            syntheses: r.syntheses,
            investigations: r.investigations,
          });
        }
      }
      /** frame → canvas : un node se rattache au canvas de **sa** frame. */
      const nodesByCanvas = new Map<string, ExplorerNode[]>();
      for (const p of placementRows) {
        // l'appartenance est **portée par l'item** (011) — la frame ne sert qu'au
        // rangement ; un item hors frame reste dans son tableau
        const canvasId = p.canvas_id;
        const base = { ref: p.item_ref, frame_id: p.frame_id, x: p.x, y: p.y, z: p.z };
        const list = nodesByCanvas.get(canvasId) ?? [];
        if (p.item_kind === "construction") {
          const c = constructionById.get(p.item_ref);
          if (!c) continue; // course avec une suppression : le dépôt de l'atelier purge
          const cl = constructionLinks.get(p.item_ref);
          list.push({
            kind: "construction",
            ...base,
            text: clip(c.text),
            epistemic_status: c.epistemic_status,
            stale: c.stale === 1,
            links: {
              suggestions: cl?.suggestions ?? 0,
              syntheses: 0, // une synthèse cite des SOURCES, pas des constructions
              investigations: cl?.investigations ?? 0,
            },
          });
        } else {
          const s = sourceById.get(p.item_ref);
          if (!s) continue;
          list.push({
            kind: "source",
            ...base,
            title: s.title ?? "Sans titre",
            fragment_count: s.fragment_count,
            links: sourceLinks.get(p.item_ref) ?? { suggestions: 0, syntheses: 0, investigations: 0 },
          });
        }
        nodesByCanvas.set(canvasId, list);
      }

      // ── les conversations par canvas (une requête) ──────────────────────
      const convRows = db
        .prepare(
          `SELECT cc.canvas_id, co.id, co.title, co.updated_at
           FROM conversation_canvases cc
           JOIN conversations co ON co.id = cc.conversation_id
           ORDER BY co.updated_at DESC, co.rowid DESC`
        )
        .all() as { canvas_id: string; id: string; title: string; updated_at: string }[];
      const convsByCanvas = new Map<string, ExplorerConversationRef[]>();
      for (const c of convRows) {
        const list = convsByCanvas.get(c.canvas_id) ?? [];
        list.push({ id: c.id, title: clip(c.title), updated_at: c.updated_at });
        convsByCanvas.set(c.canvas_id, list);
      }

      // ── assemblage ──────────────────────────────────────────────────────
      const canvases: ExplorerCanvasSummary[] = rows.map((r: CanvasRow) => {
        // **Un dossier est un conteneur pur** (v1.6.2) : il n'a ni plan, ni items,
        // ni conversations — il ne montre que ce qu'il range (ses enfants, lus par
        // l'écran dans le même snapshot). Les gardes d'écriture garantissent qu'il
        // n'a RIEN : on n'assemble pas ce qui ne peut pas exister.
        const isFolder = r.kind === "folder";
        const frames = isFolder ? [] : (framesByCanvas.get(r.id) ?? []);
        const unframed = !isFolder && r.id === atelier.id ? (unframedByCanvas.get(r.id) ?? { constructions: 0, sources: 0 }) : { constructions: 0, sources: 0 };
        const conversations = isFolder ? [] : (convsByCanvas.get(r.id) ?? []);
        const fromFrames = frames.reduce(
          (acc, f) => ({
            constructions: acc.constructions + f.constructions,
            sources: acc.sources + f.sources,
          }),
          { constructions: 0, sources: 0 }
        );
        return {
          id: r.id,
          label: r.label,
          color: r.color,
          is_default: r.is_default === 1,
          pinned: r.pinned === 1,
          position: r.position,
          parent_id: r.parent_id,
          kind: r.kind,
          updated_at: r.updated_at,
          frames,
          unframed,
          conversations,
          totals: {
            frames: frames.length,
            constructions: fromFrames.constructions + unframed.constructions,
            sources: fromFrames.sources + unframed.sources,
            conversations: conversations.length,
          },
          nodes: nodesByCanvas.get(r.id) ?? [],
        };
      });

      // ── l'activité récente (dérivée, plafonnée, dédoublonnée) ───────────
      const candidates: ExplorerRecentEntry[] = [];
      const recentAt = new Map<string, string>();
      for (const c of canvases) recentAt.set(c.id, c.updated_at);
      for (const id of recentCanvasIds(db, 5)) {
        const c = canvases.find((x) => x.id === id);
        if (c) candidates.push({ kind: "canvas", id: c.id, title: c.label, at: c.updated_at });
      }
      const recentConvs = db
        .prepare(
          `SELECT id, title, updated_at FROM conversations
           ORDER BY updated_at DESC, rowid DESC LIMIT 5`
        )
        .all() as { id: string; title: string; updated_at: string }[];
      for (const c of recentConvs) {
        candidates.push({ kind: "conversation", id: c.id, title: clip(c.title), at: c.updated_at });
      }
      const recentSynths = db
        .prepare(
          `SELECT s.id, s.text, s.created_at FROM syntheses s
           WHERE s.state = 'accepted'
           ORDER BY s.created_at DESC, s.rowid DESC LIMIT 3`
        )
        .all() as { id: string; text: string; created_at: string }[];
      const synthesisTitle = new Map(
        recentSynths.map((s) => [s.id, clip(s.text)]),
      );
      for (const s of recentSynths) {
        candidates.push({
          kind: "synthesis",
          id: s.id,
          title: synthesisTitle.get(s.id) ?? "",
          at: s.created_at,
        });
      }
      const seen = new Set<string>();
      const recent = candidates
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .filter((e) => {
          const key = `${e.kind}:${e.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 8);

      return { canvases, recent, generated_at: new Date().toISOString() };
    },
  };
}
