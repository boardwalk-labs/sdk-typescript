// SPDX-License-Identifier: MIT

// Neutral normalization of an `AgentOptions.reasoning` value into a canonical object — shared by
// every engine AND the hosted broker so they agree on the author's intent BEFORE mapping it to a
// provider's wire format. Pure logic: NO provider knowledge lives here (the per-provider wire
// encoding is the engine's job); this only expands the string sugar, disambiguates
// effort-vs-maxTokens, and drops no-ops. Tested directly.

import type { ReasoningEffort, ReasoningOptions } from "./types.js";

/**
 * The canonical reasoning request: an {@link import("./types.js").AgentOptions}.reasoning value with
 * the string sugar expanded, empties dropped, and `effort`/`maxTokens` disambiguated. `undefined`
 * means "no reasoning control — use the provider default", so callers can cheaply skip emitting any
 * reasoning field.
 */
export interface NormalizedReasoning {
  effort?: ReasoningEffort;
  maxTokens?: number;
  exclude?: boolean;
}

/**
 * Normalize a raw `AgentOptions.reasoning` value:
 *  - a bare effort string (`"high"`) → `{ effort: "high" }`.
 *  - `effort` and `maxTokens` are mutually exclusive — if BOTH are set, `effort` wins (`maxTokens`
 *    dropped), since effort is the headline knob and a model takes one or the other.
 *  - no-op inputs (`undefined`, `{}`, `{ exclude: false }`) collapse to `undefined`.
 *
 * Does NOT validate the effort against {@link ReasoningEffort} — TypeScript constrains it at the call
 * site, and a stray runtime value is left to surface as a clear provider error rather than be
 * silently dropped.
 */
export function normalizeReasoning(
  input: ReasoningEffort | ReasoningOptions | undefined,
): NormalizedReasoning | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string") return { effort: input };

  const out: NormalizedReasoning = {};
  if (input.effort !== undefined) {
    out.effort = input.effort;
  } else if (typeof input.maxTokens === "number") {
    out.maxTokens = input.maxTokens;
  }
  if (input.exclude === true) out.exclude = true;

  return out.effort === undefined && out.maxTokens === undefined && out.exclude === undefined
    ? undefined
    : out;
}
