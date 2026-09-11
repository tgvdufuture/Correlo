/** Types de l'API bibliothèque (miroir de lib/repositories/sources.ts). */

export type JobStatus = "pending" | "running" | "done" | "failed";
export type SummaryStatus = "pending" | "done" | "failed";
export type SourceType = "TEXT" | "PDF" | "URL";

export interface SourceListItem {
  id: string;
  type: SourceType;
  title: string | null;
  canonical_path: string | null;
  content_hash: string;
  summary: string | null;
  summary_status: SummaryStatus;
  created_at: string;
  fragment_count: number;
  ingest_status: JobStatus;
  ingest_error: string | null;
  ingest_job_id: string | null;
  summary_error: string | null;
  summary_job_id: string | null;
}

export interface JobError {
  code: string;
  message?: string;
}

export function parseJobError(raw: string | null): JobError | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as JobError;
    return typeof parsed?.code === "string" ? parsed : null;
  } catch {
    return null;
  }
}