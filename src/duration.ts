/**
 * Human-duration parsing shared by author-facing waits. The grammar matches the runner's
 * `humanInput({ timeout })` parser: `"<n><unit>"` with unit `ms`/`s`/`m`/`h`/`d`, decimals allowed,
 * optional whitespace (`"90s"`, `"1.5h"`, `" 7 d "`).
 */

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/i;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a duration string like `"15m"` to milliseconds, or `null` when it doesn't parse. */
export function parseDurationMs(text: string): number | null {
  const m = DURATION_RE.exec(text);
  const amount = m?.[1];
  const unit = m?.[2]?.toLowerCase();
  if (amount === undefined || unit === undefined) return null;
  const mult = UNIT_MS[unit];
  if (mult === undefined) return null;
  return Math.round(Number(amount) * mult);
}
