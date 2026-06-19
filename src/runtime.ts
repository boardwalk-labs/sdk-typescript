// SPDX-License-Identifier: MIT

// @boardwalk-labs/workflow/runtime — the ENGINE-facing API.
//
// An engine imports this to install the host adapter and the trigger payload BEFORE
// evaluating a workflow program. Authors never import this — they import the hooks
// from "@boardwalk-labs/workflow".

export {
  installHost,
  installInput,
  installConfig,
  takeDeclaredOutput,
  resetRuntime,
  requireHost,
} from "./host.js";
export type { WorkflowHost } from "./host.js";
export type {
  AgentOptions,
  ToolDef,
  ArtifactBody,
  ArtifactRef,
  CallOptions,
  HumanInputOptions,
  HumanInputSpec,
  HumanInputTextSpec,
  HumanInputChoiceSpec,
  HumanInputMultiSelectSpec,
  HumanInputResult,
  HumanTextResult,
  HumanChoiceResult,
  HumanMultiSelectResult,
  JsonValue,
  PhaseOptions,
  ScheduleOptions,
  SleepArg,
  JsonSchema,
} from "./types.js";
