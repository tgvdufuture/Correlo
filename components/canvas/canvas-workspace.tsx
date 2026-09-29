"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Frame,
  Group,
  Link2,
  Loader2,
  Maximize,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CanvasFrameBox, CanvasItemCard, itemSize } from "@/components/canvas/canvas-items";
import { CanvasEdges } from "@/components/canvas/canvas-edges";
import { CanvasInspector } from "@/components/canvas/canvas-inspector";
import { LinkPanel } from "@/components/canvas/link-panel";
import {
  EMBEDDING_SPACE_COMMAND,
  FRAME_DEFAULT_HEIGHT,
  FRAME_DEFAULT_WIDTH,
  type CanvasFrame,
  type CanvasItem,
  type CanvasItemKind,
  type CanvasLink,
  type CanvasState,
  type ConstructionItem,
  type EmbeddingSpaceState,
  type FeedbackReason,
} from "@/lib/api-types";

/**
 * L'atelier : le canvas est la **page principale** du produit.
 *
 * On y dépose des fichiers, on les dispose librement (positions enregistrées), on les
 * regroupe, et pendant ce temps l'IA cherche des liens entre eux — les liens sont
 * dessinés comme des arêtes, et le panneau de droite permet de les intégrer ou de les
 * rejeter. Les Constructions issues d'un lien accepté sont des éléments comme les
 * autres : elles se rangent dans les mêmes cadres.
 *
 * Ce que le composant possède : le pan, le zoom, la sélection et le geste en cours.
 * Ce qu'il ne possède pas : la vérité des positions — elles sont relues du serveur
 * après un déplacement de conteneur, et c'est le **serveur** qui applique le décalage
 * aux membres (le client n'envoie que le cadre).
 *
 * Conventions de geste (alignées sur les outils de dessin) :
 *  - glisser sur le fond = **lasso** de sélection ;
 *  - Espace + glisser, bouton du milieu, ou molette = **pan** ;
 *  - Ctrl/Cmd + molette, ou les boutons ± = **zoom** ;
 *  - glisser un élément = déplacer la sélection entière ;
 *  - glisser la poignée d'un conteneur = le déplacer, ses membres suivent ;
 *  - flèches = décaler de 10 px (Maj = 1 px) ; double-clic = détail et provenance ;
 *  - déposer un fichier = il prend **la place du curseur** et part à l'ingestion.
 *
 * Le geste est un **état** (et non une `ref`) : c'est ce qui rattache et détache les
 * écouteurs `pointermove`/`pointerup` au bon moment.
 */

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const RESIZE_MIN_W = 200;
const RESIZE_MIN_H = 140;
const PADDING = 40;
/** Cadence de relecture tant que l'IA travaille (l'ingestion puis la découverte). */
const POLL_MS = 8000;

type World = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type ItemKey = string;
type ItemRef = { kind: CanvasItemKind; ref: string };

type Drag =
  | { kind: "pan"; startClient: World; viewOrigin: World }
  | { kind: "items"; startWorld: World; origins: Map<ItemKey, World> }
  | { kind: "frame"; id: string; startWorld: World; origin: World; memberOrigins: Map<ItemKey, World> }
  | { kind: "resize"; id: string; startWorld: World; size: { w: number; h: number } }
  | { kind: "marquee"; startWorld: World };

interface CanvasPayload extends CanvasState {
  discovery: { pending: number; running: number };
  embeddingSpace?: EmbeddingSpaceState;
}

const keyOf = (i: ItemRef): ItemKey => `${i.kind}:${i.ref}`;
const refOf = (key: ItemKey): ItemRef => {
  const cut = key.indexOf(":");
  return { kind: key.slice(0, cut) as CanvasItemKind, ref: key.slice(cut + 1) };
};

export function CanvasWorkspace({
  /** Le tableau servi (v1.6 §14.2) — l'atelier par défaut. */
  canvasId,
  /** Une frame à **focaliser** au chargement (AC2 : centre + zoom depuis la vignette). */
  focusFrameId,
}: {
  canvasId?: string;
  focusFrameId?: string;
} = {}) {
  const [data, setData] = useState<CanvasState | null>(null);
  const [discovery, setDiscovery] = useState<{ pending: number; running: number } | null>(null);
  const [spaceState, setSpaceState] = useState<EmbeddingSpaceState | null>(null);
  const [view, setView] = useState({ x: 40, y: 40, zoom: 1 });
  const [selection, setSelection] = useState<ItemKey[]>([]);
  const [selectedFrame, setSelectedFrame] = useState<string | null>(null);
  const [inspectorKey, setInspectorKey] = useState<ItemKey | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [activeLinkId, setActiveLinkId] = useState<string | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(true);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dataRef = useRef<CanvasState | null>(null);
  /**
   * Positions **du geste en cours**, écrites dans `pointermove` (jamais via un effet).
   *
   * Mesuré : `dataRef` est synchronisé par un effet après le rendu. Quand le relâchement
   * suit le dernier `pointermove` sans qu'une image ait été rendue (glisser rapide, geste
   * automatisé), le commit lisait l'état **d'avant le glisser** et écrivait une position
   * périmée : le déplacement s'était bien affiché, mais un rechargement le défaisait.
   */
  const liveRef = useRef<{
    items: Map<ItemKey, World>;
    frames: Map<string, { x: number; y: number; width: number; height: number }>;
  }>({ items: new Map(), frames: new Map() });
  const viewRef = useRef(view);
  const selectionRef = useRef(selection);
  const marqueeRef = useRef<Rect | null>(null);
  const spaceRef = useRef(false);

  useEffect(() => {
    dataRef.current = data;
    viewRef.current = view;
    selectionRef.current = selection;
    marqueeRef.current = marquee;
  }, [data, view, selection, marquee]);

  const apply = useCallback((payload: CanvasPayload | null) => {
    if (payload) {
      setData({ frames: payload.frames, items: payload.items, links: payload.links });
      setDiscovery(payload.discovery);
      setSpaceState(payload.embeddingSpace ?? null);
      setError(null);
    }
  }, []);

  /** L'URL de l'état : le tableau demandé, l'atelier si absent. */
  const stateUrl = "/api/canvas" + (canvasId ? `?canvas=${encodeURIComponent(canvasId)}` : "");

  const load = useCallback(async () => {
    try {
      const res = await fetch(stateUrl);
      if (!res.ok) throw new Error(String(res.status));
      apply((await res.json()) as CanvasPayload);
    } catch {
      setError("Canvas indisponible — vérifiez que le serveur répond.");
    }
  }, [apply, stateUrl]);

  useEffect(() => {
    // chargement initial (setState asynchrone, hors rendu synchrone)
    void fetch(stateUrl)
      .then((res) => (res.ok ? (res.json() as Promise<CanvasPayload>) : null))
      .then((next) => {
        if (next) apply(next);
        else setError("Canvas indisponible — vérifiez que le serveur répond.");
      })
      .catch(() => setError("Canvas indisponible — vérifiez que le serveur répond."));
  }, [apply, stateUrl]);

  // l'IA travaille : on relit régulièrement, sinon les liens n'apparaîtraient qu'au
  // rechargement manuel — or c'est précisément ce qu'on attend après un dépôt
  useEffect(() => {
    if ((discovery?.pending ?? 0) + (discovery?.running ?? 0) === 0) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [discovery, load]);

  /* ---------------------------- coordonnées / vue ---------------------------- */

  const worldFromClient = useCallback((clientX: number, clientY: number): World => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - v.x) / v.zoom, y: (clientY - rect.top - v.y) / v.zoom };
  }, []);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    setView((v) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      if (next === v.zoom) return v;
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect || clientX === undefined || clientY === undefined) return { ...v, zoom: next };
      // le point sous le curseur reste sous le curseur
      const wx = (clientX - rect.left - v.x) / v.zoom;
      const wy = (clientY - rect.top - v.y) / v.zoom;
      return { zoom: next, x: clientX - rect.left - wx * next, y: clientY - rect.top - wy * next };
    });
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    // écouteur natif non passif : sinon le navigateur zoome la page entière
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
        return;
      }
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const fit = useCallback(() => {
    const current = dataRef.current;
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!current || !rect) return;
    const points: World[] = [
      ...current.items.flatMap((n) => {
        const s = itemSize(n.kind);
        return [
          { x: n.x, y: n.y },
          { x: n.x + s.w, y: n.y + s.h },
        ];
      }),
      ...current.frames.flatMap((f) => [
        { x: f.x, y: f.y },
        { x: f.x + f.width, y: f.y + f.height },
      ]),
    ];
    if (points.length === 0) {
      setView({ x: 40, y: 40, zoom: 1 });
      return;
    }
    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxX = Math.max(...points.map((p) => p.x));
    const maxY = Math.max(...points.map((p) => p.y));
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min(rect.width / (maxX - minX + 160), rect.height / (maxY - minY + 160))
      )
    );
    setView({ zoom, x: 80 - minX * zoom, y: 80 - minY * zoom });
  }, []);

  /**
   * Le **focalisé** (AC2) : une frame demandée par l'explorateur est centrée et
   * zoomée au premier chargement — pas au fil des relectures, sinon l'utilisateur
   * qui panerait serait ramené de force. Le zoom sature à 1 (une grande frame est
   * montrée entière, une petite est lue à taille réelle, jamais agrandie).
   */
  const focusedRef = useRef(false);
  useEffect(() => {
    if (focusedRef.current || !data || !focusFrameId) return;
    const frame = data.frames.find((f) => f.id === focusFrameId);
    if (!frame) return;
    focusedRef.current = true;
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = frame.x + frame.width / 2;
    const cy = frame.y + frame.height / 2;
    const zoom = Math.min(
      1,
      Math.max(
        MIN_ZOOM,
        Math.min(rect.width / (frame.width + 160), rect.height / (frame.height + 160))
      )
    );
    setView({ zoom, x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom });
    setSelectedFrame(frame.id);
  }, [data, focusFrameId]);

  /* -------------------------------- persistance ------------------------------ */

  const persistItems = useCallback(
    async (items: (ItemRef & { x: number; y: number; frame_id?: string | null })[]) => {
      if (items.length === 0) return;
      try {
        const res = await fetch("/api/canvas/nodes", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items }),
        });
        await settle(res);
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        setError("Déplacement non enregistré — rechargez le canvas.");
      }
    },
    []
  );

  const persistFrame = useCallback(
    async (id: string, patch: Record<string, number | string | null>, resync = false) => {
      try {
        const res = await fetch(`/api/canvas/frames/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        await settle(res);
        if (!res.ok) throw new Error(String(res.status));
        // un déplacement de conteneur décale ses membres côté serveur : on relit
        // la vérité au lieu de rejouer le même décalage ici
        if (resync) await load();
      } catch {
        setError("Conteneur non enregistré — rechargez le canvas.");
      }
    },
    [load]
  );

  const containingFrame = useCallback(
    (item: { x: number; y: number; kind: CanvasItemKind }, frames: CanvasFrame[]) => {
      const s = itemSize(item.kind);
      const cx = item.x + s.w / 2;
      const cy = item.y + s.h / 2;
      const hit = frames
        .filter((f) => cx >= f.x && cx <= f.x + f.width && cy >= f.y && cy <= f.y + f.height)
        .sort((a, b) => b.z - a.z);
      return hit[0]?.id ?? null;
    },
    []
  );

  /* ------------------------------- fin de geste ------------------------------ */

  const endDrag = useCallback(
    async (current: Drag, moved: boolean) => {
      // **indispensable** : sans cette remise à zéro, le geste précédent reste
      // attaché aux écouteurs `pointermove` et le prochain mouvement de souris
      // rejoue son commit (constaté : un PATCH déclenché par un glisser de
      // conteneur, avec les positions de l'ancienne sélection)
      setDrag(null);
      const live = liveRef.current;
      if (current.kind === "items") {
        const state = dataRef.current;
        if (!state) return;
        const items: (ItemRef & { x: number; y: number; frame_id: string | null })[] = [];
        for (const key of current.origins.keys()) {
          const ref = refOf(key);
          const item = state.items.find((n) => n.kind === ref.kind && n.ref === ref.ref);
          if (!item) continue;
          // la position du geste fait foi ; `state` n'est que le repli
          const at = live.items.get(key) ?? { x: item.x, y: item.y };
          items.push({
            kind: item.kind,
            ref: item.ref,
            x: at.x,
            y: at.y,
            // appartenance déduite de la géométrie : déposer hors d'un conteneur
            // l'en retire, l'y déposer l'y range
            frame_id: containingFrame({ ...item, x: at.x, y: at.y }, state.frames),
          });
        }
        if (moved) await persistItems(items);
        return;
      }
      if (current.kind === "frame") {
        const frame = dataRef.current?.frames.find((f) => f.id === current.id);
        const at = live.frames.get(current.id) ?? frame;
        if (at && moved) await persistFrame(current.id, { x: at.x, y: at.y }, true);
        return;
      }
      if (current.kind === "resize") {
        const frame = dataRef.current?.frames.find((f) => f.id === current.id);
        const at = live.frames.get(current.id) ?? frame;
        if (at) await persistFrame(current.id, { width: at.width, height: at.height });
        return;
      }
      if (current.kind === "marquee") {
        const state = dataRef.current;
        const box = marqueeRef.current;
        if (state && box && (box.w > 2 || box.h > 2)) {
          setSelection(
            state.items
              .filter((n) => {
                const s = itemSize(n.kind);
                return intersects(box, { x: n.x, y: n.y, w: s.w, h: s.h });
              })
              .map(keyOf)
          );
          setSelectedFrame(null);
        }
        setMarquee(null);
      }
    },
    [containingFrame, persistFrame, persistItems]
  );

  useEffect(() => {
    if (!drag) return;
    let moved = false;

    const onMove = (e: PointerEvent) => {
      moved = true;
      const world = worldFromClient(e.clientX, e.clientY);

      if (drag.kind === "pan") {
        setView((v) => ({
          ...v,
          x: drag.viewOrigin.x + (e.clientX - drag.startClient.x),
          y: drag.viewOrigin.y + (e.clientY - drag.startClient.y),
        }));
        return;
      }
      if (drag.kind === "items") {
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        for (const [key, o] of drag.origins) liveRef.current.items.set(key, { x: o.x + dx, y: o.y + dy });
        setData((d) =>
          d
            ? {
                ...d,
                items: d.items.map((n) => {
                  const o = drag.origins.get(keyOf(n));
                  return o ? { ...n, x: o.x + dx, y: o.y + dy } : n;
                }),
              }
            : d
        );
        return;
      }
      if (drag.kind === "frame") {
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        liveRef.current.frames.set(drag.id, {
          x: drag.origin.x + dx,
          y: drag.origin.y + dy,
          width: 0,
          height: 0,
        });
        setData((d) =>
          d
            ? {
                frames: d.frames.map((f) =>
                  f.id === drag.id ? { ...f, x: drag.origin.x + dx, y: drag.origin.y + dy } : f
                ),
                // les membres suivent à l'écran ; le serveur appliquera le même
                // décalage et `resync` relira sa version
                items: d.items.map((n) => {
                  const o = drag.memberOrigins.get(keyOf(n));
                  return o ? { ...n, x: o.x + dx, y: o.y + dy } : n;
                }),
                links: d.links,
              }
            : d
        );
        return;
      }
      if (drag.kind === "resize") {
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        const width = Math.max(RESIZE_MIN_W, drag.size.w + dx);
        const height = Math.max(RESIZE_MIN_H, drag.size.h + dy);
        liveRef.current.frames.set(drag.id, { x: 0, y: 0, width, height });
        setData((d) =>
          d
            ? {
                ...d,
                frames: d.frames.map((f) =>
                  f.id === drag.id ? { ...f, width, height } : f
                ),
              }
            : d
        );
        return;
      }
      setMarquee(rectOf(drag.startWorld, world));
    };

    const onUp = () => void endDrag(drag, moved);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, endDrag, worldFromClient]);

  /* ---------------------------------- gestes --------------------------------- */

  const onSurfacePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      e.preventDefault();
      setDrag({
        kind: "pan",
        startClient: { x: e.clientX, y: e.clientY },
        viewOrigin: { x: viewRef.current.x, y: viewRef.current.y },
      });
      return;
    }
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    const onBackground =
      e.target === e.currentTarget ||
      el.dataset.canvasBackground === "true" ||
      el.dataset.canvasLayer === "true";
    if (!onBackground) return;
    if (!e.shiftKey) {
      setSelection([]);
      setSelectedFrame(null);
    }
    const startWorld = worldFromClient(e.clientX, e.clientY);
    setMarquee({ x: startWorld.x, y: startWorld.y, w: 0, h: 0 });
    setDrag({ kind: "marquee", startWorld });
  };

  const onItemPointerDown = (e: React.PointerEvent<HTMLDivElement>, item: CanvasItem) => {
    if (e.button !== 0 || spaceRef.current) return;
    e.stopPropagation();
    setSelectedFrame(null);
    const key = keyOf(item);
    let effective = selectionRef.current;
    if (e.shiftKey) {
      effective = effective.includes(key) ? effective.filter((k) => k !== key) : [...effective, key];
    } else if (!effective.includes(key)) {
      effective = [key];
    }
    setSelection(effective);

    const state = dataRef.current;
    if (!state) return;
    const origins = new Map<ItemKey, World>();
    for (const k of effective) {
      const ref = refOf(k);
      const n = state.items.find((x) => x.kind === ref.kind && x.ref === ref.ref);
      if (n) origins.set(k, { x: n.x, y: n.y });
    }
    liveRef.current.items.clear();
    liveRef.current.frames.clear();
    setDrag({ kind: "items", startWorld: worldFromClient(e.clientX, e.clientY), origins });
  };

  const onFramePointerDown = (e: React.PointerEvent<HTMLDivElement>, frame: CanvasFrame) => {
    if (e.button !== 0 || spaceRef.current) return;
    e.stopPropagation();
    setSelectedFrame(frame.id);
    setSelection([]);
    const memberOrigins = new Map<ItemKey, World>();
    for (const n of dataRef.current?.items ?? []) {
      if (n.frame_id === frame.id) memberOrigins.set(keyOf(n), { x: n.x, y: n.y });
    }
    liveRef.current.items.clear();
    liveRef.current.frames.clear();
    setDrag({
      kind: "frame",
      id: frame.id,
      startWorld: worldFromClient(e.clientX, e.clientY),
      origin: { x: frame.x, y: frame.y },
      memberOrigins,
    });
  };

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>, frame: CanvasFrame) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedFrame(frame.id);
    liveRef.current.items.clear();
    liveRef.current.frames.clear();
    setDrag({
      kind: "resize",
      id: frame.id,
      startWorld: worldFromClient(e.clientX, e.clientY),
      size: { w: frame.width, h: frame.height },
    });
  };

  /* ------------------------------- nudge clavier ----------------------------- */

  const onItemKeyDown = async (e: React.KeyboardEvent<HTMLDivElement>, item: CanvasItem) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setInspectorKey(keyOf(item));
      return;
    }
    const step = e.shiftKey ? 1 : 10;
    const delta =
      e.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : e.key === "ArrowRight"
          ? { x: step, y: 0 }
          : e.key === "ArrowUp"
            ? { x: 0, y: -step }
            : e.key === "ArrowDown"
              ? { x: 0, y: step }
              : null;
    if (!delta) return;
    e.preventDefault();
    const state = dataRef.current;
    if (!state) return;
    const keys = selectionRef.current.includes(keyOf(item)) ? selectionRef.current : [keyOf(item)];
    const items = keys
      .map((k) => {
        const ref = refOf(k);
        return state.items.find((n) => n.kind === ref.kind && n.ref === ref.ref);
      })
      .filter((n): n is CanvasItem => !!n)
      .map((n) => {
        const moved = { ...n, x: n.x + delta.x, y: n.y + delta.y };
        return {
          kind: n.kind,
          ref: n.ref,
          x: moved.x,
          y: moved.y,
          frame_id: containingFrame(moved, state.frames),
        };
      });
    setData((d) =>
      d
        ? {
            ...d,
            items: d.items.map((n) => {
              const patch = items.find((i) => i.kind === n.kind && i.ref === n.ref);
              return patch ? { ...n, x: patch.x, y: patch.y, frame_id: patch.frame_id } : n;
            }),
          }
        : d
    );
    await persistItems(items);
  };

  /* ------------------------------- conteneurs -------------------------------- */

  const createContainer = async (kind: "frame" | "group") => {
    const state = dataRef.current;
    if (!state) return;
    const v = viewRef.current;
    const selected = state.items.filter((n) => selection.includes(keyOf(n)));

    let box: Rect = {
      x: (-v.x + 120) / v.zoom,
      y: (-v.y + 120) / v.zoom,
      w: FRAME_DEFAULT_WIDTH,
      h: FRAME_DEFAULT_HEIGHT,
    };
    if (selected.length > 0) {
      const minX = Math.min(...selected.map((n) => n.x)) - PADDING;
      const minY = Math.min(...selected.map((n) => n.y)) - PADDING - 24;
      const maxX = Math.max(...selected.map((n) => n.x + itemSize(n.kind).w)) + PADDING;
      const maxY = Math.max(...selected.map((n) => n.y + itemSize(n.kind).h)) + PADDING;
      box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    try {
      const res = await fetch("/api/canvas/frames", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          label: kind === "group" ? "Groupe" : "Cadre",
          x: box.x,
          y: box.y,
          width: box.w,
          height: box.h,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const frame = (await res.json()) as CanvasFrame;
      if (selected.length > 0) {
        const assigned = await fetch(`/api/canvas/frames/${frame.id}/members`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: selected.map((n) => ({ kind: n.kind, ref: n.ref })),
          }),
        });
        await settle(assigned);
        // un conteneur créé mais vide serait un demi-succès silencieux : la sélection
        // affichée aurait l'air rangée alors qu'elle ne l'est pas
        if (!assigned.ok) throw new Error(String(assigned.status));
      }
      await load();
      setSelection([]);
      setSelectedFrame(frame.id);
      setNotice(
        selected.length > 0
          ? `${kind === "group" ? "Groupe" : "Cadre"} créé avec ${selected.length} élément(s) — déplacez-le, ils suivent.`
          : `${kind === "group" ? "Groupe" : "Cadre"} vide créé — sélectionnez des éléments puis « Grouper », ou glissez-les dedans.`
      );
    } catch {
      setError("Création du conteneur refusée par le serveur.");
    }
  };

  const dissolveFrame = async (id: string) => {
    try {
      const res = await fetch(`/api/canvas/frames/${id}`, { method: "DELETE" });
      await settle(res);
      if (!res.ok) throw new Error(String(res.status));
      setSelectedFrame(null);
      setNotice("Conteneur dissous — les éléments restent exactement où ils étaient.");
      await load();
    } catch {
      setError("Dissolution refusée par le serveur.");
    }
  };

  const ungroup = async (item: CanvasItem) => {
    if (!item.frame_id) return;
    const res = await fetch(`/api/canvas/frames/${item.frame_id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ kind: item.kind, ref: item.ref }],
        assign: false,
      }),
    });
    await settle(res);
    if (!res.ok) {
      setError("Retrait refusé par le serveur — rechargez le canvas.");
      return;
    }
    await load();
  };

  /* ------------------------------- import fichiers --------------------------- */

  /**
   * Déposer des fichiers : ils sont créés comme sources, posés **là où ils ont été
   * lâchés** (`canvas_x`/`canvas_y`), et leur ingestion déclenche la recherche de
   * liens côté serveur. Le poll prend le relais pour faire apparaître les liens.
   */
  const importFiles = async (files: FileList | File[], at: World | null) => {
    const list = [...files];
    if (list.length === 0) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    let created = 0;
    const problems: string[] = [];
    for (const [index, file] of list.entries()) {
      const form = new FormData();
      form.set("type", file.name.toLowerCase().endsWith(".pdf") ? "PDF" : "TEXT");
      form.set("file", file);
      if (at) {
        // en cascade pour que deux fichiers lâchés ensemble ne se superposent pas
        form.set("canvas_x", String(Math.round(at.x + index * 32)));
        form.set("canvas_y", String(Math.round(at.y + index * 32)));
      }
      try {
        const res = await fetch("/api/sources", { method: "POST", body: form });
        if (res.status === 201) created += 1;
        else if (res.status === 409) problems.push(`${file.name} : déjà présent`);
        else if (res.status === 422) problems.push(`${file.name} : PDF sans texte extractible`);
        else problems.push(`${file.name} : refusé (${res.status})`);
      } catch {
        problems.push(`${file.name} : envoi impossible`);
      }
    }
    setImporting(false);
    if (created > 0) {
      setNotice(
        `${created} fichier(s) déposé(s) — ingestion et résumé en cours, puis l'analyse cherchera leurs liens.`
      );
      await load();
    }
    if (problems.length > 0) setError(problems.join(" · "));
  };

  /* ---------------------------------- liens ---------------------------------- */

  const linkSources = useMemo(() => {
    const titles: Record<string, string> = {};
    for (const item of data?.items ?? []) {
      if (item.kind === "source") titles[item.ref] = item.source.title ?? item.ref.slice(0, 8);
    }
    return titles;
  }, [data]);

  /** Milieu des deux fichiers reliés : la construction acceptée naît entre eux. */
  const midpointOf = useCallback((link: CanvasLink): World | null => {
    const state = dataRef.current;
    if (!state) return null;
    const a = state.items.find((i) => i.kind === "source" && i.ref === link.from_source_id);
    const b = state.items.find((i) => i.kind === "source" && i.ref === link.to_source_id);
    if (!a || !b) return null;
    const sa = itemSize("source");
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2 + (Math.random() < 0.5 ? 0 : sa.h + 24),
    };
  }, []);

  const openLink = async (link: CanvasLink) => {
    // affichage optimiste, mais l'échec **n'est pas silencieux** : la métrique
    // « ≥ 40 % de suggestions ouvertes » se lit en base
    setData((d) =>
      d
        ? {
            ...d,
            links: d.links.map((l) => (l.id === link.id ? { ...l, state: "opened" as const } : l)),
          }
        : d
    );
    try {
      const res = await fetch(`/api/suggestions/${link.id}/open`, { method: "POST" });
      await settle(res);
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setData((d) =>
        d
          ? { ...d, links: d.links.map((l) => (l.id === link.id ? { ...l, state: link.state } : l)) }
          : d
      );
      setError("Ouverture non enregistrée (le serveur n'a pas répondu).");
    }
  };

  const acceptLink = async (link: CanvasLink) => {
    setBusyLinkId(link.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/suggestions/${link.id}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(midpointOf(link) ?? {}),
      });
      const body = (await res.json().catch(() => null)) as ConstructionItem | null;
      if (res.status === 201 && body) {
        setNotice(
          `Lien intégré : la construction apparaît sur le plan (${body.parent_source_ids.length} sources, ` +
            `${body.evidence_fragment_ids.length} preuves, statut ${body.epistemic_status}).`
        );
        await load();
      } else if (res.status === 409) {
        setNotice("Ce lien a déjà été intégré.");
        await load();
      } else {
        setError("Intégration refusée par le serveur.");
      }
    } catch {
      setError("Intégration impossible — le serveur n'a pas répondu.");
    } finally {
      setBusyLinkId(null);
    }
  };

  const rejectLink = async (link: CanvasLink, reason: FeedbackReason) => {
    setBusyLinkId(link.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/suggestions/${link.id}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback_reason: reason }),
      });
      await settle(res);
      if (!res.ok) throw new Error(String(res.status));
      setNotice("Lien rejeté — il ne réapparaîtra pas, y compris reformulé.");
      await load();
    } catch {
      setError("Rejet refusé par le serveur.");
    } finally {
      setBusyLinkId(null);
    }
  };

  /* --------------------------------- rendu ---------------------------------- */

  const memberCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of data?.items ?? []) {
      if (n.frame_id) counts.set(n.frame_id, (counts.get(n.frame_id) ?? 0) + 1);
    }
    return counts;
  }, [data]);

  const inspectorItem =
    data?.items.find((n) => inspectorKey === keyOf(n)) ?? null;
  const inspectorFrame = data?.frames.find((f) => f.id === inspectorItem?.frame_id) ?? null;

  const activeLink = data?.links.find((l) => l.id === activeLinkId) ?? null;
  const highlighted = useMemo(() => {
    const set = new Set<string>();
    if (!activeLink) return set;
    set.add(`source:${activeLink.from_source_id}`);
    set.add(`source:${activeLink.to_source_id}`);
    return set;
  }, [activeLink]);

  const busy = (discovery?.pending ?? 0) + (discovery?.running ?? 0) > 0;

  return (
    <div className="flex flex-col gap-3 xl:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom arrière">
            <Minus />
          </Button>
          <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(view.zoom * 100)} %
          </span>
          <Button variant="outline" size="sm" onClick={() => zoomAt(1.2)} aria-label="Zoom avant">
            <Plus />
          </Button>
          <Button variant="outline" size="sm" onClick={fit}>
            <Maximize />
            Ajuster
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button
            size="sm"
            variant="secondary"
            disabled={selection.length === 0}
            onClick={() => void createContainer("group")}
            title="Créer un groupe à partir de la sélection"
          >
            <Group />
            Grouper ({selection.length})
          </Button>
          <Button size="sm" variant="outline" onClick={() => void createContainer("frame")}>
            <Frame />
            Cadre
          </Button>
          {selectedFrame ? (
            <Button size="sm" variant="ghost" onClick={() => void dissolveFrame(selectedFrame)}>
              Dissoudre
            </Button>
          ) : null}
          <span className="mx-1 h-5 w-px bg-border" />
          <Button
            size="sm"
            variant="outline"
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
          >
            {importing ? <Loader2 className="animate-spin" /> : <Upload />}
            Déposer des fichiers
          </Button>
          <Button
            variant={showLinks ? "default" : "outline"}
            size="sm"
            aria-pressed={showLinks}
            onClick={() => setShowLinks((v) => !v)}
            title="Afficher ou masquer les liens proposés"
          >
            <Link2 />
            Liens
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            aria-label="Recharger le canvas"
          >
            <RefreshCw />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept=".txt,.md,.pdf,text/plain,application/pdf"
            onChange={(e) => {
              if (e.target.files) void importFiles(e.target.files, null);
              e.target.value = "";
            }}
          />
        </div>

        {/* Une bascule de connecteur d'embeddings non suivie d'une re-vectorisation
            laisse deux espaces incomparables en base. Le dire ici évite de croire que
            toute la bibliothèque participe à l'analyse alors que l'IA en ignore une
            partie — et de chercher pourquoi un fichier ne reçoit jamais de lien. */}
        {spaceState && spaceState.error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              Connecteur d&apos;embeddings mal configuré : {spaceState.error}
            </span>
          </p>
        ) : null}
        {spaceState && !spaceState.error && !spaceState.aligned && spaceState.outOfSpace > 0 ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>
              <strong>{spaceState.outOfSpaceSources}</strong> fichier(s) —{" "}
              <strong>{spaceState.outOfSpace}</strong> fragments — ne sont pas dans l&apos;espace
              vectoriel actif ({spaceState.active.model}, {spaceState.active.dimensions} dims).
              L&apos;analyse ne peut pas les comparer au reste tant qu&apos;ils n&apos;y sont pas :
              lance <code className="rounded bg-muted px-1">{EMBEDDING_SPACE_COMMAND}</code> dans le
              projet (dans les deux sens, la même commande).
            </span>
          </p>
        ) : null}

        {notice ? (
          <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <div
          ref={surfaceRef}
          onPointerDown={onSurfacePointerDown}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const at = worldFromClient(e.clientX, e.clientY);
            if (e.dataTransfer?.files) void importFiles(e.dataTransfer.files, at);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSelection([]);
              setSelectedFrame(null);
              setInspectorKey(null);
              setActiveLinkId(null);
            }
          }}
          tabIndex={0}
          aria-label="Plan de travail"
          className="relative h-[74vh] min-h-[440px] overflow-hidden rounded-xl border border-border bg-muted/20 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          style={{ touchAction: "none" }}
        >
          <div
            data-canvas-background="true"
            className="absolute inset-0"
            style={{
              backgroundImage:
                "radial-gradient(circle, color-mix(in oklch, var(--foreground) 18%, transparent) 1px, transparent 1px)",
              backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
              backgroundPosition: `${view.x}px ${view.y}px`,
            }}
          />

          <div
            data-canvas-layer="true"
            className="absolute top-0 left-0 origin-top-left"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          >
            {(data?.frames ?? []).map((frame) => (
              <CanvasFrameBox
                key={frame.id}
                frame={frame}
                memberCount={memberCounts.get(frame.id) ?? 0}
                selected={selectedFrame === frame.id}
                onPointerDown={onFramePointerDown}
                onResizePointerDown={onResizePointerDown}
                onSelect={(f) => {
                  setSelectedFrame(f.id);
                  setSelection([]);
                }}
                onLabelCommit={(f, label) => void persistFrame(f.id, { label })}
              />
            ))}

            {showLinks && data ? (
              <CanvasEdges
                items={data.items}
                links={data.links}
                activeLinkId={activeLinkId}
                onHoverLink={setActiveLinkId}
                onSelectLink={setActiveLinkId}
              />
            ) : null}

            {[...(data?.items ?? [])]
              .sort((a, b) => a.z - b.z)
              .map((item) => (
                <CanvasItemCard
                  key={keyOf(item)}
                  item={item}
                  selected={selection.includes(keyOf(item))}
                  highlighted={highlighted.has(keyOf(item))}
                  onPointerDown={onItemPointerDown}
                  onOpen={(n) => setInspectorKey(keyOf(n))}
                  onKeyDown={(e, n) => void onItemKeyDown(e, n)}
                />
              ))}

            {marquee ? (
              <div
                className="absolute border border-primary/60 bg-primary/10"
                style={{
                  left: marquee.x,
                  top: marquee.y,
                  width: marquee.w,
                  height: marquee.h,
                  pointerEvents: "none",
                }}
              />
            ) : null}
          </div>

          {data && data.items.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <Sparkles className="size-6 text-muted-foreground" />
              <p className="font-medium">Votre plan de travail est vide</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Glissez des fichiers (<code>.md</code>, <code>.txt</code>, <code>.pdf</code>) ici :
                ils se poseront à l&apos;endroit où vous les lâchez, et l&apos;analyse cherchera
                ensuite leurs liens. Déplacez-les, groupez-les, encadrez-les — les positions sont
                enregistrées.
              </p>
            </div>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          Glisser sur le fond = lasso · Espace + glisser, bouton du milieu ou molette = pan ·
          Ctrl/Cmd + molette = zoom · glisser un élément = déplacer la sélection · glisser un
          conteneur = déplacer son contenu · clic sur une arête = son lien · flèches = 10 px
          (Maj = 1 px) · double-clic = détail et provenance.
        </p>
      </div>

      <div className="flex w-full min-w-0 flex-col gap-3 xl:w-auto">
        <LinkPanel
          links={data?.links ?? []}
          sourceTitles={linkSources}
          activeLinkId={activeLinkId}
          busyId={busyLinkId}
          discovery={discovery}
          onHoverLink={setActiveLinkId}
          onOpened={(link) => void openLink(link)}
          onAccept={(link) => void acceptLink(link)}
          onReject={(link, reason) => void rejectLink(link, reason)}
        />
        <CanvasInspector
          item={inspectorItem}
          frame={inspectorFrame}
          onClose={() => setInspectorKey(null)}
          onUngroup={() => inspectorItem && void ungroup(inspectorItem)}
        />
        {busy && !notice ? (
          <p className="text-xs text-muted-foreground">
            L&apos;analyse tourne en tâche de fond : vous pouvez continuer à organiser le plan.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------- helpers -------------------------------- */

/**
 * Consomme le corps d'une réponse dont on ne lit rien.
 *
 * Mesuré : sans cela, un `DELETE` qui répond **204** apparaît à la fois comme une
 * réponse reçue et comme une requête abandonnée (`net::ERR_ABORTED`) — la connexion
 * reste en suspens et Chromium la clôt en signalant un abandon.
 */
async function settle(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    // corps déjà consommé ou flux fermé : sans conséquence ici
  }
}

function rectOf(a: World, b: World): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
