"use client";

import { memo, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  GripHorizontal,
  Layers,
  Link2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  EPISTEMIC_DEFINITION,
  NODE_HEIGHT,
  NODE_WIDTH,
  SOURCE_HEIGHT,
  SOURCE_WIDTH,
  type CanvasFrame,
  type CanvasItem,
  type CanvasItemKind,
} from "@/lib/api-types";

/**
 * Rendu d'un élément et d'un conteneur (Phase 3, volets canvas libre et fichiers).
 *
 * Composants **mémoïsés** : un glisser déplace une sélection en mettant à jour une
 * position à chaque `pointermove`, et sans mémoïsation chaque image re-rendrait les
 * 200 éléments du canvas. Le seul état local ici est l'édition du libellé — tout le
 * reste vient du parent.
 *
 * Un **fichier** n'affiche pas le nom que le canvas aurait inventé : il affiche la
 * source telle que la bibliothèque la dérive (statut d'ingestion des jobs, compte
 * de fragments), pour qu'un seul écran ne dise jamais deux choses différentes.
 */

/** Taille nominale d'un élément : géométrie d'appartenance, cadrage et arêtes. */
export function itemSize(kind: CanvasItemKind): { w: number; h: number } {
  return kind === "source" ? { w: SOURCE_WIDTH, h: SOURCE_HEIGHT } : { w: NODE_WIDTH, h: NODE_HEIGHT };
}

export interface CanvasItemCardProps {
  item: CanvasItem;
  selected: boolean;
  /** Mis en avant quand un lien le concerne (survol d'une arête ou du panneau). */
  highlighted?: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, item: CanvasItem) => void;
  onOpen: (item: CanvasItem) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>, item: CanvasItem) => void;
}

export const CanvasItemCard = memo(function CanvasItemCard({
  item,
  selected,
  highlighted = false,
  onPointerDown,
  onOpen,
  onKeyDown,
}: CanvasItemCardProps) {
  const size = itemSize(item.kind);
  return (
    <div
      role="button"
      tabIndex={0}
      data-canvas-item={`${item.kind}:${item.ref}`}
      data-highlighted={highlighted ? "true" : undefined}
      aria-label={item.kind === "source" ? `Fichier : ${item.source.title ?? item.ref}` : `Construction : ${item.construction.text.slice(0, 80)}`}
      onPointerDown={(e) => onPointerDown(e, item)}
      onDoubleClick={() => onOpen(item)}
      onKeyDown={(e) => onKeyDown(e, item)}
      style={{ left: item.x, top: item.y, width: size.w }}
      className={`absolute cursor-grab rounded-xl border bg-card p-3 text-left shadow-sm transition-shadow select-none active:cursor-grabbing ${
        selected
          ? "border-primary ring-2 ring-primary/40"
          : highlighted
            ? "border-primary/70 ring-2 ring-primary/20"
            : "border-border hover:shadow-md"
      } ${
        item.kind === "construction" && item.construction.stale ? "border-dashed" : ""
      }`}
    >
      {item.kind === "source" ? (
        <SourceCardBody item={item} />
      ) : (
        <ConstructionCardBody item={item} />
      )}
    </div>
  );
});

function SourceCardBody({ item }: { item: Extract<CanvasItem, { kind: "source" }> }) {
  const s = item.source;
  return (
    <>
      <div className="mb-1.5 flex items-center gap-1.5">
        {s.type === "URL" ? (
          <Link2 className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="size-4 shrink-0 text-muted-foreground" />
        )}
        <p className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium" title={s.title ?? s.id}>
          {s.title ?? s.id.slice(0, 8)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline">{s.type}</Badge>
        {s.ingest_status === "done" ? (
          <Badge variant="secondary">{s.fragment_count} fragment(s)</Badge>
        ) : s.ingest_status === "failed" ? (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="size-3" />
            ingestion échouée
          </Badge>
        ) : (
          <Badge variant="secondary" className="gap-1">
            {s.ingest_status === "running" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {s.ingest_status === "running" ? "ingestion…" : "en file"}
          </Badge>
        )}
        {item.frame_id ? (
          <Badge variant="secondary" className="gap-1">
            <Layers className="size-3" />
            groupé
          </Badge>
        ) : null}
      </div>
      {s.summary ? (
        <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{s.summary}</p>
      ) : null}
    </>
  );
}

function ConstructionCardBody({ item }: { item: Extract<CanvasItem, { kind: "construction" }> }) {
  const c = item.construction;
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <Badge
          variant={c.epistemic_status === "FACT" ? "destructive" : "outline"}
          title={EPISTEMIC_DEFINITION[c.epistemic_status]}
        >
          {c.epistemic_status}
        </Badge>
        {c.stale ? (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="size-3" />
            périmé
          </Badge>
        ) : null}
        {item.frame_id ? (
          <Badge variant="secondary" className="gap-1">
            <Layers className="size-3" />
            groupé
          </Badge>
        ) : null}
      </div>
      <p className="line-clamp-3 text-sm leading-snug">{c.text}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {c.parent_source_ids.length} source{c.parent_source_ids.length > 1 ? "s" : ""} ·{" "}
        {c.evidence_fragment_ids.length} preuve{c.evidence_fragment_ids.length > 1 ? "s" : ""} ·
        profondeur {c.depth}
      </p>
    </>
  );
}

export interface CanvasFrameBoxProps {
  frame: CanvasFrame;
  memberCount: number;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, frame: CanvasFrame) => void;
  onResizePointerDown: (e: React.PointerEvent<HTMLDivElement>, frame: CanvasFrame) => void;
  onSelect: (frame: CanvasFrame) => void;
  onLabelCommit: (frame: CanvasFrame, label: string) => void;
}

export const CanvasFrameBox = memo(function CanvasFrameBox({
  frame,
  memberCount,
  selected,
  onPointerDown,
  onResizePointerDown,
  onSelect,
  onLabelCommit,
}: CanvasFrameBoxProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(frame.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const isGroup = frame.kind === "group";
  const commit = () => {
    setEditing(false);
    const label = draft.trim();
    if (label && label !== frame.label) onLabelCommit(frame, label);
    else setDraft(frame.label);
  };

  return (
    <div
      data-frame={frame.id}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        borderColor: frame.color ?? undefined,
      }}
      onPointerDown={(e) => {
        // le conteneur ne capture les clics que sur son fond, pas sur ses éléments
        if (e.target === e.currentTarget) onSelect(frame);
      }}
      className={`absolute rounded-2xl ${
        isGroup
          ? "border-2 border-dashed border-muted-foreground/40 bg-transparent"
          : "border border-border bg-muted/40 backdrop-blur-[1px]"
      } ${selected ? "ring-2 ring-primary/40" : ""}`}
    >
      <div
        onPointerDown={(e) => onPointerDown(e, frame)}
        className={`absolute -top-3 left-3 flex max-w-[80%] cursor-grab items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium select-none active:cursor-grabbing ${
          isGroup ? "border-dashed" : ""
        }`}
        title={
          isGroup
            ? "Groupe — déplacer entraîne les éléments groupés"
            : "Cadre — déplacer entraîne son contenu"
        }
      >
        <GripHorizontal className="size-3 text-muted-foreground" />
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            size={Math.max(6, draft.length)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(frame.label);
                setEditing(false);
              }
              e.stopPropagation();
            }}
            className="bg-transparent outline-none"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(frame.label);
              setEditing(true);
            }}
          >
            {frame.label}
          </span>
        )}
        <span className="text-muted-foreground">· {memberCount}</span>
      </div>

      <div
        onPointerDown={(e) => onResizePointerDown(e, frame)}
        role="presentation"
        title="Redimensionner"
        className="absolute -right-1 -bottom-1 size-3 cursor-nwse-resize rounded-full border border-border bg-background"
      />
    </div>
  );
});
