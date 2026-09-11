import { ensureDataDirs, getDb } from "@/lib/db/client";
import { createJobsRepo } from "@/lib/repositories/jobs";
import { createWorker } from "@/lib/jobs/worker";

let started = false;

/**
 * Recovery au boot (F1.4 AC1-AC2) : seuls les jobs running dont le lease est
 * expiré repassent pending ; le worker démarre en arrière-plan (concurrence 1–2).
 */
export function bootServer(): void {
  if (started) return;
  started = true;

  ensureDataDirs();
  const db = getDb();
  const jobs = createJobsRepo(db);
  const recovered = jobs.recoverExpiredLeases();
  if (recovered > 0) {
    console.log(`[jobs] recovery : ${recovered} job(s) repris après lease expiré`);
  }

  const worker = createWorker();
  void worker.run().catch((err) => {
    console.error("[jobs] worker arrêté sur erreur :", err);
  });
}