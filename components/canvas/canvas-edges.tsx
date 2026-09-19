"use client";

import { itemSize } from "@/components/canvas/canvas-items";
import { RELATION_LABEL, TIER_LABEL, type CanvasItem, type CanvasLink } from "@/lib/api-types";

/**
 * Les liens du canvas, dessinés comme des arêtes entre **fichiers**.
 *
 * Une suggestion relie deux fragments, donc deux sources : l'arête va du centre
 * d'un fichier à celui de l'autre. Elle est donc *dérivée* — rien n'est stocké pour
 * la position d'un lien, sa géométrie suit les fichiers. Un fichier retiré du
 * canvas (source supprimée) fait disparaître ses arêtes sans nettoyage.
 *
 * Le trait porte la couleur du tier ; la relation est écrite au point médian **du
 * seul lien actif** (survol ou sélection) : étiqueter les 40 arêtes les rendrait
 * illisibles.
 */
export interface CanvasEdgesProps {
  items: CanvasItem[];
  links: CanvasLink[];
  activeLinkId: string | null;
  onHoverLink: (id: string | null) => void;
  onSelectLink: (id: string) => void;
}

export function CanvasEdges({
  items,
  links,
  activeLinkId,
  onHoverLink,
  onSelectLink,
}: CanvasEdgesProps) {
  const centers = new Map<string, { x: number; y: number }>();
  for (const item of items) {
    if (item.kind !== "source") continue;
    const { w, h } = itemSize(item.kind);
    centers.set(item.ref, { x: item.x + w / 2, y: item.y + h / 2 });
  }

  return (
    <svg
      className="pointer-events-none absolute top-0 left-0 overflow-visible"
      aria-hidden="true"
      data-canvas-edges="true"
      width={1}
      height={1}
    >
      {links.map((link) => {
        const a = centers.get(link.from_source_id);
        const b = centers.get(link.to_source_id);
        if (!a || !b) return null;
        const active = link.id === activeLinkId;
        const integrated = link.state === "accepted";
        const color = integrated
          ? "var(--muted-foreground)"
          : link.tier === "strong"
            ? "var(--primary)"
            : link.tier === "medium"
              ? "var(--chart-3, var(--primary))"
              : "var(--muted-foreground)";
        return (
          <g
            key={link.id}
            data-canvas-link={link.id}
            data-link-state={link.state}
            data-link-active={active ? "true" : undefined}
          >
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={color}
              strokeWidth={active ? 2.5 : 1.5}
              strokeDasharray={integrated ? "6 4" : undefined}
              opacity={active ? 1 : 0.45}
            />
            {/* cible de clic large : un trait de 1,5 px est introuvable à la souris */}
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="transparent"
              strokeWidth={14}
              style={{ pointerEvents: "stroke", cursor: "pointer" }}
              onPointerEnter={() => onHoverLink(link.id)}
              onPointerLeave={() => onHoverLink(null)}
              onClick={() => onSelectLink(link.id)}
            />
            {active ? (
              <text
                x={(a.x + b.x) / 2}
                y={(a.y + b.y) / 2 - 8}
                textAnchor="middle"
                className="fill-foreground text-[11px]"
                style={{ pointerEvents: "none" }}
              >
                {RELATION_LABEL[link.relation_type]} · {TIER_LABEL[link.tier]}
                {integrated ? " · intégrée" : ""}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
