import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import { nowIso } from "@/lib/db/client";
import { sha256Hex } from "@/lib/hash";

// `synthesize` ajouté par la migration 003 (Phase 5A, amendement v1.3).
// `reembed` ajouté par la migration 008 : re-vectorisation du corpus après une
// bascule de connecteur d'embeddings (Ollama ↔ API).
// `investigation` a été câblé par la Phase 4 du PRD v1.2 (US-09) : un job par
// suggestion, un rejeu du même job met à jour la ligne d'investigation (job.id).
// `conversation` ajouté par la migration 009 (Phase 6, amendement v1.3 §13) : un job par
// **tour**, dont l'id est celui du message de réponse (un rejeu met à jour cette ligne).
export type JobKind =
  | "ingest"
  | "summary"
  | "discover"
  | "investigation"
  | "synthesize"
  | "reembed"
  | "conversation";
export type JobStatus = "pending" | "running" | "done" | "failed";

export interface JobRow {
  id: string;
  kind: JobKind;
  payload: string;
  status: JobStatus;
  attempts: number;
  error: string | null;
  idempotency_key: string;
  source_id: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  lease_token: string | null;
  checkpoint: string | null;
  progress_json: string | null;
  created_at: string;
  updated_at: string;
  next_run_at: string;
}

export interface ClaimedJob extends JobRow {
  lease_token: string;
}

export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 5;

export interface JobsRepo {
  /**
   * Crée un job (upsert par idempotency_key : même opération logique ⇒
   * remplacement, attempts conservés, checkpoint remis à zéro).
   */
  createJob(input: {
    kind: JobKind;
    payload: unknown;
    /** uuid NULL autorisé par le schéma (PRD §3.3). */
    sourceId: string | null;
    idempotencyKey: string;
  }): JobRow;
  /** Réclame jusqu'à `limit` jobs pending échus ; attempts++ à la réclamation. */
  claim(limit: number, now?: Date): ClaimedJob[];
  getById(id: string): JobRow | null;
  /**
   * Job d'une opération logique donnée (clé d'idempotence). Utilisé par la lecture
   * d'une investigation : l'état de la file (« en attente », « en cours », « échec
   * structuré ») doit rester lisible avant même que le worker n'ait écrit sa ligne.
   */
  getByIdempotencyKey(key: string): JobRow | null;
  /** Writes de statut : exige le lease_token correspondant (worker zombie bloqué). */
  complete(id: string, leaseToken: string): boolean;
  fail(id: string, leaseToken: string, errorJson: string): boolean;
  requeue(id: string, leaseToken: string, nextRunAtIso: string): boolean;
  renewLease(id: string, leaseToken: string, now?: Date): boolean;
  updateCheckpoint(id: string, leaseToken: string, checkpointJson: string, progressJson: string): boolean;
  /** Recovery au boot : uniquement les jobs running dont lease est expiré. */
  recoverExpiredLeases(now?: Date): number;
  /** Relance manuelle : pending ; null si introuvable ; 'max_attempts' si épuisé. */
  retry(id: string): { ok: true; job: JobRow } | { ok: false; reason: "not_found" | "max_attempts" };
}

export function createJobsRepo(db: Db): JobsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO jobs (id, kind, payload, status, attempts, error, idempotency_key,
       source_id, created_at, updated_at, next_run_at)
     VALUES (@id, @kind, @payload, 'pending', 0, NULL, @idempotency_key, @source_id,
       @created_at, @updated_at, @next_run_at)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       payload = excluded.payload,
       status = 'pending',
       error = NULL,
       checkpoint = NULL,
       progress_json = NULL,
       lease_token = NULL,
       lease_until = NULL,
       updated_at = excluded.updated_at,
       next_run_at = excluded.next_run_at`
  );

  return {
    createJob({ kind, payload, sourceId, idempotencyKey }) {
      const now = nowIso();
      const id = randomUUID();
      insertStmt.run({
        id,
        kind,
        payload: JSON.stringify(payload),
        idempotency_key: idempotencyKey,
        source_id: sourceId,
        created_at: now,
        updated_at: now,
        next_run_at: now,
      });
      // `ON CONFLICT(idempotency_key) DO UPDATE` **conserve l'id de la ligne existante** :
      // après un upsert, la clé primaire n'est donc pas le uuid qu'on vient de tirer.
      // Sans ce repli, `createJob` renverrait `undefined` sur toute ré-édition d'une même
      // opération logique — et l'appelant perdrait l'id du job (qui sert par exemple à lire
      // l'état de la file d'une investigation).
      const inserted = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
      return inserted ?? (db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(idempotencyKey) as JobRow);
    },

    claim(limit: number, now = new Date()): ClaimedJob[] {
      const iso = now.toISOString();
      const claim = db.transaction((): ClaimedJob[] => {
        const rows = db
          .prepare(
            `SELECT * FROM jobs WHERE status = 'pending' AND next_run_at <= ?
             ORDER BY next_run_at ASC, created_at ASC, rowid ASC LIMIT ?`
          )
          .all(iso, limit) as JobRow[];
        const update = db.prepare(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1,
             lease_token = ?, lease_until = ?, heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`
        );
        const claimed: ClaimedJob[] = [];
        for (const row of rows) {
          const token = randomUUID();
          update.run(
            token,
            new Date(now.getTime() + LEASE_MS).toISOString(),
            iso,
            iso,
            row.id
          );
          claimed.push({
            ...row,
            status: "running",
            lease_token: token,
            attempts: row.attempts + 1,
            lease_until: new Date(now.getTime() + LEASE_MS).toISOString(),
            heartbeat_at: iso,
            updated_at: iso,
          });
        }
        return claimed;
      });
      return claim();
    },

    getById(id: string): JobRow | null {
      return (db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null;
    },

    getByIdempotencyKey(key) {
      return (
        (db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key) as
          | JobRow
          | undefined) ?? null
      );
    },

    complete(id, leaseToken): boolean {
      const res = db
        .prepare(
          `UPDATE jobs SET status = 'done', error = NULL, lease_token = NULL,
             lease_until = NULL, heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND lease_token = ?`
        )
        .run(nowIso(), id, leaseToken);
      return res.changes === 1;
    },

    fail(id, leaseToken, errorJson): boolean {
      const res = db
        .prepare(
          `UPDATE jobs SET status = 'failed', error = ?, lease_token = NULL,
             lease_until = NULL, heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND lease_token = ?`
        )
        .run(errorJson, nowIso(), id, leaseToken);
      return res.changes === 1;
    },

    requeue(id, leaseToken, nextRunAtIso): boolean {
      const res = db
        .prepare(
          `UPDATE jobs SET status = 'pending', lease_token = NULL, lease_until = NULL,
             heartbeat_at = NULL, next_run_at = ?, updated_at = ?
           WHERE id = ? AND lease_token = ?`
        )
        .run(nextRunAtIso, nowIso(), id, leaseToken);
      return res.changes === 1;
    },

    renewLease(id, leaseToken, now = new Date()): boolean {
      const res = db
        .prepare(
          `UPDATE jobs SET lease_until = ?, heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND lease_token = ?`
        )
        .run(
          new Date(now.getTime() + LEASE_MS).toISOString(),
          now.toISOString(),
          now.toISOString(),
          id,
          leaseToken
        );
      return res.changes === 1;
    },

    updateCheckpoint(id, leaseToken, checkpointJson, progressJson): boolean {
      const res = db
        .prepare(
          `UPDATE jobs SET checkpoint = ?, progress_json = ?, updated_at = ?
           WHERE id = ? AND lease_token = ?`
        )
        .run(checkpointJson, progressJson, nowIso(), id, leaseToken);
      return res.changes === 1;
    },

    recoverExpiredLeases(now = new Date()): number {
      const res = db
        .prepare(
          `UPDATE jobs SET status = 'pending', lease_token = NULL, lease_until = NULL,
             heartbeat_at = NULL, updated_at = ?
           WHERE status = 'running' AND lease_until < ?`
        )
        .run(now.toISOString(), now.toISOString());
      return res.changes;
    },

    retry(id) {
      const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
      if (!row) return { ok: false, reason: "not_found" };
      if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "max_attempts" };
      db.prepare(
        `UPDATE jobs SET status = 'pending', error = NULL, lease_token = NULL,
           lease_until = NULL, heartbeat_at = NULL, next_run_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(nowIso(), nowIso(), id);
      return { ok: true, job: db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow };
    },
  };
}

/** Clé d'idempotence : SHA256(kind, source_id, content_hash, chunker_version, modèle, prompt_version). */
export function idempotencyKey(parts: string[]): string {
  return sha256Hex(parts.join("|"));
}

/** Backoff exponentiel + jitter (respecte Retry-After si fourni). */
export function backoffDelayMs(attempts: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) {
    return Math.min(retryAfterSeconds * 1000, 300_000) + Math.floor(Math.random() * 1000);
  }
  const base = Math.min(Math.pow(2, attempts - 1) * 2000, 300_000);
  return base + Math.floor(Math.random() * 1000);
}