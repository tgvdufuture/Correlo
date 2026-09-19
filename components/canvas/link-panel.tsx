"use client";

import { useState } from "react";
import { Check, ChevronDown, Loader2, Search, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InvestigationPanel } from "@/components/investigation-panel";
import {
  EPISTEMIC_DEFINITION,
  FEEDBACK_REASON_LABEL,
  RELATION_LABEL,
  TIER_LABEL,
  type CanvasLink,
  type FeedbackReason,
} from "@/lib/api-types";

const REJECT_REASONS: FeedbackReason[] = ["trivial", "false", "already_known", "off_topic"];

interface Props {
  links: CanvasLink[];
  /** Titre du fichier par `source_id` (l'arête ne connaît que des identifiants). */
  sourceTitles: Record<string, string>;
  activeLinkId: string | null;
  busyId: string | null;
  /** Runs de découverte en attente / en cours : l'IA travaille pendant ce temps. */
  discovery: { pending: number; running: number } | null;
  onHoverLink: (id: string | null) => void;
  onOpened: (link: CanvasLink) => void;
  onAccept: (link: CanvasLink) => void;
  onReject: (link: CanvasLink, reason: FeedbackReason) => void;
}

/**
 * Panneau des liens du canvas : ce que l'IA propose entre les fichiers.
 *
 * Il remplace la page de feed comme lieu de travail — les mêmes actions (ouvrir les
 * preuves, intégrer, rejeter avec une raison), mais à côté des fichiers concernés :
 * on décide d'un lien en voyant **où** il se trouve. Le panneau ne calcule rien :
 * les liens viennent de l'état du canvas, les décisions remontent au parent.
 */
export function LinkPanel({
  links,
  sourceTitles,
  activeLinkId,
  busyId,
  discovery,
  onHoverLink,
  onOpened,
  onAccept,
  onReject,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Lien dont l'enquête (Phase 4) est dépliée sous la carte. */
  const [investigating, setInvestigating] = useState<string | null>(null);
  const working = discovery ? discovery.pending + discovery.running : 0;
  const open = links.filter((l) => l.state !== "accepted");

  const toggle = (link: CanvasLink) => {
    if (expanded === link.id) {
      setExpanded(null);
      return;
    }
    setExpanded(link.id);
    // déplier = ouvrir le détail : c'est cette transition que mesure la métrique
    // « ≥ 40 % de suggestions ouvertes », et elle est enregistrée par le parent
    if (link.state === "discovered" || link.state === "shown") onOpened(link);
  };

  return (
    <aside
      aria-label="Liens proposés entre les fichiers"
      className="flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-4 lg:w-[420px] lg:shrink-0"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-muted-foreground" />
          Liens proposés
        </h2>
        <Badge variant={open.length > 0 ? "default" : "secondary"}>{open.length}</Badge>
      </div>

      {working > 0 ? (
        <p
          role="status"
          data-discovery-running="true"
          className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {discovery?.running ? "Analyse des fichiers en cours" : "Analyse des fichiers en file"}
          {working > 1 ? ` (${working})` : ""} — les liens apparaîtront ici et sur le plan.
        </p>
      ) : null}

      {links.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          Aucun lien pour l&apos;instant. Déposez un fichier, ou attendez la fin de l&apos;analyse :
          elle compare chaque nouveau fichier aux autres et dessine ici ce qu&apos;elle trouve.
        </p>
      ) : (
        <ul className="flex max-h-[62vh] flex-col gap-2 overflow-auto pr-1">
          {links.map((link) => {
            const active = link.id === activeLinkId;
            const integrated = link.state === "accepted";
            return (
              <li
                key={link.id}
                data-link-card={link.id}
                onPointerEnter={() => onHoverLink(link.id)}
                onPointerLeave={() => onHoverLink(null)}
                className={`rounded-lg border p-3 transition-colors ${
                  active ? "border-primary bg-muted/40" : "border-border"
                }`}
              >
                <p className="text-xs text-muted-foreground">
                  {sourceTitles[link.from_source_id] ?? link.from_source_id.slice(0, 8)}
                  <span className="px-1">↔</span>
                  {sourceTitles[link.to_source_id] ?? link.to_source_id.slice(0, 8)}
                </p>
                <div className="mt-1.5 flex items-start justify-between gap-2">
                  <p className="text-sm leading-snug font-medium">{link.claim}</p>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <Badge variant="outline">{RELATION_LABEL[link.relation_type]}</Badge>
                    <Badge variant={link.tier === "strong" ? "default" : "secondary"}>
                      {TIER_LABEL[link.tier]}
                    </Badge>
                    <span
                      title={EPISTEMIC_DEFINITION[link.epistemic_status]}
                      aria-label={`Statut ${link.epistemic_status} : ${EPISTEMIC_DEFINITION[link.epistemic_status]}`}
                    >
                      <Badge variant={link.epistemic_status === "FACT" ? "destructive" : "outline"}>
                        {link.epistemic_status}
                      </Badge>
                    </span>
                  </div>
                </div>

                {integrated ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Déjà intégrée au canvas (la construction porte ce lien).
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggle(link)}
                      aria-expanded={expanded === link.id}
                    >
                      <ChevronDown
                        className={
                          expanded === link.id
                            ? "rotate-180 transition-transform"
                            : "transition-transform"
                        }
                      />
                      {expanded === link.id ? "Masquer" : "Ouvrir"} les preuves
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={investigating === link.id}
                      onClick={() =>
                        setInvestigating(investigating === link.id ? null : link.id)
                      }
                    >
                      <Search />
                      {investigating === link.id ? "Fermer" : "Investiguer"}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busyId === link.id}
                      onClick={() => onAccept(link)}
                    >
                      {busyId === link.id ? <Loader2 className="animate-spin" /> : <Check />}
                      Intégrer
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" disabled={busyId === link.id}>
                          <X />
                          Rejeter
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuLabel>Raison du rejet</DropdownMenuLabel>
                        {REJECT_REASONS.map((reason) => (
                          <DropdownMenuItem
                            key={reason}
                            onSelect={() => onReject(link, reason)}
                          >
                            {FEEDBACK_REASON_LABEL[reason]}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}

                {investigating === link.id ? <InvestigationPanel suggestionId={link.id} /> : null}

                {expanded === link.id ? (
                  <ol className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
                    {link.fragments.map((f) => (
                      <li key={f.id} className="flex flex-col gap-1">
                        <p className="text-xs text-muted-foreground">
                          {f.source_title ?? sourceTitles[f.source_id] ?? f.source_id} · {f.locator}
                        </p>
                        <p className="max-h-40 overflow-auto text-xs whitespace-pre-wrap">{f.text}</p>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
