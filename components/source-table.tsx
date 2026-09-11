"use client";

import { useState } from "react";
import { Loader2, RotateCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { parseJobError, type JobStatus, type SourceListItem } from "@/lib/api-types";

interface Props {
  sources: SourceListItem[];
  onChanged: () => void;
}

const TYPE_LABEL: Record<SourceListItem["type"], string> = {
  TEXT: "Texte",
  PDF: "PDF",
  URL: "URL",
};

/** Bibliothèque (US-04) : liste, statuts de jobs visibles avec leur erreur, relance, suppression. */
export function SourceTable({ sources, onChanged }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const retry = async (jobId: string) => {
    setBusyId(jobId);
    try {
      await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (source: SourceListItem) => {
    if (!window.confirm(`Supprimer « ${source.title ?? source.id} » et ses fragments ?`)) return;
    await fetch(`/api/sources/${source.id}`, { method: "DELETE" });
    onChanged();
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>Date</TableHead>
          <TableHead className="text-right">Fragments</TableHead>
          <TableHead>Ingestion</TableHead>
          <TableHead>Résumé</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sources.map((s) => {
          const ingestError = parseJobError(s.ingest_error);
          const summaryError = parseJobError(s.summary_error);
          return (
            <TableRow key={s.id}>
              <TableCell className="max-w-[320px]">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{TYPE_LABEL[s.type]}</Badge>
                  <span className="truncate font-medium" title={s.title ?? undefined}>
                    {s.title ?? s.id}
                  </span>
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {new Date(s.created_at).toLocaleDateString("fr-FR", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
              </TableCell>
              <TableCell className="text-right tabular-nums">{s.fragment_count}</TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <StatusBadge status={s.ingest_status} />
                  {s.ingest_status === "failed" && ingestError ? (
                    <span className="text-xs text-destructive" title={ingestError.message}>
                      {errorLabel(ingestError.code, ingestError.message)}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <StatusBadge status={s.summary_status} />
                  {s.summary_status === "failed" && summaryError ? (
                    <span className="text-xs text-destructive" title={summaryError.message}>
                      {errorLabel(summaryError.code, summaryError.message)}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  {s.ingest_status === "failed" && s.ingest_job_id ? (
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="Relancer l'ingestion"
                      title="Relancer l'ingestion"
                      disabled={busyId === s.ingest_job_id}
                      onClick={() => void retry(s.ingest_job_id as string)}
                    >
                      {busyId === s.ingest_job_id ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <RotateCw />
                      )}
                    </Button>
                  ) : null}
                  {s.summary_status === "failed" && s.summary_job_id ? (
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="Relancer le résumé"
                      title="Relancer le résumé"
                      disabled={busyId === s.summary_job_id}
                      onClick={() => void retry(s.summary_job_id as string)}
                    >
                      {busyId === s.summary_job_id ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <RotateCw />
                      )}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Supprimer la source"
                    title="Supprimer"
                    onClick={() => void remove(s)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: "en attente",
  running: "en cours",
  done: "terminé",
  failed: "échec",
};

function StatusBadge({ status }: { status: JobStatus }) {
  const variant =
    status === "failed" ? "destructive" : status === "done" ? "default" : "secondary";
  return (
    <Badge variant={variant} className={status === "running" ? "animate-pulse" : undefined}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function errorLabel(code: string, message?: string): string {
  if (code === "missing_groq_api_key") {
    return "Clé Groq manquante — configurez .env.local puis relancez.";
  }
  return message ?? code;
}