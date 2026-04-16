/** AbortSignal that fires after `ms` (polyfill for environments without AbortSignal.timeout). */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
