"use client";

import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EPISTEMIC_DEFINITION,
  type CanvasFrame,
  type CanvasItem,
} from "@/lib/api-types";

interface Props {
  item: CanvasItem | null;
  /** Conteneur de l'élément, s'il appartient à un groupe ou à un cadre. */
  frame: CanvasFrame | null;
  onClose: () => void;
  onUngroup: () => void;
}

/**
 * Inspecteur d'un élément du canvas.
 *
 * Pour une **Construction** (US-08 AC1) : la provenance affichée est la **copie**
 * faite à l'acceptation (`provenance_snapshot`), pas une jointure sur les fragments
 * vivants — c'est ce qui la rend lisible après suppression ou ré-ingestion d'une
 * source. Le bandeau « périmé » explique la conséquence au lieu de laisser un badge
 * sans contexte.
 *
 * Pour un **fichier** : ce que la bibliothèque sait de lui (statut d'ingestion,
 * fragments, résumé non citable) — l'utilisateur n'a pas à quitter le canvas pour
 * vérifier qu'un dépôt s'est bien passé.
 */
export function CanvasInspector({ item, frame, onClose, onUngroup }: Props) {
  if (!item) return null;

  return (
    <aside
      aria-label={item.kind === "source" ? "Détail du fichier" : "Détail de la construction"}
      className="flex w-full flex-col gap-4 rounded-xl border border-border bg-card p-4 lg:w-[380px] lg:shrink-0"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {item.kind === "source" ? (
            <>
              <Badge variant="outline">{item.source.type}</Badge>
              {item.source.ingest_status === "done" ? (
                <Badge variant="secondary">{item.source.fragment_count} fragment(s)</Badge>
              ) : (
                <Badge
                  variant={item.source.ingest_status === "failed" ? "destructive" : "secondary"}
                >
                  {item.source.ingest_status === "failed"
                    ? "ingestion échouée"
                    : item.source.ingest_status === "running"
                      ? "ingestion…"
                      : "en file"}
                </Badge>
              )}
            </>
          ) : (
            <>
              <Badge
                variant={item.construction.epistemic_status === "FACT" ? "destructive" : "outline"}
                title={EPISTEMIC_DEFINITION[item.construction.epistemic_status]}
              >
                {item.construction.epistemic_status}
              </Badge>
              {item.construction.stale ? (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="size-3" />
                  périmé
                </Badge>
              ) : null}
            </>
          )}
          {frame ? <Badge variant="secondary">{frame.label}</Badge> : null}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Fermer le détail" onClick={onClose}>
          <X />
        </Button>
      </div>

      {item.kind === "source" ? (
        <SourceDetail item={item} />
      ) : (
        <ConstructionDetail item={item} />
      )}

      {frame ? (
        <Button variant="outline" size="sm" onClick={onUngroup}>
          Retirer du groupe « {frame.label} »
        </Button>
      ) : null}
    </aside>
  );
}

function SourceDetail({ item }: { item: Extract<CanvasItem, { kind: "source" }> }) {
  const s = item.source;
  return (
    <>
      <p className="text-sm font-medium break-words">{s.title ?? s.id}</p>
      <p className="text-xs text-muted-foreground">
        Ajouté le {new Date(s.created_at).toLocaleString("fr-FR")} · empreinte{" "}
        {s.content_hash.slice(0, 12)}…
      </p>

      {s.ingest_error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {s.ingest_error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Résumé (non citable)
        </h2>
        <p className="max-h-56 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
          {s.summary ?? "Pas encore de résumé — l'ingestion puis le résumé s'enchaînent en tâche de fond."}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        {s.fragment_count} fragment(s) indexé(s). Les preuves citées dans une Construction sont des
        fragments — le résumé ne sert qu&apos;au routage et n&apos;est jamais cité.
      </p>

      <Button variant="outline" size="sm" asChild>
        <Link href="/sources">Ouvrir la bibliothèque</Link>
      </Button>
    </>
  );
}

function ConstructionDetail({ item }: { item: Extract<CanvasItem, { kind: "construction" }> }) {
  const c = item.construction;
  return (
    <>
      <p className="text-sm font-medium">{c.text}</p>

      <p className="text-xs text-muted-foreground">{EPISTEMIC_DEFINITION[c.epistemic_status]}</p>

      {c.stale ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Une source d&apos;origine a été supprimée ou ré-ingérée : la provenance ci-dessous est
          conservée telle qu&apos;elle était au moment de l&apos;intégration, mais l&apos;énoncé
          doit être réévalué.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Sources ({c.parent_source_ids.length})
        </h2>
        <ul className="flex flex-col gap-1 text-xs">
          {[...new Set(c.provenance_snapshot.map((p) => p.source_id))].map((id) => {
            const entry = c.provenance_snapshot.find((p) => p.source_id === id);
            return (
              <li key={id} className="truncate" title={id}>
                {entry?.source_title ?? id}
                <span className="text-muted-foreground"> · {String(id).slice(0, 8)}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Preuves ({c.provenance_snapshot.length})
        </h2>
        <ol className="flex flex-col gap-3">
          {c.provenance_snapshot.map((p) => (
            <li key={p.fragment_id} className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">
                {p.source_title ?? p.source_id} · {p.locator}
              </p>
              <p className="max-h-40 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
                {p.fragment_text}
              </p>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        <p>
          Fragment citable uniquement : {c.evidence_fragment_ids.length} fragment(s) · profondeur{" "}
          {c.depth}
        </p>
        {c.suggestion_id ? (
          <p className="truncate" title={c.suggestion_id}>
            Issue de la suggestion {c.suggestion_id.slice(0, 8)}
          </p>
        ) : null}
      </div>
    </>
  );
}
