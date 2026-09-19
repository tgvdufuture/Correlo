"use client";

import { useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FlaskConical,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  EPISTEMIC_DEFINITION,
  EVIDENCE_PROBLEM_LABEL,
  SYNTHESIS_CONFIDENCE_LABEL,
  SYNTHESIS_RELATION_LABEL,
  type SynthesisFeedItem,
} from "@/lib/api-types";

/**
 * Feed de synthèses (Phase 5B, amendement v1.3 §3).
 *
 * Le serveur a déjà vérifié les preuves **à la lecture** : ce composant n'affiche que
 * ce qu'il reçoit — une preuve `verified: false` est montrée avec sa raison et jamais
 * comme une citation saine, le `provenance_snapshot` (copie au moment T) reste lisible
 * quand la source a disparu. L'écran ne refait aucun calcul : deux lectures du même
 * état ne peuvent pas diverger.
 *
 * Une synthèse tranchée sort du feed (le défaut de lecture est `proposed`) ; le rejet
 * est sans motif, comme le PRD le spécifie pour cette phase.
 */
/**
 * Chargement initial **hors effet à setState direct** : `useSyncExternalStore` avec un
 * store minimal (lint `react-hooks/set-state-in-effect`, appliqué par Next 16). Le store
 * garde le dernier état servi ; chaque abonné déclenche le premier `fetch`, et
 * `reload()` le relance à la demande. Un composant démonté n'écrit plus rien.
 *
 * La page est prérendue : le snapshot **serveur** est le même objet vide que le client
 * initial, donc le HTML rendu est un « Chargement… » et le fetch ne part qu'une fois
 * monté — le feed n'a aucun sens côté serveur, il dépend de la base locale.
 */
const EMPTY_SNAPSHOT = { items: null as SynthesisFeedItem[] | null, error: null as string | null };

function createFeedStore() {
  let items: SynthesisFeedItem[] | null = null;
  let error: string | null = null;
  /**
   * Snapshot **caché** : `useSyncExternalStore` compare les lectures avec `Object.is`,
   * un objet fabriqué à chaque appel ferait boucler le rendu (React #185 — constaté en
   * vérification navigateur, invisible au build car le prérendu sert le snapshot
   * serveur, qui est constant). On ne remplace l'objet qu'au changement réel.
   */
  let snap: { items: SynthesisFeedItem[] | null; error: string | null } = {
    items: null,
    error: null,
  };
  const listeners = new Set<() => void>();
  let fetching = false;

  const emit = () => listeners.forEach((l) => l());

  const fetchNow = async () => {
    if (fetching) return;
    fetching = true;
    try {
      const res = await fetch("/api/syntheses");
      if (!res.ok) throw new Error(`feed indisponible (${res.status})`);
      items = (await res.json()) as SynthesisFeedItem[];
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : "feed indisponible";
      items = [];
    } finally {
      fetching = false;
      snap = { items, error };
      emit();
    }
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      // premier abonné : déclenche le chargement (une fois par série d'abonnements)
      if (listeners.size === 1 && items === null && !fetching) void fetchNow();
      return () => listeners.delete(listener);
    },
    snapshot: () => snap,
    reload: fetchNow,
  };
}

const feedStore = createFeedStore();

export function SynthesisFeed() {
  const { items, error } = useSyncExternalStore(
    feedStore.subscribe,
    feedStore.snapshot,
    () => EMPTY_SNAPSHOT
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const decide = async (item: SynthesisFeedItem, decision: "accept" | "reject") => {
    setBusy(item.id);
    setDecisionError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/syntheses/${item.id}/${decision}`, { method: "POST" });
      if (res.ok) {
        setNotice(
          decision === "accept"
            ? "Synthèse acceptée — elle sort de la file des propositions."
            : "Synthèse rejetée — elle ne réapparaîtra pas, ni reformulée."
        );
        setDecisionError(null);
        setExpanded(null);
        // la synthèse tranchée sort du feed : on relit la source de vérité
        void feedStore.reload();
      } else {
        const body = (await res.json().catch(() => null)) as { code?: string } | null;
        setNotice(null);
        setDecisionError(
          res.status === 409
            ? "Cette synthèse a déjà été tranchée."
            : `Décision refusée (${body?.code ?? res.status}).`
        );
        void feedStore.reload();
      }
    } catch {
      setDecisionError("Le serveur n'a pas répondu — la décision n'est pas prise.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Énoncés multi-sources qui ajoutent aux documents — triés par thème puis
          confiance. Les preuves sont revérifiées à chaque lecture.
        </p>
        <Button variant="outline" size="sm" onClick={() => void feedStore.reload()} aria-label="Recharger le feed">
          <RefreshCw />
          Recharger
        </Button>
      </div>

      {notice ? (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm" role="status">
          {notice}
        </p>
      ) : null}
      {decisionError ? (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {decisionError}
        </p>
      ) : null}
      {error ? (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {items === null ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <FlaskConical className="size-8 text-muted-foreground" />
            <p className="font-medium">Aucune synthèse à examiner</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Les synthèses sont produites par le moteur (Phase 5A) à partir de graines —
              paires de fragments de deux documents différents. Lancez{" "}
              <code>npm run synth</code>, puis revenez ici.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <Card className={item.stale ? "border-dashed" : undefined}>
                <CardContent className="flex flex-col gap-3 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <p className="text-xs text-muted-foreground">
                        Thème «&nbsp;{item.theme.label}&nbsp;» · graine{" "}                              <code className="text-[10px]">{item.theme.seed.slice(0, 10)}…</code>
                      </p>
                      <p className="text-sm font-medium">{item.text}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      <Badge variant="outline">{SYNTHESIS_RELATION_LABEL[item.relation_kind]}</Badge>
                      <Badge variant={item.confidence === "high" ? "default" : "secondary"}>
                        confiance {SYNTHESIS_CONFIDENCE_LABEL[item.confidence]}
                      </Badge>
                      <span
                        title={EPISTEMIC_DEFINITION[item.epistemic_status]}
                        aria-label={`Statut ${item.epistemic_status} : ${EPISTEMIC_DEFINITION[item.epistemic_status]}`}
                      >
                        <Badge variant="outline">{item.epistemic_status}</Badge>
                      </span>
                      {item.stale ? (
                        <Badge variant="destructive" title="Une preuve a disparu ou changé">
                          <AlertTriangle />
                          périmée
                        </Badge>
                      ) : null}
                    </div>
                  </div>

                  {item.provenance_lost ? (
                    <p
                      className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                      role="alert"
                    >
                      Copie de provenance illisible : les preuves existent par leurs
                      identifiants, mais il n&apos;y a rien à afficher.
                    </p>
                  ) : null}
                  {!item.provenance_lost && item.unverified > 0 ? (
                    <p
                      className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
                      role="alert"
                    >
                      {item.unverified} preuve(s) ne tienne(nt) plus — l&apos;énoncé est à
                      réévaluer ; la copie au moment T reste consultable ci-dessous.
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                      aria-expanded={expanded === item.id}
                    >
                      <ChevronDown
                        className={expanded === item.id ? "rotate-180 transition-transform" : "transition-transform"}
                      />
                      {expanded === item.id ? "Masquer" : "Voir"} les preuves ({item.evidence.length})
                    </Button>
                    <Button size="sm" disabled={busy === item.id} onClick={() => void decide(item, "accept")}>
                      {busy === item.id ? <Loader2 className="animate-spin" /> : <Check />}
                      Accepter
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === item.id}
                      onClick={() => void decide(item, "reject")}
                    >
                      <X />
                      Rejeter
                    </Button>
                  </div>

                  {expanded === item.id ? (
                    <ol className="flex flex-col gap-2 border-t border-border pt-3">
                      {item.evidence.map((e) => (
                        <li key={e.fragment_id} className="flex flex-col gap-1">
                          <p className="text-xs text-muted-foreground">
                            {e.source_title ?? (e.source_id || "(source inconnue)")} · {e.locator || "(locator absent)"}
                            {e.verified ? (
                              ""
                            ) : (
                              <span className="ml-2 font-medium text-destructive">
                                preuve invalide : {e.problem ? EVIDENCE_PROBLEM_LABEL[e.problem] : "non vérifiable"}
                              </span>
                            )}
                          </p>
                          <p className={`whitespace-pre-wrap text-sm ${e.verified ? "" : "text-muted-foreground"}`}>
                            {e.text || "(copie de provenance vide)"}
                          </p>
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
