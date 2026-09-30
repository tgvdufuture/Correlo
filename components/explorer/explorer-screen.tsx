"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CornerUpLeft,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Loader2,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Presentation,
  RefreshCw,
  Search,
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

  // la vue : la grille des dossiers (d'un niveau de l'arbre), ou l'intérieur d'un tableau
  const [openCanvasId, setOpenCanvasId] = useState<string | null>(null);
  // le niveau de l'arbre affiché dans la grille (v1.6.1 : les sous-tableaux) —
  // `null` = racine ; un id = on regarde **dans** ce tableau
  const [browseInId, setBrowseInId] = useState<string | null>(null);
  // l'objet sélectionné (aperçu) : une construction, une frame, une conversation…
  const [sel, setSel] = useState<{ kind: "node" | "frame" | "canvas" | "conversation"; id: string } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  // la nature à créer dans la modale (« canvas » ou « dossier » — v1.6.2)
  const [newKind, setNewKind] = useState<"canvas" | "folder">("canvas");
  // le dossier **dans** lequel la modale de création posera le nouveau (le « + »
  // d'une carte, ou le niveau visité) — null = à la racine
  const [newParentId, setNewParentId] = useState<string | null>(null);
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
  /**
   * Le niveau affiché (v1.6.2 : les dossiers) : les enfants du dossier visité —
   * **sous-dossiers et canvas mélangés**, comme un explorateur de fichiers — ou
   * les racines. Le tri met les dossiers d'abord (convention universelle).
   */
  const level = useMemo(() => {
    const children = canvases.filter((c) => (browseInId ? c.parent_id === browseInId : !c.parent_id));
    return [...children].sort((a, b) =>
      a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1
    );
  }, [canvases, browseInId]);
  const browseIn = browseInId ? canvases.find((c) => c.id === browseInId) ?? null : null;
  /** Le chemin de « Entrer » (le fil d'Ariane de la grille), racine d'abord. */
  const browseTrail = useMemo(() => {
    const trail: Snapshot["canvases"] = [];
    let cur = browseIn;
    while (cur) {
      trail.unshift(cur);
      cur = cur.parent_id ? canvases.find((c) => c.id === cur!.parent_id) ?? null : null;
    }
    return trail;
  }, [browseIn, canvases]);
  /** Les cibles de « Déplacer vers » : les **dossiers** uniquement (ce qui se range
   *  va dans un conteneur, v1.6.2), sauf soi et ses descendants (un cycle serait
   *  refusé par la base — l'écran ne propose même pas, c'est plus honnête). */
  const moveTargets = useMemo(() => {
    if (!sel || sel.kind !== "canvas") return [];
    const forbidden = new Set<string>([sel.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of canvases) {
        if (forbidden.has(c.id)) continue;
        if (c.parent_id && forbidden.has(c.parent_id)) {
          forbidden.add(c.id);
          grew = true;
        }
      }
    }
    return canvases.filter((c) => c.kind === "folder" && !forbidden.has(c.id));
  }, [sel, canvases]);
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

  /** Ouvrir un élément depuis un raccourci (épinglés, activité récente) : un
   *  dossier s'ouvre comme un dossier, un canvas comme un plan. */
  const openFromShortcut = (id: string) => {
    const c = canvases.find((x) => x.id === id);
    if (c?.kind === "folder") {
      setBrowseInId(id);
      setSel(null);
    } else {
      setOpenCanvasId(id);
      setSel(null);
    }
  };

  /** Ouvrir la modale de création pour une nature et un parent donnés. */
  const openNew = (kind: "canvas" | "folder", parentId: string | null) => {
    setNewKind(kind);
    setNewParentId(parentId);
    setNewOpen(true);
  };

  /** Le clic sur une carte (v1.6.2) : un **dossier** s'ouvre comme un dossier (on
   *  regarde dedans — sous-dossiers et canvas côte à côte), un **canvas** ouvre
   *  son plan. C'est la distinction que la v1.6.1 n'avait pas. */
  const openCard = (c: Snapshot["canvases"][number]) => {
    if (c.kind === "folder") {
      setBrowseInId(c.id);
    } else {
      setOpenCanvasId(c.id);
      setSel(null);
    }
  };

  /** Le rechargement de données pour les gestes qui ne passent pas par `act` (les modales). */
  const refresh = useCallback(async () => {
    setSnap(await load());
  }, [load]);

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

  const remove = async (id: string, label: string, isDefault: boolean, frames: number, convs: number, children: number) => {
    if (isDefault) {
      setNotice("L'atelier n'est pas supprimable — c'est le réceptacle des détachements.");
      return;
    }
    const message =
      `Supprimer « ${label} » ?\n\n` +
      `${children} élément(s) rangé(s) dedans remonteront d'un niveau (visibles là où « ${label} » était).\n` +
      `${frames} frame(s) seront dissoute(s), les objets rangés dedans restent visibles « hors frame » dans l'atelier.\n` +
      `${convs} conversation(s) seront déliée(s) — elles restent, hors tableau.\n\nCette action est irréversible.`;
    if (!window.confirm(message)) return;
    await act(
      () => fetch(`/api/canvases?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
      (body) => {
        const detached = (body as { detached?: { frames: number; conversations: number; children: number } }).detached;
        if (detached) {
          setNotice(
            `« ${label} » supprimé — ${detached.children} élément(s) remonté(s), ${detached.frames} frame(s) dissoute(s), ${detached.conversations} conversation(s) déliée(s) (aucun objet supprimé).`
          );
        }
      }
    );
    // le niveau visité peut être le tableau supprimé, **ou son ancêtre supprimé**
    // (la remontée a déplacé les enfants) : on ne garde le niveau que s'il existe
    // encore — un id orphelin laisserait une grille vide sans fil d'Ariane, sans
    // moyen d'en sortir
    const stillThere = canvases.some((c) => c.id === browseInId);
    if (browseInId && !stillThere) setBrowseInId(null);
    if (openCanvasId === id) {
      setOpenCanvasId(null);
      setSel(null);
    }
  };

  /** Déplacer le tableau sélectionné sous une cible (ou à la racine) — les refus
   *  nommés de l'API (cycle, atelier) deviennent une phrase, jamais un 500 muet. */
  const moveTo = async (id: string, target: string | null) => {
    const ok = await act(() =>
      fetch(`/api/canvases?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: target }),
      })
    );
    if (ok) setNotice(target ? "Tableau déplacé." : "Tableau remis à la racine.");
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
                openFromShortcut(c.id);
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
              <Button size="sm" className="ml-auto" onClick={() => openNew("canvas", browseInId)}>
                <Plus className="mr-1 size-4" /> Nouveau canvas
              </Button>
            </div>
            {/* le fil d'Ariane du niveau visité (v1.6.1 : les sous-tableaux) */}
            {browseIn && (
              <div className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setBrowseInId(null)}>
                  <CornerUpLeft className="mr-1 size-3.5" /> Racine
                </Button>
                {browseTrail.map((c, i) => (
                  <span key={c.id} className="flex items-center gap-1.5">
                    <span className="text-border">/</span>
                    <button
                      className={`rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground ${i === browseTrail.length - 1 ? "font-medium text-foreground" : ""}`}
                      onClick={() => setBrowseInId(c.id)}
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>
            )}
            {notice && <p className="mb-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{notice}</p>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {level.map((c) => (
                <div
                  key={c.id}
                  className="group relative cursor-pointer rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
                  onClick={() => openCard(c)}
                  title={
                    c.kind === "folder"
                      ? "Cliquer : entrer dans le dossier"
                      : "Cliquer : ouvrir le canvas"
                  }
                >
                  <div className="absolute right-2 top-2 hidden gap-0.5 group-hover:flex">
                    {/* créer DEDANS : un dossier reçoit canvas et sous-dossiers ;
                        un canvas ne reçoit rien (ce n'est pas un conteneur) */}
                    {c.kind === "folder" && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7 bg-card"
                          title="Nouveau canvas dans ce dossier"
                          onClick={(e) => {
                            e.stopPropagation();
                            openNew("canvas", c.id);
                          }}
                        >
                          <FileText className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7 bg-card"
                          title="Nouveau sous-dossier dans ce dossier"
                          onClick={(e) => {
                            e.stopPropagation();
                            openNew("folder", c.id);
                          }}
                        >
                          <Plus className="size-3.5" />
                        </Button>
                      </>
                    )}
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
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 bg-card"
                      title="Déplacer vers…"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSel({ kind: "canvas", id: c.id });
                      }}
                    >
                      <FolderInput className="size-3.5" />
                    </Button>
                    {!c.is_default && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 bg-card text-destructive"
                        title="Supprimer"
                        onClick={(e) => {
                          e.stopPropagation();
                          const children = canvases.filter((x) => x.parent_id === c.id).length;
                          void remove(c.id, c.label, c.is_default, c.totals.frames, c.totals.conversations, children);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                  {/* l'icône dit la nature : dossier ouvert (conteneur) ou plan
                      (surface) — le double-clic n'existe pas, un clic suffit */}
                  {c.kind === "folder" ? (
                    <FolderOpen className="mb-3 size-9 text-foreground" />
                  ) : (
                    <Presentation className={`mb-3 size-9 ${canvasColorClass(c.color)} rounded-md p-1.5 text-white`} fill="currentColor" />
                  )}
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
              {/* les DEUX créations du niveau visité (v1.6.2 : le cœur de la
                  demande) — canvas et dossier côte à côte, comme « Nouveau
                  dossier » et « Nouveau document » d'un explorateur de fichiers */}
              <button
                className="flex min-h-[128px] items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-border text-sm text-muted-foreground hover:border-foreground hover:text-foreground"
                onClick={() => openNew("canvas", browseInId)}
              >
                <Presentation className="size-4" /> Nouveau canvas
              </button>
              <button
                className="flex min-h-[128px] items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-border text-sm text-muted-foreground hover:border-foreground hover:text-foreground"
                onClick={() => openNew("folder", browseInId)}
              >
                <FolderPlus className="size-4" /> Nouveau dossier
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
                        openFromShortcut(e.id);
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
              {/* « Tableaux » referme le plan et rend le niveau visité : si on
                  avait ouvert un canvas DANS un dossier, on retourne à CE dossier
                  (le fil d'Ariane reste) — pas un saut brutal à la racine */}
              <Button size="sm" variant="outline" onClick={() => setOpenCanvasId(null)}>
                <ArrowLeft className="mr-1 size-4" /> {browseIn ? "Dossier" : "Tableaux"}
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
                {/* AC2 : si une frame est sélectionnée, le focalisé centre dessus */}
                <Link href={`/canvas/${open.id}${sel?.kind === "frame" ? `?frame=${sel.id}` : ""}`}>
                  Plein écran
                </Link>
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
            <CanvasVignette
              canvas={open}
              selectedNodeId={sel?.kind === "node" ? sel.id : null}
              onSelect={(ref) => setSel({ kind: "node", id: ref })}
              onSelectFrame={(id) => setSel({ kind: "frame", id })}
            />
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

      <NewCanvasModal
        open={newOpen}
        kind={newKind}
        onClose={() => {
          setNewOpen(false);
          setNewParentId(null);
        }}
        parentId={newParentId}
        onCreated={(id) => {
          setNewOpen(false);
          setNewParentId(null);
          // La nature du créé est **la prop `kind` de la modale** — jamais une
          // recherche dans `canvases` : ce tableau de l'écran est la closure du
          // rendu précédent (le snapshot rechargé n'a pas encore re-rendu), il
          // ne contient pas l'entrée neuve et la devinette tombait sur `undefined`
          // → un dossier créé se retrouvait « ouvert » comme un plan vide.
          if (newKind === "folder") {
            // un dossier vient de naître : on **entre dedans** (c'est son usage —
            // le voir et le remplir), jamais son « plan » qui n'existe pas
            setBrowseInId(id);
            setOpenCanvasId(null);
            setSel(null);
          } else {
            // un canvas vient de naître : on ouvre **son plan** — ou, s'il a été
            // créé dans un dossier, on entre dans le dossier pour le voir dedans
            setBrowseInId(newParentId);
            setOpenCanvasId(id);
            setSel(null);
          }
        }}
        refresh={refresh}
      />
      {/* la création recharge le snapshot **avant** `onCreated` : sans lui,
          `openCanvasId` désigne un canvas absent du snapshot périmé et la grille
           ne montre jamais la nouvelle carte */}
      {/* Montée conditionnelle : l'état de la modale se réinitialise au montage,
          sans effet de remise à zéro (react-hooks/set-state-in-effect). */}
      {convOpen && (
        <NewConversationModal onClose={() => setConvOpen(false)} preChecked={convTarget} canvases={canvases} />
      )}
      {/* Déplacer le tableau sélectionné (bouton « Déplacer vers… » d'une carte) :
          les cibles excluent déjà soi et ses descendants (un cycle serait refusé
          par la base — l'écran ne propose même pas). */}
      {sel?.kind === "canvas" && (
        <MoveCanvasModal
          canvas={canvases.find((c) => c.id === sel.id) ?? null}
          targets={moveTargets}
          onClose={() => setSel(null)}
          onMove={(target) => {
            void moveTo(sel.id, target).then(() => setSel(null));
          }}
        />
      )}
    </div>
  );
}

/* ────────────────────────── la vignette du plan (AC2) ────────────────────────── */

function CanvasVignette({
  canvas,
  selectedNodeId,
  onSelect,
  onSelectFrame,
}: {
  canvas: Snapshot["canvases"][number];
  selectedNodeId: string | null;
  onSelect: (ref: string) => void;
  /** La maquette dit « frames cliquables » : un clic sur une frame l'affiche dans l'aperçu. */
  onSelectFrame: (id: string) => void;
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
            onClick={() => onSelectFrame(f.id)}
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
        <Link className="underline" href={`/canvas/${canvas.id}`}>plein écran du tableau</Link>
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
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Liens IA</p>
        <NodeLinks node={node} />
        <p className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Agir</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setConvOpen(openCanvas.id)}>
            <MessageSquare className="mr-1 size-4" /> Discuter de ça
          </Button>
          {/* AC3 : chaque action mène à l'écran existant — elle ne le réinvente pas.
              « Investiguer » n'a de sens que pour une suggestion ; « Synthétiser »
              n'existe que pour une source (une synthèse cite des sources). */}
          {node.links.suggestions > 0 && (
            <Button size="sm" variant="outline" asChild>
              <Link href="/suggestions">
                <Search className="mr-1 size-4" /> Investiguer ({node.links.suggestions})
              </Link>
            </Button>
          )}
          {node.kind === "source" && node.links.syntheses > 0 && (
            <Button size="sm" variant="outline" asChild>
              <Link href="/syntheses">
                <Sparkles className="mr-1 size-4" /> Synthétiser ({node.links.syntheses})
              </Link>
            </Button>
          )}
          <Button size="sm" variant="outline" asChild>
            {/* AC2 : l'objet vit peut-être dans une frame — le focalisé l'ouvre dessus */}
            <Link href={`/canvas/${openCanvas.id}${node.frame_id ? `?frame=${node.frame_id}` : ""}`}>
              Plein écran
            </Link>
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
          <Button size="sm" variant="outline" asChild>
            {/* AC2 : ouvrir le plan centré sur CETTE frame */}
            <Link href={`/canvas/${openCanvas.id}?frame=${frame.id}`}>Plein écran</Link>
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
            <Link href={`/canvas/${openCanvas.id}`}>Plein écran</Link>
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

/* ────────────────────────── déplacer un tableau (v1.6.1) ───────────────────── */

/**
 * « Déplacer vers… » : la cible choisie dans une liste plate — l'arbre récursif
 * dans une modale serait une arme à cycles pour les mains de l'utilisateur ; les
 * cibles excluent déjà soi et ses descendants, et « racine » est toujours là.
 * Les refus nommés de l'API (l'atelier, un cycle apparu entre-temps) deviennent
 * une phrase via `moveTo` — jamais un 500 muet.
 */
function MoveCanvasModal({
  canvas,
  targets,
  onClose,
  onMove,
}: {
  canvas: Snapshot["canvases"][number] | null;
  targets: Snapshot["canvases"];
  onClose: () => void;
  onMove: (target: string | null) => void;
}) {
  if (!canvas) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30" onClick={onClose}>
      <div className="w-[420px] rounded-xl border border-border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold">
          Déplacer « {canvas.label} » vers…
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Le tableau et tout ce qu&apos;il contient suivent — ses sous-tableaux compris.
        </p>
        <div className="mt-3 max-h-[300px] space-y-0.5 overflow-y-auto">
          <button
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted"
            onClick={() => onMove(null)}
          >
            <CornerUpLeft className="size-3.5 shrink-0" /> À la racine
          </button>
          {targets.map((t) => (
            <button
              key={t.id}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => onMove(t.id)}
            >
              <Folder className={`size-3.5 shrink-0 rounded-sm ${canvasColorClass(t.color)}`} fill="currentColor" />
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
              {t.is_default && <span className="text-[11px] text-muted-foreground">(atelier)</span>}
            </button>
          ))}
          {targets.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">Aucune autre destination disponible.</p>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Annuler</Button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────── les liens IA d'un objet (AC3) ───────────────────── */

/**
 * Les liens d'un objet : **des compteurs**, jamais des listes complètes. L'écran
 * expert (/suggestions, /syntheses) porte le détail et les décisions — l'aperçu
 * dit « ce qui existe » et les boutons y mènent (AC3 : « chaque action mène aux
 * écrans existants, elle ne les réinvente pas »).
 */
function NodeLinks({ node }: { node: Snapshot["canvases"][number]["nodes"][number] }) {
  const entries: { label: string; n: number }[] = [
    { label: node.kind === "construction" ? "suggestion parente" : "suggestion(s) ouverte(s)", n: node.links.suggestions },
    ...(node.kind === "source" ? [{ label: "synthèse(s) proposée(s)", n: node.links.syntheses }] : []),
    ...(node.links.investigations > 0 ? [{ label: "enquête(s)", n: node.links.investigations }] : []),
  ];
  const active = entries.filter((e) => e.n > 0);
  if (active.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {node.kind === "source"
          ? "Aucune connexion proposée pour l'instant — l'analyse tourne en tâche de fond."
          : "Aucun lien d'analyse — cette construction vient d'une intégration."}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {active.map((e) => (
        <Badge key={e.label} variant="outline" className="gap-1.5 font-normal">
          {e.label}
          <span className="font-medium">{e.n}</span>
        </Badge>
      ))}
    </div>
  );
}

/* ────────────────────────── les modales ────────────────────────── */

function NewCanvasModal({
  open,
  kind,
  onClose,
  onCreated,
  /** Le dossier dans lequel créer (sous-élément) — null ou absent : à la racine. */
  parentId,
  /** Le rechargement du snapshot après création (l'écran reste la vérité de la base). */
  refresh,
}: {
  open: boolean;
  /** Ce qu'on crée : un canvas (surface) ou un dossier (conteneur) — v1.6.2. */
  kind: "canvas" | "folder";
  onClose: () => void;
  onCreated: (id: string) => void;
  parentId?: string | null;
  refresh: () => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<string | null>(CANVAS_COLORS[2] ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;
  const noun = kind === "folder" ? "dossier" : "canvas";
  const submit = async () => {
    if (!label.trim()) return;
    setBusy(true);
    const res = await fetch("/api/canvases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label.trim(), color, kind, ...(parentId ? { parentId } : {}) }),
    });
    setBusy(false);
    if (res.ok) {
      const row = (await res.json()) as { id: string };
      setLabel("");
      await refresh();
      onCreated(row.id);
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `échec (${res.status})`);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30" onClick={onClose}>
      <div className="w-[420px] rounded-xl border border-border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold">Nouveau {noun}{parentId ? " (dans le dossier visité)" : ""}</p>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
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
            {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />} Créer le {noun}
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
          {/* les canvas uniquement : un dossier ne porte rien à discuter
              (garde `conversation_dans_dossier` côté dépôt) */}
          {canvases.filter((c) => c.kind === "canvas").map((c) => (
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
