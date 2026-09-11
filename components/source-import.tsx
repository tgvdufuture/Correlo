"use client";

import { useRef, useState, type DragEvent } from "react";
import { FileUp, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  onImported: () => void;
}

type Mode = "file" | "url";

/** Zone d'import (US-01/02/03) : dépôt de fichiers ou URL, import asynchrone via jobs. */
export function SourceImport({ onImported }: Props) {
  const [mode, setMode] = useState<Mode>("file");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const type = file.name.toLowerCase().endsWith(".pdf") ? "PDF" : "TEXT";
        const fd = new FormData();
        fd.set("type", type);
        fd.set("file", file);
        fd.set("title", file.name);
        const res = await fetch("/api/sources", { method: "POST", body: fd });
        const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
        if (!res.ok) {
          setError(mapError(res.status, body?.code, body?.message));
          return;
        }
      }
      onImported();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const submitUrl = async () => {
    const value = url.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "URL", url: value }),
      });
      const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
      if (!res.ok) {
        setError(mapError(res.status, body?.code, body?.message));
        return;
      }
      setUrl("");
      onImported();
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void handleFiles(e.dataTransfer.files);
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-1">
          <Button variant={mode === "file" ? "default" : "ghost"} size="sm" onClick={() => setMode("file")}>
            <FileUp /> Fichier
          </Button>
          <Button variant={mode === "url" ? "default" : "ghost"} size="sm" onClick={() => setMode("url")}>
            <Link2 /> URL
          </Button>
        </div>

        {mode === "file" ? (
          <div
            role="button"
            tabIndex={0}
            aria-label="Importer un fichier texte ou PDF"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
              dragOver ? "border-ring bg-muted" : "border-border"
            }`}
          >
            {busy ? (
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            ) : (
              <FileUp className="size-6 text-muted-foreground" />
            )}
            <p className="text-sm font-medium">
              Déposez vos notes, articles ou PDF ici — ou cliquez pour choisir
            </p>
            <p className="text-xs text-muted-foreground">.txt · .md · .pdf</p>
            <input
              ref={inputRef}
              type="file"
              accept=".txt,.md,.pdf"
              multiple
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="source-url">URL à importer</Label>
            <div className="flex gap-2">
              <Input
                id="source-url"
                type="url"
                placeholder="https://exemple.fr/article"
                value={url}
                disabled={busy}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitUrl();
                }}
              />
              <Button onClick={() => void submitUrl()} disabled={busy || !url.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : <Link2 />}
                Importer
              </Button>
            </div>
          </div>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function mapError(status: number, code?: string, message?: string): string {
  if (status === 409) return "Cette source existe déjà (contenu identique) — rien n'a été créé.";
  if (status === 422) return "PDF sans texte extractible (scanné ?).";
  if (status === 400 && code === "invalid_url") return "URL invalide.";
  if (status === 400 && code === "empty_extraction") return "Fichier vide.";
  return message || `Erreur d'import (${status}).`;
}