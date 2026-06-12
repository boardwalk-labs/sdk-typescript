// The run-event wire format — one typed, ordered stream per run, identical in every engine.
//
// Every event carries an envelope (runId, turnId, per-turn 1-based seq, server timestamp) and
// a RUN-GLOBAL MONOTONIC CURSOR derived from (turn number, seq). Consumers resume from a
// cursor (SSE `Last-Event-ID` semantics). Every event kind maps to exactly ONE subscription
// channel; filtering happens server-side, and cursors stay globally consistent so a filtered
// subscription resumes correctly.

import { z } from "zod";

// ============================================================================
// Cursor
// ============================================================================

/** Cursor stride per turn: `cursor = turnNumber * STRIDE + seq`. seq is 1-based per turn. */
export const TURN_CURSOR_STRIDE = 1_000_000;

/** Compute the run-global cursor for an event. `turnNumber` is 0-based; `seq` is 1-based. */
export function makeCursor(turnNumber: number, seq: number): number {
  if (!Number.isInteger(turnNumber) || turnNumber < 0) {
    throw new RangeError(`turnNumber must be a non-negative integer (got ${String(turnNumber)})`);
  }
  if (!Number.isInteger(seq) || seq < 1 || seq >= TURN_CURSOR_STRIDE) {
    throw new RangeError(
      `seq must be an integer in [1, ${String(TURN_CURSOR_STRIDE)}) (got ${String(seq)})`,
    );
  }
  return turnNumber * TURN_CURSOR_STRIDE + seq;
}

// ============================================================================
// Envelope + shared shapes
// ============================================================================

const envelopeShape = {
  /** The run this event belongs to. */
  runId: z.string().min(1),
  /** Identifies one logical stream segment (a new id per agent turn; run-level frames reuse the run's). */
  turnId: z.string().min(1),
  /** Monotonic 1-based sequence within the turn. */
  seq: z.number().int().min(1),
  /** Server time at emission, ms since epoch. */
  t: z.number().int().nonnegative(),
} as const;

export const tokenUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const toolReturnSchema = z.strictObject({
  /** Opaque discriminator for client rendering. */
  kind: z.string().optional(),
  /** One-sentence summary suitable for a log line. */
  humanSummary: z.string().optional(),
  /** Tool-specific payload. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ToolReturn = z.infer<typeof toolReturnSchema>;

const eventErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
});

const jsonValueSchema: z.ZodType<unknown> = z.unknown();

// ============================================================================
// Event kinds
// ============================================================================

const runStatusValues = [
  "queued",
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "cancelling",
] as const;

// -- lifecycle channel --------------------------------------------------------
const runStatusEvent = z.strictObject({
  ...envelopeShape,
  kind: z.literal("run_status"),
  status: z.enum(runStatusValues),
  /** Present on `failed` — why the run failed. */
  error: eventErrorSchema.optional(),
});

// -- phase channel -------------------------------------------------------------
const phaseEvent = z.strictObject({
  ...envelopeShape,
  kind: z.literal("phase"),
  name: z.string().min(1),
  /** Stable phase identifier (author-supplied or engine-assigned in marker order). */
  id: z.string().min(1),
});

// -- output channel -------------------------------------------------------------
const outputEvent = z.strictObject({
  ...envelopeShape,
  kind: z.literal("output"),
  value: jsonValueSchema,
});

// -- log channel ----------------------------------------------------------------
const programOutputEvent = z.strictObject({
  ...envelopeShape,
  kind: z.literal("program_output"),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
});

// -- agent channel ----------------------------------------------------------------
const turnStarted = z.strictObject({ ...envelopeShape, kind: z.literal("turn_started") });
const turnEnded = z.strictObject({
  ...envelopeShape,
  kind: z.literal("turn_ended"),
  reason: z.enum(["complete", "cancelled", "error"]),
  usage: tokenUsageSchema.optional(),
  error: eventErrorSchema.optional(),
});
const textStart = z.strictObject({
  ...envelopeShape,
  kind: z.literal("text_start"),
  blockId: z.string(),
});
const textDelta = z.strictObject({
  ...envelopeShape,
  kind: z.literal("text_delta"),
  blockId: z.string(),
  text: z.string(),
});
const textEnd = z.strictObject({
  ...envelopeShape,
  kind: z.literal("text_end"),
  blockId: z.string(),
});
const toolCallStart = z.strictObject({
  ...envelopeShape,
  kind: z.literal("tool_call_start"),
  toolCallId: z.string(),
  toolName: z.string(),
});
const toolCallInputDelta = z.strictObject({
  ...envelopeShape,
  kind: z.literal("tool_call_input_delta"),
  toolCallId: z.string(),
  partialJson: z.string(),
});
const toolCallInputComplete = z.strictObject({
  ...envelopeShape,
  kind: z.literal("tool_call_input_complete"),
  toolCallId: z.string(),
  input: z.record(z.string(), z.unknown()),
});
const toolCallExecuting = z.strictObject({
  ...envelopeShape,
  kind: z.literal("tool_call_executing"),
  toolCallId: z.string(),
});
const toolCallResult = z.strictObject({
  ...envelopeShape,
  kind: z.literal("tool_call_result"),
  toolCallId: z.string(),
  result: toolReturnSchema,
});
const toolCallError = z.strictObject({
  ...envelopeShape,
  kind: z.literal("tool_call_error"),
  toolCallId: z.string(),
  error: eventErrorSchema,
});
const reasoningDelta = z.strictObject({
  ...envelopeShape,
  kind: z.literal("reasoning_delta"),
  text: z.string(),
});

export const runEventSchema = z.discriminatedUnion("kind", [
  runStatusEvent,
  phaseEvent,
  outputEvent,
  programOutputEvent,
  turnStarted,
  turnEnded,
  textStart,
  textDelta,
  textEnd,
  toolCallStart,
  toolCallInputDelta,
  toolCallInputComplete,
  toolCallExecuting,
  toolCallResult,
  toolCallError,
  reasoningDelta,
]);

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventKind = RunEvent["kind"];
export type EventEnvelope = Pick<RunEvent, "runId" | "turnId" | "seq" | "t">;
export type RunStatus = (typeof runStatusValues)[number];

// ============================================================================
// Channels
// ============================================================================

/** Subscription channels. Every event kind maps to exactly one channel. */
export const CHANNELS = ["lifecycle", "phase", "output", "log", "agent"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The default subscription — quiet and readable. `verbose` = all of {@link CHANNELS}. */
export const DEFAULT_CHANNELS: readonly Channel[] = ["lifecycle", "phase", "output"];

const KIND_TO_CHANNEL: Record<RunEventKind, Channel> = {
  run_status: "lifecycle",
  phase: "phase",
  output: "output",
  program_output: "log",
  turn_started: "agent",
  turn_ended: "agent",
  text_start: "agent",
  text_delta: "agent",
  text_end: "agent",
  tool_call_start: "agent",
  tool_call_input_delta: "agent",
  tool_call_input_complete: "agent",
  tool_call_executing: "agent",
  tool_call_result: "agent",
  tool_call_error: "agent",
  reasoning_delta: "agent",
};

/** The channel an event belongs to. */
export function channelOf(event: Pick<RunEvent, "kind">): Channel {
  return KIND_TO_CHANNEL[event.kind];
}

/** Server-side subscription filter: does this event belong to one of the subscribed channels? */
export function matchesChannels(
  event: Pick<RunEvent, "kind">,
  channels: readonly Channel[],
): boolean {
  return channels.includes(channelOf(event));
}
