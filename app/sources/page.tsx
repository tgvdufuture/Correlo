"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Plus } from "lucide-react";
import { PageShell } from "@/components/page-shell";
import { SourceImport } from "@/components/source-import";
import { SourceTable } from "@/components/source-table";
import { Card, CardContent } from "@/components/ui/card";
import type { SourceListItem } from "@/lib/api-types";

/** Bibliothèque (US-04) : liste + import + polling léger des statuts de jobs. */
export default function SourcesPage() {
  const [sources, setSources] = useState<SourceListItem[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sources");
      if (res.ok) setSources((await res.json()) as SourceListItem[]);
    } catch {
      // serveur indisponible : on garde l'état précédent
    }
  }, []);

  useEffect(() => {
    // chargement initial (setState asynchrone, hors rendu synchrone)
    void fetch("/api/sources")
      .then((res) => (res.ok ? (res.json() as Promise<SourceListItem[]>) : null))
      .then((data) => {
        if (data) setSources(data);
      })
      .catch(() => {
        // serveur indisponible : on garde l'état précédent
      });
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <PageShell
      icon={BookOpen}
      title="Bibliothèque"
      subtitle="Vos sources — découpées en fragments et indexées localement. Déposez-y des notes, des articles ou des PDF, ou importez une URL."
      wide
    >
      <div className="mb-8">
        <SourceImport onImported={() => void load()} />
      </div>

      {sources === null ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : sources.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <BookOpen className="size-8 text-muted-foreground" />
            <p className="font-medium">Votre bibliothèque est vide</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Déposez des notes, des articles ou des PDF (ou importez une URL) pour commencer.
              Chaque source est découpée en fragments ~2 000 caractères puis indexée
              localement via Ollama.
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Plus className="size-3.5" /> commencez par un premier dépôt ci-dessus
            </p>
          </CardContent>
        </Card>
      ) : (
        <SourceTable sources={sources} onChanged={() => void load()} />
      )}
    </PageShell>
  );
}
