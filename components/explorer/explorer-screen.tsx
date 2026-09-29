"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  Folder,
  Loader2,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CANVAS_COLORS,
  canvasColorClass,
  type ExplorerSnapshot,
} from "@/lib/api-types";

/**
 * L'explorateur (v1.6 §14, étape 2) — la coquille de navigation sur les tableaux.
 *
 * Trois volets, la géométrie de la maquette validée (`docs/mockups/v16-explorer.html`) :
 *  - la **nav** à gauche (Tableaux actif, les pages existantes servies) + épinglés
 *    et conversations récentes ;
 *  - le **centre** : les tableaux en dossiers — **un clic ouvre le tableau** et
 *    affiche son canvas (la vignette du plan, AC2 : positions réelles, cliquable) ;
 *  - l'**aperçu** à droite : le poste de pilotage (détail, liens, actions IA).
 *
 * L'écran **ne calcule rien** : tout vient du snapshot (`GET /api/explorer`), rechargé
 * après chaque geste. Les actions mènent aux écrans existants — l'explorateur ne les
 * réinvente pas (§14.6). Les erreurs sont nommées (l'atelier refusé, un canvas inconnu),
 * jamais avalées.
 */

type Snapshot = ExplorerSnapshot;

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "hier" : `il y a ${days} j`;
}

export function ExplorerScreen() {
  const router = useRouter();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // la vue : la grille des dossiers, ou l'intérieur d'un tableau
  const [openCanvasId, setOpenCanvasId] = useState<string | null>(null);
  // l'objet sélectionné (aperçu) : une construction, une frame, une conversation…
  const [sel, setSel] = useState<{ kind: "node" | "frame" | "canvas" | "conversation"; id: string } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [convOpen, setConvOpen] = useState(false);
  const [convTarget, setConvTarget] = useState<string | null>(null);

  // `load` est **pur** : il rend le snapshot ou jette, sans setState — les appels
  // décident. L'effet de montage pose ses setState dans le `.then` (jamais avant
  // un await : react-hooks/set-state-in-effect), les gestes d'écriture via `act`.
  const load = useCallback(async (): Promise<Snapshot> => {
    const res = await fetch("/api/explorer", { cache: "no-store" });
    if (!res.ok) throw new Error(`explorateur : ${res.status}`);
    return (await res.json()) as Snapshot;
  }, []);

  useEffect(() => {
    let alive = true;
    load()
      .then((d) => {
        if (!alive) return;
        setSnap(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const canvases = useMemo(() => snap?.canvases ?? [], [snap]);
  const open = openCanvasId ? canvases.find((c) => c.id === openCanvasId) ?? null : null;
  const pinned = canvases.filter((c) => c.pinned);
  const conversations = useMemo(
    () =>
      [...canvases]
        .flatMap((c) => c.conversations.map((v) => ({ ...v, canvasId: c.id })))
        .reduce<{ id: string; title: string; updated_at: string; canvasId: string }[]>((acc, v) => {
          if (!acc.some((x) => x.id === v.id)) acc.push(v);
          return acc;
        }, [])
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, 6),
    [canvases]
  );

  /** Un geste d'écriture : l'écran recharge le snapshot après — la base reste la vérité. */
  const act = useCallback(
    async (fn: () => Promise<Response>, ok?: (body: unknown) => void) => {
      setNotice(null);
      try {
        const res = await fn();
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `échec (${res.status})`);
          return false;
        }
        const body = await res.json().catch(() => null);
        ok?.(body);
        setSnap(await load());
        setError(null);
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [load]
  );

  /** Le bouton « Réessayer » : même geste que l'effet de montage, depuis un clic. */
  const retry = useCallback(() => {
    void load()
      .then((d) => {
        setSnap(d);
        setError(null);
      })
      .catch((e: unknown) => {
        setError((e as Error).message);
      });
  }, [load]);

  const togglePin = (id: string, pinnedNow: boolean) =>
    void act(() =>
      fetch(`/api/canvases?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: !pinnedNow }),
      })
    );

  const cycleColor = (id: string, current: string | null) => {
    const idx = CANVAS_COLORS.indexOf(current as (typeof CANVAS_COLORS)[number]);
    const next = idx === CANVAS_COLORS.length - 1 ? null : (CANVAS_COLORS[(idx + 1) % CANVAS_COLORS.length] ?? null);
    void act(() =>
      fetch(`/api/canvases?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color: next }),
      })
    );
  };

  const rename = async (id: string, label: string) => {
    const next = window.prompt("Renommer le tableau :", label);
    if (!next || !next.trim() || next.trim() === label) return;
    await act(() =>
      fetch(`/api/canvases?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: next.trim() }),
      })
    );
  };

  const remove = async (id: string, label: string, isDefault: boolean, frames: number, convs: number) => {
    if (isDefault) {
      setNotice("L'atelier n'est pas supprimable — c'est le réceptacle des détachements.");
      return;
    }
    const message =
      `Supprimer « ${label} » ?\n\n` +
      `${frames} frame(s) seront dissoute(s), les objets rangés dedans restent visibles « hors frame » dans l'atelier.\n` +
      `${convs} conversation(s) seront déliée(s) — elles restent, hors tableau.\n\nCette action est irréversible.`;
    if (!window.confirm(message)) return;
    await act(
      () => fetch(`/api/canvases?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
      (body) => {
        const detached = (body as { detached?: { frames: number; conversations: number } }).detached;
        if (detached) {
          setNotice(
            `« ${label} » supprimé — ${detached.frames} frame(s) dissoute(s), ${detached.conversations} conversation(s) déliée(s) (aucun objet supprimé).`
          );
        }
      }
    );
    if (openCanvasId === id) {
      setOpenCanvasId(null);
      setSel(null);
    }
  };

  if (error && !snap) {
    return (
      <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-16 text-center">
        <p className="text-sm text-destructive">Explorateur indisponible : {error}</p>
        <Button variant="outline" className="mt-4" onClick={retry}>
          <RefreshCw className="mr-2 size-4" /> Réessayer
        </Button>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="flex flex-1 items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Chargement des tableaux…
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* ═══════════ colonne 1 : la nav ═══════════ */}
      <aside className="w-60 shrink-0 border-r border-border px-3 py-4 overflow-y-auto">
        <p className="px-2 pb-2 text-sm font-semibold tracking-tight">Sérendipité</p>
        <nav className="space-y-0.5 text-sm" aria-label="Navigation principale">
          <span className="block rounded-md bg-muted px-2.5 py-1.5 font-medium">🗂 Tableaux</span>
          <Link href="/sources" className="block rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            📄 Bibliothèque
          </Link>
          <Link href="/suggestions" className="block rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            🧭 Connexions
          </Link>
          <Link href="/syntheses" className="block rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            🧩 Synthèses
          </Link>
          <Link href="/conversation" className="block rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            💬 Conversation
          </Link>
        </nav>

        <p className="mt-5 px-2 text-[11px] uppercase tracking-wider text-muted-foreground">Épinglés</p>
        <div className="mt-1 space-y-0.5">
          {pinned.map((c) => (
            <button
              key={c.id}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setOpenCanvasId(c.id);
                setSel(null);
              }}
            >
              <span className={`size-2.5 shrink-0 rounded-sm ${canvasColorClass(c.color)}`} />
              <span className="truncate">{c.label}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">{c.totals.constructions + c.totals.sources}</span>
            </button>
          ))}
          {pinned.length === 0 && <p className="px-2.5 text-xs text-muted-foreground">Rien d&apos;épinglé — survolez un dossier puis ★</p>}
        </div>

        <p className="mt-5 px-2 text-[11px] uppercase tracking-wider text-muted-foreground">Conversations récentes</p>
        <div className="mt-1 space-y-0.5">
          {conversations.map((v) => (
            <button
              key={v.id}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setSel({ kind: "conversation", id: v.id })}
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="truncate">{v.title}</span>
            </button>
          ))}
          {conversations.length === 0 && <p className="px-2.5 text-xs text-muted-foreground">Aucune conversation.</p>}
        </div>
      </aside>

      {/* ═══════════ colonne 2 : dossiers OU canvas ═══════════ */}
      <section className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
        {open === null ? (
          <>
            <div className="mb-4 flex items-baseline gap-3">
              <h1 className="text-xl font-semibold tracking-tight">Tableaux</h1>
              <span className="text-xs text-muted-foreground">
                {canvases.length} tableau(x) · {canvases.reduce((n, c) => n + c.totals.conversations, 0)} conversation(s)
              </span>
              <Button size="sm" className="ml-auto" onClick={() => setNewOpen(true)}>
                <Plus className="mr-1 size-4" /> Nouveau tableau
              </Button>
            </div>
            {notice && <p className="mb-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{notice}</p>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {canvases.map((c) => (
                <div
                  key={c.id}
                  className="group relative cursor-pointer rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
                  onClick={() => {
                    setOpenCanvasId(c.id);
                    setSel(null);
                  }}
                  title="Cliquer : ouvrir le tableau"
                >
                  <div className="absolute right-2 top-2 hidden gap-0.5 group-hover:flex">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 bg-card"
                      title={c.pinned ? "Désépingler" : "Épingler"}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(c.id, c.pinned);
                      }}
                    >
                      {c.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 bg-card"
                      title="Étiquette suivante"
                      onClick={(e) => {
                        e.stopPropagation();
                        cycleColor(c.id, c.color);
                      }}
                    >
                      <span className={`size-3 rounded-sm ${canvasColorClass(c.color)}`} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 bg-card"
                      title="Renommer"
                      onClick={(e) => {
                        e.stopPropagation();
                        void rename(c.id, c.label);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    {!c.is_default && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 bg-card text-destructive"
                        title="Supprimer"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(c.id, c.label, c.is_default, c.totals.frames, c.totals.conversations);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                  <Folder className={`mb-3 size-9 ${canvasColorClass(c.color)} rounded-md p-1.5 text-white`} fill="currentColor" />
                  <p className="text-sm font-medium">
                    {c.label}
                    {c.is_default && <span className="ml-1 text-xs font-normal text-muted-foreground">(atelier)</span>}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {c.totals.frames} frame(s) · {c.totals.constructions + c.totals.sources} objet(s)
                    <br />
                    {c.totals.conversations > 0 ? `${c.totals.conversations} conversation(s)` : "aucune conversation"}
                  </p>
                  <p className="mt-1 hidden text-[11px] text-muted-foreground group-hover:block">cliquer pour ouvrir ↵</p>
                </div>
              ))}
              <button
                className="flex min-h-[128px] items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-border text-sm text-muted-foreground hover:border-foreground hover:text-foreground"
                onClick={() => setNewOpen(true)}
              >
                <Plus className="size-4" /> Nouveau tableau
              </button>
            </div>

            {snap.recent.length > 0 && (
              <div className="mt-8">
                <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">Récemment touchés</p>
                {snap.recent.map((e) => (
                  <button
                    key={`${e.kind}:${e.id}`}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      if (e.kind === "canvas") {
                        setOpenCanvasId(e.id);
                        setSel(null);
                      } else if (e.kind === "conversation") setSel({ kind: "conversation", id: e.id });
                      else if (e.kind === "synthesis") router.push(`/syntheses#${e.id}`);
                    }}
                  >
                    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                      {e.kind}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                    <span className="text-[11px] text-muted-foreground">{relTime(e.at)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <Button size="sm" variant="outline" onClick={() => setOpenCanvasId(null)}>
                <ArrowLeft className="mr-1 size-4" /> Tableaux
              </Button>
              <h1 className="text-xl font-semibold tracking-tight">
                {open.label}
                {open.is_default && <span className="ml-2 text-xs font-normal text-muted-foreground">(atelier)</span>}
              </h1>
              <span className="text-xs text-muted-foreground">
                {open.totals.frames} frame(s) · {open.totals.constructions + open.totals.sources} objet(s) ·{" "}
                {open.totals.conversations} conversation(s)
              </span>
              <Button size="sm" variant="outline" className="ml-auto" asChild>
                <Link href={`/canvas/${open.id}`}>Ouvrir dans l&apos;atelier</Link>
              </Button>
              <Button size="sm" onClick={() => {
                setConvTarget(open.id);
                setConvOpen(true);
              }}>
                <MessageSquare className="mr-1 size-4" /> Conversation
              </Button>
            </div>
            {notice && <p className="mb-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{notice}</p>}

            {/* les frames dépliables, puis la vignette du plan (AC2) */}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {open.frames.map((f) => (
                <Button
                  key={f.id}
                  size="sm"
                  variant={sel?.kind === "frame" && sel.id === f.id ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => setSel({ kind: "frame", id: f.id })}
                >
                  ▦ {f.label} · {f.constructions + f.sources}
                </Button>
              ))}
              {open.frames.length === 0 && <p className="text-xs text-muted-foreground">Aucune frame dans ce tableau.</p>}
            </div>
            <CanvasVignette canvas={open} selectedNodeId={sel?.kind === "node" ? sel.id : null} onSelect={(ref) => setSel({ kind: "node", id: ref })} />
          </>
        )}
      </section>

      {/* ═══════════ colonne 3 : l'aperçu ═══════════ */}
      <aside className="w-[360px] shrink-0 border-l border-border overflow-y-auto px-4 py-4">
        <Preview
          snap={snap}
          sel={sel}
          setSel={setSel}
          openCanvas={open}
          setConvOpen={(canvasId) => {
            setConvTarget(canvasId);
            setConvOpen(true);
          }}
        />
      </aside>

      <NewCanvasModal open={newOpen} onClose={() => setNewOpen(false)} onCreated={(id) => {
        setNewOpen(false);
        setOpenCanvasId(id);
      }} />
      {/* Montée conditionnelle : l'état de la modale se réinitialise au montage,
          sans effet de remise à zéro (react-hooks/set-state-in-effect). */}
      {convOpen && (
        <NewConversationModal onClose={() => setConvOpen(false)} preChecked={convTarget} canvases={canvases} />
      )}
    </div>
  );
}

/* ────────────────────────── la vignette du plan (AC2) ────────────────────────── */

function CanvasVignette({
  canvas,
  selectedNodeId,
  onSelect,
}: {
  canvas: Snapshot["canvases"][number];
  selectedNodeId: string | null;
  onSelect: (ref: string) => void;
}) {
  const nodes = canvas.nodes;
  const bounds = useMemo(() => {
    let minX = 0, minY = 0, maxX = 1200, maxY = 700;
    for (const n of nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + 300); maxY = Math.max(maxY, n.y + 170);
    }
    return { minX, minY, w: maxX - minX, h: maxY - minY };
  }, [nodes]);
  const scale = Math.min(1, bounds.w > 0 ? 900 / bounds.w : 1, bounds.h > 0 ? 480 / bounds.h : 1);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative h-[480px] overflow-hidden" style={{
        backgroundImage: "radial-gradient(circle at 1px 1px, var(--border) 1px, transparent 0)",
        backgroundSize: "22px 22px",
      }}>
        {canvas.frames.map((f) => (
          <button
            key={f.id}
            className="absolute rounded-lg border-2 px-2 py-1 text-left text-xs"
            style={{
              left: (f.x - bounds.minX) * scale,
              top: (f.y - bounds.minY) * scale,
              width: Math.max(60, f.width * scale),
              height: Math.max(30, f.height * scale),
              borderColor: f.color ? canvasColorClass(f.color).replace("bg-", "border-").replace("/80", "") : "var(--border)",
            }}
            title={`Frame « ${f.label} » — ${f.constructions + f.sources} objet(s)`}
          >
            <span className="font-semibold">{f.label}</span> <span className="text-muted-foreground">· {f.constructions + f.sources}</span>
          </button>
        ))}
        {nodes.map((n) => (
          <button
            key={n.ref}
            className={`absolute rounded-lg border bg-card px-2 py-1 text-left text-[11px] shadow-sm hover:shadow-md ${
              selectedNodeId === n.ref ? "ring-2 ring-foreground" : ""
            }`}
            style={{
              left: (n.x - bounds.minX) * scale,
              top: (n.y - bounds.minY) * scale,
              width: Math.max(80, 260 * scale),
            }}
            onClick={() => onSelect(n.ref)}
          >
            <span className="block truncate font-medium">
              {n.kind === "source" ? <FileText className="mr-1 inline size-3" /> : <Sparkles className="mr-1 inline size-3" />}
              {n.kind === "source" ? n.title : n.text}
            </span>
            <span className="block truncate text-muted-foreground">
              {n.kind === "source" ? `${n.fragment_count} fragment(s)` : n.epistemic_status.toLowerCase()}
              {n.kind === "construction" && n.stale ? " · périmé" : ""}
            </span>
          </button>
        ))}
        {nodes.length === 0 && canvas.frames.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Plan vide — les objets se posent dans l&apos;atelier.
          </p>
        )}
      </div>
      <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        ◇ vignette rendue depuis les positions réelles — cliquer un objet le sélectionne (aperçu à droite) ·{" "}
        <Link className="underline" href={`/canvas/${canvas.id}`}>plein écran dans l&apos;atelier</Link>
      </p>
    </div>
  );
}

/* ────────────────────────── l'aperçu (poste de pilotage) ────────────────────────── */

function Preview({
  snap,
  sel,
  setSel,
  openCanvas,
  setConvOpen,
}: {
  snap: Snapshot;
  sel: { kind: "node" | "frame" | "canvas" | "conversation"; id: string } | null;
  setSel: (s: { kind: "node" | "frame" | "canvas" | "conversation"; id: string } | null) => void;
  openCanvas: Snapshot["canvases"][number] | null;
  setConvOpen: (canvasId: string | null) => void;
}) {
  const node = useMemo(() => {
    if (sel?.kind !== "node" || !openCanvas) return null;
    return openCanvas.nodes.find((n) => n.ref === sel.id) ?? null;
  }, [sel, openCanvas]);
  const frame = useMemo(() => {
    if (sel?.kind !== "frame" || !openCanvas) return null;
    return openCanvas.frames.find((f) => f.id === sel.id) ?? null;
  }, [sel, openCanvas]);
  const conv = useMemo(() => {
    if (sel?.kind !== "conversation") return null;
    for (const c of snap.canvases) {
      const found = c.conversations.find((v) => v.id === sel.id);
      if (found) return found;
    }
    return null;
  }, [sel, snap]);

  if (conv) {
    return (
      <div>
        <p className="text-sm font-semibold leading-6">{conv.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Conversation · active {relTime(conv.updated_at)}</p>
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Agir</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <Link href={`/conversation/${conv.id}`}>Ouvrir la conversation</Link>
          </Button>
        </div>
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Tableaux liés</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {snap.canvases
            .filter((c) => c.conversations.some((v) => v.id === conv.id))
            .map((c) => (
              <Badge key={c.id} variant="outline" className="gap-1.5 font-normal">
                <span className={`size-2 rounded-sm ${canvasColorClass(c.color)}`} />
                {c.label}
              </Badge>
            ))}
        </div>
      </div>
    );
  }

  if (node && openCanvas) {
    return (
      <div>
        <p className="text-sm font-semibold leading-6">
          {node.kind === "source" ? node.title : node.text}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {node.kind === "source" ? "Fichier" : "Construction"} · tableau « {openCanvas.label} »
          {node.frame_id ? "" : " · hors frame"}
        </p>
        {node.kind === "construction" && (
          <p className="mt-2 text-xs text-muted-foreground">
            Statut : {node.epistemic_status.toLowerCase()}
            {node.stale ? " · périmé (une source citée a disparu)" : ""}
          </p>
        )}
        {node.kind === "source" && (
          <p className="mt-2 text-xs text-muted-foreground">{node.fragment_count} fragment(s)</p>
        )}
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Agir</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setConvOpen(openCanvas.id)}>
            <MessageSquare className="mr-1 size-4" /> Discuter de ça
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href={`/canvas/${openCanvas.id}`}>Ouvrir dans l&apos;atelier</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (frame && openCanvas) {
    return (
      <div>
        <p className="text-sm font-semibold leading-6">{frame.label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Frame du tableau « {openCanvas.label} » · {frame.constructions + frame.sources} objet(s)
        </p>
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Agir</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setConvOpen(openCanvas.id)}>
            <MessageSquare className="mr-1 size-4" /> Discuter de ça
          </Button>
        </div>
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Objets de la frame</p>
        <div className="mt-2 space-y-1">
          {openCanvas.nodes
            .filter((n) => n.frame_id === frame.id)
            .map((n) => (
              <button
                key={n.ref}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                onClick={() => setSel({ kind: "node", id: n.ref })}
              >
                {n.kind === "source" ? <FileText className="size-3.5 shrink-0" /> : <Sparkles className="size-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{n.kind === "source" ? n.title : n.text}</span>
              </button>
            ))}
          {frame.constructions + frame.sources === 0 && <p className="text-xs text-muted-foreground">Frame vide.</p>}
        </div>
      </div>
    );
  }

  if (openCanvas) {
    return (
      <div>
        <p className="text-sm font-semibold leading-6">{openCanvas.label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Tableau{openCanvas.is_default ? " — l'atelier (non supprimable)" : ""} · {openCanvas.totals.frames} frame(s) ·{" "}
          {openCanvas.totals.constructions + openCanvas.totals.sources} objet(s)
        </p>
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Agir</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setConvOpen(openCanvas.id)}>
            <MessageSquare className="mr-1 size-4" /> Discuter de ça
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href={`/canvas/${openCanvas.id}`}>Ouvrir dans l&apos;atelier</Link>
          </Button>
        </div>
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">
          Conversations ancrées ({openCanvas.conversations.length})
        </p>
        <div className="mt-2 space-y-1">
          {openCanvas.conversations.map((v) => (
            <button
              key={v.id}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              onClick={() => setSel({ kind: "conversation", id: v.id })}
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{v.title}</span>
            </button>
          ))}
          {openCanvas.conversations.length === 0 && (
            <p className="text-xs text-muted-foreground">Aucune — « Discuter de ça » depuis un objet, ou ⤵</p>
          )}
        </div>
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Frames</p>
        <div className="mt-2 space-y-1">
          {openCanvas.frames.map((f) => (
            <button
              key={f.id}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              onClick={() => setSel({ kind: "frame", id: f.id })}
            >
              <span className="min-w-0 flex-1 truncate">▦ {f.label}</span>
              <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                {f.constructions + f.sources}
              </Badge>
            </button>
          ))}
          {openCanvas.frames.length === 0 && <p className="text-xs text-muted-foreground">Aucune frame.</p>}
        </div>
        {openCanvas.is_default && openCanvas.unframed.constructions + openCanvas.unframed.sources > 0 && (
          <p className="mt-4 text-xs text-muted-foreground">
            {openCanvas.unframed.constructions + openCanvas.unframed.sources} objet(s) « hors frame » — posés librement sur le plan.
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm font-semibold">Rien de sélectionné</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Cliquez un dossier (il s&apos;ouvre), une conversation, ou un objet sur le plan.
      </p>
      <Button size="sm" className="mt-4" onClick={() => setConvOpen(null)}>
        <MessageSquare className="mr-1 size-4" /> Nouvelle conversation
      </Button>
    </div>
  );
}

/* ────────────────────────── les modales ────────────────────────── */

function NewCanvasModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<string | null>(CANVAS_COLORS[2] ?? null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;
  const submit = async () => {
    if (!label.trim()) return;
    setBusy(true);
    const res = await fetch("/api/canvases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label.trim(), color }),
    });
    setBusy(false);
    if (res.ok) {
      const row = (await res.json()) as { id: string };
      setLabel("");
      onCreated(row.id);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30" onClick={onClose}>
      <div className="w-[420px] rounded-xl border border-border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold">Nouveau tableau</p>
        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="new-canvas-label">Nom</label>
        <Input
          id="new-canvas-label"
          className="mt-1"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="Ex. Veille IA, Thèse, Recrutement…"
          autoFocus
        />
        <label className="mt-3 block text-xs text-muted-foreground">Étiquette</label>
        <div className="mt-1.5 flex gap-1.5">
          {CANVAS_COLORS.map((c) => (
            <button
              key={c}
              className={`size-6 rounded-lg border-2 ${canvasColorClass(c)} ${color === c ? "border-foreground" : "border-transparent"}`}
              onClick={() => setColor(c)}
              title={c}
            />
          ))}
          <button
            className={`size-6 rounded-lg border-2 bg-muted-foreground/40 ${color === null ? "border-foreground" : "border-transparent"}`}
            onClick={() => setColor(null)}
            title="sans étiquette"
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Annuler</Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || !label.trim()}>
            {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />} Créer
          </Button>
        </div>
      </div>
    </div>
  );
}

function NewConversationModal({
  onClose,
  preChecked,
  canvases,
}: {
  onClose: () => void;
  preChecked: string | null;
  canvases: Snapshot["canvases"];
}) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  // La modale n'est montée qu'ouverte : l'état initial porte la sélection précochée.
  const [checked, setChecked] = useState<Set<string>>(() => new Set(preChecked ? [preChecked] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (question.trim().length < 15) {
      setError("La question doit faire au moins 15 caractères.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question.trim(), canvasIds: [...checked] }),
    });
    setBusy(false);
    if (res.ok) {
      const body = (await res.json()) as { conversation_id: string };
      router.push(`/conversation/${body.conversation_id}`);
    } else {
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      setError(body.message ?? body.code ?? `échec (${res.status})`);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30" onClick={onClose}>
      <div className="w-[460px] rounded-xl border border-border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold">Nouvelle conversation</p>
        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="new-conv-q">Première question</label>
        <textarea
          id="new-conv-q"
          className="mt-1 min-h-[72px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Que disent ces documents sur…"
          autoFocus
        />
        <label className="mt-3 block text-xs text-muted-foreground">
          Tableaux liés <span className="font-normal">(les constructions cochées nourrissent le contexte du tour — plafonnées)</span>
        </label>
        <div className="mt-1.5 space-y-1">
          {canvases.map((c) => (
            <label key={c.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted">
              <input
                type="checkbox"
                className="size-3.5"
                checked={checked.has(c.id)}
                onChange={() =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (next.has(c.id)) next.delete(c.id);
                    else next.add(c.id);
                    return next;
                  })
                }
              />
              <span className={`size-2.5 rounded-sm ${canvasColorClass(c.color)}`} />
              {c.label}
            </label>
          ))}
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Annuler</Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />} Ouvrir la conversation
          </Button>
        </div>
      </div>
    </div>
  );
}
