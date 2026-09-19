import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { createJobsRepo, idempotencyKey, backoffDelayMs } from "@/lib/repositories/jobs";

function enqueueTestJob(jobs: ReturnType<typeof createJobsRepo>, key = "k1", kind: "ingest" | "summary" = "ingest") {
  return jobs.createJob({ kind, payload: { source_id: null }, sourceId: null, idempotencyKey: key });
}

describe("jobs queue", () => {
  it("create + claim : running, attempts=1, lease_token posé", () => {
    const { db } = makeTestDb();
    const jobs = createJobsRepo(db);
    enqueueTestJob(jobs);
    const [claimed] = jobs.claim(1);
    expect(claimed.status).toBe("running");
    expect(claimed.attempts).toBe(1);
    expect(claimed.lease_token).toBeTruthy();
    expect(claimed.lease_until).toBeTruthy();
    // plus rien à réclamer
    expect(jobs.claim(1)).toHaveLength(0);
  });

  it("claim respecte la concurrence (limit)", () => {
    const { db } = makeTestDb();
    const jobs = createJobsRepo(db);
    enqueueTestJob(jobs, "k1");
    enqueueTestJob(jobs, "k2");
    expect(jobs.claim(1)).toHaveLength(1);
    expect(jobs.claim(10)).toHaveLength(1);
  });

  it("écriture de statut exige le lease_token (worker zombie bloqué)", () => {
    const { db } = makeTestDb();
    const jobs = createJobsRepo(db);
    enqueueTestJob(jobs);
    const [claimed] = jobs.claim(1);
    expect(jobs.complete(claimed.id, "mauvais-token")).toBe(false);
    expect(jobs.getById(claimed.id)?.status).toBe("running");
    expect(jobs.complete(claimed.id, claimed.lease_token)).toBe(true);
  });

  it("recovery : lease expiré ⇒ pending + token effacé ; lease valide intact", () => {
    const { db } = makeTestDb();
    const jobs = createJobsRepo(db);
    enqueueTestJob(jobs, "k1");
    enqueueTestJob(jobs, "k2");
    const now = new Date();
    jobs.claim(1, now); // k1 : lease expire dans 60 s
    // on force l'expiration du lease de k1
    db.prepare("UPDATE jobs SET lease_until = ? WHERE idempotency_key = 'k1'").run(
      new Date(now.getTime() - 1000).toISOString()
    );
    jobs.claim(1, now); // k2 : lease valide (60 s)
    const recovered = jobs.recoverExpiredLeases(now);
    expect(recovered).toBe(1); // seul k1 est repris
    const k1 = db.prepare("SELECT * FROM jobs WHERE idempotency_key = 'k1'").get() as {
      status: string;
      lease_token: string | null;
    };
    expect(k1.status).toBe("pending");
    expect(k1.lease_token).toBeNull();
    const k2 = db.prepare("SELECT * FROM jobs WHERE idempotency_key = 'k2'").get() as {
      status: string;
    };
    expect(k2.status).toBe("running");
  });

  it("idempotency : même clé ⇒ remplacement, pas de doublon", () => {
    const { db } = makeTestDb();
    const jobs = createJobsRepo(db);
    const j1 = enqueueTestJob(jobs);
    jobs.complete(j1.id, "x"); // impossible : pas réclamé — on passe par claim
    const [claimed] = jobs.claim(1);
    jobs.complete(claimed.id, claimed.lease_token);
    // nouvelle opération logique pour la même clé : remplace le job done
    enqueueTestJob(jobs, "k1");
    expect(jobs.getById(claimed.id)?.status).toBe("pending");
    const count = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = 'k1'").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it("retry manuel : pending ; 409 au-delà de max attempts", () => {
    const { db } = makeTestDb();
    const jobs = createJobsRepo(db);
    const job = enqueueTestJob(jobs);
    db.prepare("UPDATE jobs SET attempts = 4 WHERE id = ?").run(job.id);
    expect(jobs.retry(job.id)).toMatchObject({ ok: true });
    expect(jobs.getById(job.id)?.status).toBe("pending");
    db.prepare("UPDATE jobs SET attempts = 5 WHERE id = ?").run(job.id);
    expect(jobs.retry(job.id)).toEqual({ ok: false, reason: "max_attempts" });
    expect(jobs.retry("inconnu")).toEqual({ ok: false, reason: "not_found" });
  });

  it("createJob rend la ligne EXISTANTE à l'upsert (l'id du job ne change pas)", () => {
    const { db } = makeTestDb();
    const jobs = createJobsRepo(db);
    const first = enqueueTestJob(jobs, "meme-operation");
    // ré-éditer la même opération logique conserve l'id : `createJob` doit donc
    // retrouver la ligne par sa clé, pas par le uuid qu'il vient de tirer (sinon il
    // rendrait `undefined`, et l'appelant perdrait l'id — cas d'une investigation
    // relancée, qui lit ensuite l'état de la file)
    const again = enqueueTestJob(jobs, "meme-operation");

    expect(again.id).toBe(first.id);
    expect(jobs.getByIdempotencyKey("meme-operation")?.id).toBe(first.id);
    expect(jobs.getByIdempotencyKey("inconnue")).toBeNull();
  });

  it("idempotencyKey : SHA256 stable et discriminant", () => {
    const a = idempotencyKey(["ingest", "s1", "h1", "chunker-v1"]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(idempotencyKey(["ingest", "s1", "h2", "chunker-v1"]));
  });

  it("backoff : exponentiel + jitter, Retry-After respecté", () => {
    const d1 = backoffDelayMs(1);
    expect(d1).toBeGreaterThanOrEqual(2000);
    expect(d1).toBeLessThan(3000);
    expect(backoffDelayMs(2)).toBeGreaterThanOrEqual(4000);
    const ra = backoffDelayMs(1, 7);
    expect(ra).toBeGreaterThanOrEqual(7000);
    expect(ra).toBeLessThan(8000);
  });
});