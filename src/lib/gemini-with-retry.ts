import {
  GoogleGenerativeAIAbortError,
  type GenerateContentResult,
  type GenerativeModel,
} from "@google/generative-ai";

const RETRY_DELAYS_MS = [3000, 6000, 12000];

// Confirmed live 2026-09-22: a hung/overloaded Gemini request can sit with
// zero bytes back for 90s+ with no error at all (not even a slow 503) — so
// without a hard per-attempt cutoff, one bad attempt can silently burn the
// entire retry budget. This aborts a single attempt so it counts as a
// retryable failure instead of an unbounded hang.
const PER_ATTEMPT_TIMEOUT_MS = 20000;

export const GEMINI_OVERLOAD_MESSAGE =
  "Gemini AI is experiencing high demand right now. Please wait a few minutes and try again.";

export class GeminiOverloadedError extends Error {
  constructor(cause?: unknown) {
    super(GEMINI_OVERLOAD_MESSAGE, cause !== undefined ? { cause } : undefined);
    this.name = "GeminiOverloadedError";
  }
}

// The SDK's own error class carries the real HTTP status when the fetch
// went through (GoogleGenerativeAIFetchError#status/statusText/errorDetails)
// — checking that directly is more reliable than regexing the message, which
// is what we fall back to for errors that never got that far (e.g. network).
// A GoogleGenerativeAIAbortError means our own PER_ATTEMPT_TIMEOUT_MS fired
// (or a caller-supplied signal did) — treat that the same as an overload,
// since in practice that's what a silent hang has turned out to mean.
function isRetryableError(err: unknown): boolean {
  if (err instanceof GoogleGenerativeAIAbortError) return true;
  const status = (err as { status?: number } | undefined)?.status;
  if (status === 503) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /503|high demand|Service Unavailable/i.test(message);
}

// Best-effort extraction of whatever diagnostic detail the error carries,
// for surfacing in API responses so a stuck build is debuggable from the
// admin UI instead of only the server logs.
export function describeGeminiError(err: unknown): string | undefined {
  if (!err) return undefined;
  const e = err as {
    status?: number;
    statusText?: string;
    errorDetails?: unknown;
    message?: string;
  };
  if (e.status || e.statusText || e.errorDetails) {
    const parts = [
      e.status ? `status ${e.status}` : null,
      e.statusText || null,
      e.errorDetails ? JSON.stringify(e.errorDetails) : null,
    ].filter(Boolean);
    return parts.join(" — ") || e.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls model.generateContent(prompt), retrying on 503/overload/timeout
 * errors with exponential backoff (3s, 6s, 12s — 3 retries, 21s of sleep
 * total). Each individual attempt is capped at PER_ATTEMPT_TIMEOUT_MS so a
 * hung request can't silently consume the whole budget on its own.
 * Non-retryable errors are rethrown as-is. If all retries are exhausted,
 * throws GeminiOverloadedError with the last error attached as `cause`.
 *
 * Callers with a route-level timeout must give this enough headroom: worst
 * case is (RETRY_DELAYS_MS.length + 1) * PER_ATTEMPT_TIMEOUT_MS of attempt
 * time (4 attempts * 20s = 80s), plus RETRY_DELAYS_MS's 21s of sleep, plus
 * whatever the caller does afterward — ~101s total. See maxDuration on the
 * routes that use this.
 */
export async function generateContentWithRetry(
  model: GenerativeModel,
  prompt: string,
  logPrefix = "[gemini-with-retry]"
): Promise<GenerateContentResult> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await model.generateContent(prompt, { timeout: PER_ATTEMPT_TIMEOUT_MS });
    } catch (err) {
      if (!isRetryableError(err)) throw err;

      if (attempt === RETRY_DELAYS_MS.length) {
        console.error(`${logPrefix} exhausted all retries (overloaded/timed out):`, err);
        throw new GeminiOverloadedError(err);
      }

      const delay = RETRY_DELAYS_MS[attempt];
      const reason = err instanceof GoogleGenerativeAIAbortError ? "timed out" : "overloaded";
      console.error(
        `${logPrefix} attempt ${attempt + 1} failed (${reason}), retrying in ${delay}ms:`,
        err
      );
      await sleep(delay);
    }
  }

  throw new GeminiOverloadedError();
}
