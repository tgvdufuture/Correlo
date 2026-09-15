import { describe, expect, it } from "vitest";
import { LlmNetworkError, LlmOutputError, LlmRateLimitError, LlmTransientError } from "@/lib/llm/errors";
import {
  MAX_PROVIDER_ATTEMPTS,
  TRANSIENT_BACKOFF_BASE_MS,
  providerRetryDelayMs,
} from "@/lib/llm/retry";

/**
 * Le PRD borne les *jobs* à 5 tentatives (§3.4). Un incident passager du provider
 * (503, timeout) ne doit pas en consommer une : sinon un run de 12 batchs échoue par
 * épuisement de compteur alors que le provider pouvait encore le servir (mesuré en
 * réel : 2 tentatives sur 5 consommées en 4 batchs).
 */
describe("politique de réessai des incidents provider", () => {
  it("un incident passager reste une erreur réseau (le worker continue de la tracer comme telle)", () => {
    expect(new LlmTransientError("503")).toBeInstanceOf(LlmNetworkError);
    expect(providerRetryDelayMs(new LlmTransientError("503"), 0)).not.toBeNull();
  });

  it("réessaie un incident passager avec un backoff croissant et borné", () => {
    const delays: number[] = [];
    for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
      const d = providerRetryDelayMs(new LlmTransientError("timeout"), attempt);
      expect(d).not.toBeNull();
      delays.push(d as number);
    }
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
    // jitter ±20 % autour de la base du premier essai, plafond respecté au dernier
    expect(delays[0]).toBeGreaterThanOrEqual(TRANSIENT_BACKOFF_BASE_MS * 0.8);
    expect(delays[0]).toBeLessThanOrEqual(TRANSIENT_BACKOFF_BASE_MS * 1.2);
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(36_000);
  });

  it("respecte Retry-After, mais plafonné (un délai énorme figerait le worker)", () => {
    expect(providerRetryDelayMs(new LlmRateLimitError(30), 0)).toBe(35_000);
    expect(providerRetryDelayMs(new LlmRateLimitError(1_500), 0)).toBe(125_000);
  });

  it("ne réessaie pas une erreur définitive (modèle inconnu, sortie invalide)", () => {
    expect(providerRetryDelayMs(new LlmNetworkError("HTTP 404 modèle inconnu"), 0)).toBeNull();
    expect(providerRetryDelayMs(new LlmOutputError("JSON non parsable"), 0)).toBeNull();
    expect(providerRetryDelayMs(new Error("boum"), 0)).toBeNull();
  });
});
