/**
 * Instrumentation Next.js : recovery au boot + démarrage du worker.
 * Uniquement en runtime Node.js, jamais pendant `next build`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { bootServer } = await import("@/lib/jobs/bootstrap");
  bootServer();
}