"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Compass, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  type ConstructionItem,
  type FeedItem,
  type FeedbackReason,
} from "@/lib/api-types";

const REJECT_REASONS: FeedbackReason[] = ["trivial", "false", "already_known", "off_topic"];

/**
 * Feed de suggestions (Phase 3, US-05).
 *
 * Chaque ligne affiche claim, relation, tier, statut épistémique (définition au
 * survol — figé à la création) et ses 2 fragments citables. Deux actions :
 * intégrer (US-07, crée la Construction) ou rejeter avec une raison (US-06).
 *
 * `shown` est posé par le serveur quand le feed est servi ; `opened` l'est ici,
 * quand l'utilisateur déplie les preuves — c'est cette transition que mesure la
 * métrique « ≥ 40 % de suggestions ouvertes ».
 */
export function SuggestionFeed() {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Suggestion dont l'enquête (Phase 4) est dépliée sous la carte. */
  const [investigating, setInvestigating] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/suggestions");
      if (!res.ok) throw new Error(`feed indisponible (${res.status})`);
      setItems((await res.json()) as FeedItem[]);
      setError(null);
      setNotice(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "feed indisponible");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    // chargement initial (setState asynchrone, hors rendu synchrone)
    void fetch("/api/suggestions")
      .then((res) => (res.ok ? (res.json() as Promise<FeedItem[]>) : null))
      .then((data) => {
        if (data) {
          setItems(data);
          setError(null);
        }
      })
      .catch(() => {
        setError("feed indisponible");
        setItems([]);
      });
  }, []);

  /**
   * Déplier les preuves = ouvrir le détail (transition `opened` côté serveur).
   *
   * L'affichage est optimiste (les preuves s'ouvrent tout de suite) mais l'échec
   * du POST **n'est pas silencieux** : la métrique « suggestions ouvertes » se lit
   * en base, donc un échec non signalé ferait croire à une ouverture qui n'a pas
   * eu lieu. On revient alors à l'état serveur et on l'affiche.
   */
  const toggle = async (item: FeedItem) => {
    if (expanded === item.id) {
      setExpanded(null);
      return;
    }
    setExpanded(item.id);
    if (item.state === "opened" || item.state === "accepted" || item.state === "rejected") return;
    const previousState = item.state;
    setItems((prev) =>
      prev?.map((i) => (i.id === item.id ? { ...i, state: "opened" as const } : i)) ?? prev
    );
    try {
      const res = await fetch(`/api/suggestions/${item.id}/open`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setItems((prev) =>
        prev?.map((i) => (i.id === item.id ? { ...i, state: previousState } : i)) ?? prev
      );
      setError("Ouverture non enregistrée (le serveur n'a pas répondu) — rechargez le feed.");
    }
  };

  const accept = async (item: FeedItem) => {
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/suggestions/${item.id}/accept`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.status === 201) {
        const c = body as ConstructionItem;
        setNotice(
          `Suggestion intégrée : construction créée (${c.parent_source_ids.length} sources, ` +
            `${c.evidence_fragment_ids.length} preuves, statut ${c.epistemic_status}).`
        );
        setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
        setExpanded(null);
      } else if (res.status === 409) {
        setError("Cette suggestion a déjà été intégrée.");
        void load();
      } else {
        setError(`Intégration refusée (${body?.code ?? res.status}).`);
      }
    } finally {
      setBusy(null);
    }
  };

  const reject = async (item: FeedItem, reason: FeedbackReason) => {
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/suggestions/${item.id}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback_reason: reason }),
      });
      if (res.ok) {
        setNotice(`Suggestion rejetée (${FEEDBACK_REASON_LABEL[reason]}) — elle ne réapparaîtra pas.`);
        setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
        setExpanded(null);
      } else {
        const body = await res.json().catch(() => null);
        setError(`Rejet refusé (${body?.code ?? res.status}).`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Une seule suggestion par paire et par type de relation — la mieux classée.
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            aria-label="Recharger le feed"
          >
            <RefreshCw />
            Recharger
          </Button>
        </div>
      </div>

      {notice ? (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {items === null ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <Compass className="size-8 text-muted-foreground" />
            <p className="font-medium">Aucune connexion à examiner</p>
            <p className="max-w-md text-sm text-muted-foreground">
              La découverte compare des fragments de <strong>sources différentes</strong> : il en
              faut au moins deux ingérées, puis un run <code>npm run discover</code>. Les
              suggestions intégrées ou rejetées sortent définitivement de ce feed.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <Card>
                <CardContent className="flex flex-col gap-3 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">{item.claim}</p>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      <Badge variant="outline">{RELATION_LABEL[item.relation_type]}</Badge>
                      <Badge variant={item.tier === "strong" ? "default" : "secondary"}>
                        {TIER_LABEL[item.tier]}
                      </Badge>
                      <span
                        title={EPISTEMIC_DEFINITION[item.epistemic_status]}
                        aria-label={`Statut ${item.epistemic_status} : ${EPISTEMIC_DEFINITION[item.epistemic_status]}`}
                      >
                        <Badge variant={item.epistemic_status === "FACT" ? "destructive" : "outline"}>
                          {item.epistemic_status}
                        </Badge>
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void toggle(item)}
                      aria-expanded={expanded === item.id}
                    >
                      <ChevronDown
                        className={expanded === item.id ? "rotate-180 transition-transform" : "transition-transform"}
                      />
                      {expanded === item.id ? "Masquer" : "Ouvrir"} les preuves
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={investigating === item.id}
                      onClick={() =>
                        setInvestigating(investigating === item.id ? null : item.id)
                      }
                    >
                      <Search />
                      {investigating === item.id ? "Fermer" : "Investiguer"}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy === item.id}
                      onClick={() => void accept(item)}
                    >
                      {busy === item.id ? <Loader2 className="animate-spin" /> : <Check />}
                      Intégrer au canvas
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" disabled={busy === item.id}>
                          <X />
                          Rejeter
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuLabel>Raison du rejet</DropdownMenuLabel>
                        {REJECT_REASONS.map((reason) => (
                          <DropdownMenuItem key={reason} onSelect={() => void reject(item, reason)}>
                            {FEEDBACK_REASON_LABEL[reason]}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {investigating === item.id ? <InvestigationPanel suggestionId={item.id} /> : null}

                  {expanded === item.id ? (
                    <ol className="flex flex-col gap-2 border-t border-border pt-3">
                      {item.fragments.map((f) => (
                        <li key={f.id} className="flex flex-col gap-1">
                          <p className="text-xs text-muted-foreground">
                            {f.source_title ?? f.source_id} · {f.locator}
                          </p>
                          <p className="whitespace-pre-wrap text-sm">{f.text}</p>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
