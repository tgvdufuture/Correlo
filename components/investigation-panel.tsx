"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  INVESTIGATION_ACTION_LABEL,
  INVESTIGATION_STATUS_LABEL,
  type InvestigationCatalogueEntry,
  type InvestigationResponse,
  type InvestigationStep,
} from "@/lib/api-types";

/**
 * Investigation d'une suggestion (Phase 4, US-09).
 *
 * L'écran ne calcule rien et ne décide de rien : il déclenche l'enquête
 * (`POST …/investigate`), suit son avancement (`GET …/investigation`, tant que la file
 * ou l'enquête travaille) et affiche ce que le serveur a **vérifié**. La règle d'AC2
 * est appliquée ici comme dans l'API : une étape `failed` affiche ses citations comme
 * *rejetées*, jamais comme des preuves, et une entrée non vérifiable est montrée
 * comme indisponible — elle n'appuie plus aucune affirmation.
 *
 * Le composant est autonome (une seule prop) : il s'affiche aussi bien dans le feed
 * que dans le panneau de liens de l'atelier, sans état à remonter.
 */
export function InvestigationPanel({ suggestionId }: { suggestionId: string }) {
  const [state, setState] = useState<InvestigationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<InvestigationResponse> => {
    const res = await fetch(`/api/suggestions/${suggestionId}/investigation`);
    if (!res.ok) throw new Error(`état indisponible (${res.status})`);
    return (await res.json()) as InvestigationResponse;
  }, [suggestionId]);

  useEffect(() => {
    let alive = true;
    void load()
      .then((d) => alive && setState(d))
      .catch(() => alive && setError("État de l'enquête indisponible — rechargez la page."));
    return () => {
      alive = false;
    };
  }, [load]);

  // Suivi : on redemande l'état tant que la file ou l'enquête travaille, et on
  // s'arrête dès qu'une réponse est terminale (`done`/`failed`) — le serveur fait foi.
  useEffect(() => {
    if (!state || (state.status !== "pending" && state.status !== "running")) return;
    const timer = setTimeout(() => {
      void load()
        .then(setState)
        .catch(() => setError("Suivi interrompu — rechargez la page pour voir le résultat."));
    }, 2500);
    return () => clearTimeout(timer);
  }, [state, load]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/suggestions/${suggestionId}/investigate`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      setState(await load());
    } catch {
      setError("Enquête non lancée (le serveur n'a pas répondu).");
    } finally {
      setBusy(false);
    }
  };

  const doc = state?.investigation ?? null;
  const working = state?.status === "pending" || state?.status === "running";
  const byIndex = new Map<number, InvestigationCatalogueEntry>(
    (doc?.catalogue ?? []).map((e) => [e.index, e])
  );

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <Search className="size-3.5 text-muted-foreground" />
          {state ? INVESTIGATION_STATUS_LABEL[state.status] : "Chargement…"}
          {doc ? (
            <span className="text-muted-foreground">
              · {doc.steps.length}/{doc.step_budget} étape(s) · {doc.llm_calls} appel(s) LLM
              {doc.steps_from_cache > 0 ? ` (+${doc.steps_from_cache} en cache)` : ""}
            </span>
          ) : null}
        </span>
        <Button variant="outline" size="sm" disabled={busy || working} onClick={() => void start()}>
          {busy || working ? <Loader2 className="animate-spin" /> : <Search />}
          {state && state.status !== "none" ? "Relancer l'enquête" : "Investiguer"}
        </Button>
      </div>

      {working ? (
        <p role="status" className="text-xs text-muted-foreground">
          Un agent explore le corpus à partir de cette connexion : il cherche, élargit, puis
          conclut en citant ses sources. Cela peut prendre une minute.
        </p>
      ) : null}

      {state?.status === "none" ? (
        <p className="text-xs text-muted-foreground">
          Aucune enquête pour cette connexion. L&apos;agent reprend ses deux preuves, cherche
          dans le corpus, et conclut — chaque citation est revérifiée avant d&apos;être affichée.
        </p>
      ) : null}

      {doc?.failure ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {doc.failure === "step_budget_exhausted"
              ? "Le budget d'étapes est épuisé avant toute conclusion : l'enquête n'a rien établi."
              : doc.failure === "citation_hors_catalogue"
                ? "La conclusion citait un fragment jamais montré : elle est refusée et n'est pas affichée comme une preuve."
                : doc.failure === "sortie_invalide"
                  ? "Le modèle n'a pas rendu d'action exploitable : aucune conclusion n'a été produite."
                  : `Enquête interrompue (${doc.failure}).`}
          </span>
        </p>
      ) : null}

      {state?.status === "failed" && state.job?.error && !doc ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Échec du job : {state.job.error.code}
          {state.job.error.message ? ` — ${state.job.error.message}` : ""}
        </p>
      ) : null}

      {doc ? (
        <ol className="flex flex-col gap-3 border-t border-border pt-3">
          {doc.steps.map((step) => (
            <StepView key={step.index} step={step} byIndex={byIndex} />
          ))}
        </ol>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Une étape : ce que l'agent a fait, et — pour une conclusion — ce qu'il cite. */
function StepView({
  step,
  byIndex,
}: {
  step: InvestigationStep;
  byIndex: Map<number, InvestigationCatalogueEntry>;
}) {
  const cited = step.citations ?? [];
  const shown = cited.length > 0 ? cited : step.observation;
  return (
    <li className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Étape {step.index}</span>
        <Badge variant="outline">{INVESTIGATION_ACTION_LABEL[step.action]}</Badge>
        {step.input.query ? <span>« {step.input.query} »</span> : null}
        {step.input.fragment !== undefined ? <span>[{step.input.fragment}]</span> : null}
        {step.added.length > 0 ? <span>+{step.added.length} fragment(s)</span> : null}
        {step.failed ? (
          <Badge variant="destructive">étape échouée{step.failure ? ` · ${step.failure}` : ""}</Badge>
        ) : null}
      </p>

      {step.answer ? (
        <p className={step.failed ? "text-sm text-muted-foreground line-through" : "text-sm"}>
          {step.answer}
        </p>
      ) : null}

      {shown.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-l-2 border-border pl-2">
          {shown.map((index) => {
            const entry = byIndex.get(index);
            if (!entry) {
              return (
                <li key={index} className="text-xs text-destructive">
                  [{index}] citation rejetée — fragment jamais montré à l&apos;agent.
                </li>
              );
            }
            const unusable = entry.verified === false || step.failed;
            return (
              <li key={index} className="flex flex-col gap-0.5">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">[{index}]</span>{" "}
                  {entry.source_title ?? entry.source_id} · {entry.locator}
                  {unusable ? (
                    <span className="pl-1 text-destructive">
                      — {entry.problem ?? "citation d'une étape échouée"}, non retenue comme preuve
                    </span>
                  ) : null}
                </p>
                <p className="max-h-32 overflow-auto text-xs whitespace-pre-wrap">{entry.text}</p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
