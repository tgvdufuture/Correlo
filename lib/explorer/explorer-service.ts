import type { Db } from "@/lib/db/client";
import {
  createCanvasesRepo,
  recentCanvasIds,
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
  updated_at: string;
  frames: ExplorerFrameSummary[];
  /** Items posés hors frame — ils appartiennent à l'atelier (le réceptacle). */
  unframed: { constructions: number; sources: number };
  conversations: ExplorerConversationRef[];
  totals: { frames: number; constructions: number; sources: number; conversations: number };
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
      const itemRows = db
        .prepare(
          `SELECT frame_id, item_kind, COUNT(*) AS n FROM canvas_items
           GROUP BY frame_id, item_kind`
        )
        .all() as { frame_id: string | null; item_kind: "construction" | "source"; n: number }[];
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
          // posé hors frame ⇒ atelier, par construction (§14.2)
          const u = unframedOf(atelier.id);
          if (r.item_kind === "construction") u.constructions += r.n;
          else u.sources += r.n;
        }
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
        const frames = framesByCanvas.get(r.id) ?? [];
        const unframed = r.id === atelier.id ? (unframedByCanvas.get(r.id) ?? { constructions: 0, sources: 0 }) : { constructions: 0, sources: 0 };
        const conversations = convsByCanvas.get(r.id) ?? [];
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
          `SELECT id, text, created_at FROM syntheses
           WHERE state = 'accepted'
           ORDER BY created_at DESC, rowid DESC LIMIT 3`
        )
        .all() as { id: string; text: string; created_at: string }[];
      for (const s of recentSynths) {
        candidates.push({ kind: "synthesis", id: s.id, title: clip(s.text), at: s.created_at });
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
