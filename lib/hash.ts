import { createHash } from "node:crypto";

/** SHA-256 hex d'une chaîne UTF-8 (content_hash, idempotency_key, content_sig). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}