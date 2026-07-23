// SPDX-License-Identifier: MIT

// descriptor.ts — parsing + validation for the hand-written `workflow.jsonc` descriptor.
//
// A workflow package carries a small declarative descriptor (`workflow.jsonc`, or strict-JSON
// `workflow.json`) the control plane reads as DATA — the fields machinery must know before or
// around a run, without ever executing the program. The descriptor is the manifest schema
// (manifest.ts) MINUS the build-derived `input_schema` / `output_schema`: those come from the
// `run` function's signature, so a descriptor supplying either is an error, never a merge.
//
// JSONC = JSON + `//` / `/* */` comments + trailing commas. Comments are author-facing only:
// they are stripped on parse and NEVER stored, so a comment can never change the control-plane
// contract.
//
// Also here: `validateConcurrencyKeyTemplate` — the deploy-time SYNTAX check for the
// `concurrency.key` template language (`${input.<path>}` interpolations, each path a restricted
// accessor rooted at `input`: dotted fields + `[index]` only). VALUE resolution against a run's
// input happens at run creation on the control plane — deliberately not implemented here.

import { workflowManifestSchema, type WorkflowManifest } from "./manifest.js";

/** A validated descriptor: the manifest minus the build-derived I/O schemas. */
export type WorkflowDescriptor = Omit<WorkflowManifest, "input_schema" | "output_schema">;

/** Thrown by {@link parseWorkflowDescriptor} when a descriptor cannot be parsed or violates
 *  the schema. The message lists every issue with its path. */
export class DescriptorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescriptorValidationError";
  }
}

// ============================================================================
// JSONC parsing
// ============================================================================

/**
 * Parse JSONC text: strip line (`//`) and block (`/*`-style) comments and trailing commas —
 * never touching string contents — then `JSON.parse`. Stripped characters are replaced with
 * spaces so the positions in a `JSON.parse` syntax error still point at the original text.
 * Throws `SyntaxError` on malformed JSON or an unterminated block comment.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}

/** Replace comments with spaces (newlines kept, so line numbers survive). String-aware. */
function stripComments(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        throw new SyntaxError(`Unterminated block comment starting at position ${String(i)}`);
      }
      for (let j = i; j < end + 2; j++) {
        const c = text[j];
        if (c !== "\n" && c !== "\r") out[j] = " ";
      }
      i = end + 2;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Blank a `,` whose next non-whitespace character is `}` or `]`. String-aware. */
function stripTrailingCommas(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j++;
      const next = text[j];
      if (next === "}" || next === "]") out[i] = " ";
    }
    i++;
  }
  return out.join("");
}

/** Given the index of an opening `"`, return the index just past the closing `"` (escape-aware).
 *  An unterminated string returns the end of input — JSON.parse reports it precisely. */
function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return i;
}

// ============================================================================
// Descriptor validation
// ============================================================================

// The descriptor schema: the manifest minus the build-derived I/O schemas. `.omit` preserves
// strictness, so a stray `input_schema` would already be an unrecognized-key error — the
// targeted check below exists to say WHY it is rejected.
const workflowDescriptorSchema = workflowManifestSchema.omit({
  input_schema: true,
  output_schema: true,
});

const DERIVED_FIELDS = ["input_schema", "output_schema"] as const;

/**
 * Parse and validate a hand-written `workflow.jsonc` / `workflow.json` descriptor:
 * JSONC-parse (comments and trailing commas are stripped, never stored) → validate against the
 * manifest schema minus the derived `input_schema` / `output_schema` → check the
 * `concurrency.key` template syntax. Returns the typed, fully-defaulted descriptor; throws
 * {@link DescriptorValidationError} with every issue and its path on any failure.
 */
export function parseWorkflowDescriptor(text: string): WorkflowDescriptor {
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DescriptorValidationError(`workflow.jsonc is not valid JSONC: ${detail}`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DescriptorValidationError(
      "workflow.jsonc must contain a single JSON object (the descriptor)",
    );
  }

  // `$schema` is the standard editor-validation hook (the docs' example carries
  // `https://boardwalk.sh/schemas/workflow.json`) — author-facing only, stripped here exactly
  // like comments, never stored, never part of the contract.
  const descriptorRecord = { ...(raw as Record<string, unknown>) };
  delete descriptorRecord["$schema"];

  // The derived-field check runs FIRST for a precise message — the strict schema would only say
  // "unrecognized key".
  for (const field of DERIVED_FIELDS) {
    if (field in descriptorRecord) {
      throw new DescriptorValidationError(
        `\`${field}\` is build-derived from your run function's signature and never ` +
          "hand-written — remove it from workflow.jsonc",
      );
    }
  }

  const result = workflowDescriptorSchema.safeParse(descriptorRecord);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("\n");
    throw new DescriptorValidationError(`workflow.jsonc failed descriptor validation:\n${issues}`);
  }

  const { concurrency } = result.data;
  if (concurrency.mode === "serial" && concurrency.key !== undefined) {
    const templateIssues = validateConcurrencyKeyTemplate(concurrency.key);
    if (templateIssues.length > 0) {
      const lines = templateIssues
        .map((i) => `  at index ${String(i.index)}: ${i.message}`)
        .join("\n");
      throw new DescriptorValidationError(`concurrency.key template is invalid:\n${lines}`);
    }
  }

  return result.data;
}

// ============================================================================
// The concurrency-key template language (deploy-time SYNTAX check)
// ============================================================================

/** One syntax problem in a `concurrency.key` template. */
export interface ConcurrencyKeyTemplateIssue {
  /** 0-based character index in the template where the problem starts. */
  index: number;
  message: string;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;
const INDEX_RE = /^(?:0|[1-9][0-9]*)$/;

/**
 * Deploy-time SYNTAX check for a `concurrency.key` template: literal text plus `${<path>}`
 * interpolations, each `<path>` a restricted accessor ROOTED AT `input` — dotted fields and
 * `[index]` only (`input.customerId`, `input.items[0].sku`). No function calls, no operators,
 * no arbitrary expressions: pure data access, so the control plane resolves it without a
 * sandbox and tenant code never runs. Returns every problem found (empty array = valid).
 *
 * VALUE resolution against a run's input happens at run creation on the control plane — an
 * unresolvable or non-scalar path fails the create there, not here.
 */
export function validateConcurrencyKeyTemplate(template: string): ConcurrencyKeyTemplateIssue[] {
  const issues: ConcurrencyKeyTemplateIssue[] = [];
  let i = 0;
  while (i < template.length) {
    if (template[i] !== "$" || template[i + 1] !== "{") {
      i++;
      continue;
    }
    const open = i;
    const close = template.indexOf("}", open + 2);
    if (close === -1) {
      issues.push({
        index: open,
        message: "unclosed `${` — every interpolation must end with `}`",
      });
      break; // The rest of the template is inside the unterminated interpolation.
    }
    const path = template.slice(open + 2, close).trim();
    const pathIssue = validateAccessorPath(path, open);
    if (pathIssue !== null) issues.push(pathIssue);
    i = close + 1;
  }
  return issues;
}

/** Check one `${...}` path. `index` is the interpolation's start, used for issue positions. */
function validateAccessorPath(path: string, index: number): ConcurrencyKeyTemplateIssue | null {
  if (path === "") {
    return { index, message: "empty interpolation — write `${input.<field>}`" };
  }
  if (!/^input(?:[.[]|$)/.test(path)) {
    return {
      index,
      message:
        `path \`${path}\` must be rooted at \`input\` — ` +
        "only the run's input is addressable (e.g. `${input.customerId}`)",
    };
  }
  if (path === "input") {
    return {
      index,
      message:
        "`${input}` names the whole input (an object, never a scalar) — " +
        "reference a field, e.g. `${input.customerId}`",
    };
  }

  // Walk the accessor chain after the `input` root: `.field` or `[index]`, repeated.
  let rest = path.slice("input".length);
  while (rest !== "") {
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      let end = 0;
      while (end < rest.length && rest[end] !== "." && rest[end] !== "[") end++;
      const field = rest.slice(0, end);
      const fieldIssue = checkField(field, path, index);
      if (fieldIssue !== null) return fieldIssue;
      rest = rest.slice(end);
    } else if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end === -1) {
        return { index, message: `path \`${path}\` has an unclosed \`[\` — write \`[0]\`` };
      }
      const idx = rest.slice(1, end);
      if (!INDEX_RE.test(idx)) {
        return {
          index,
          message:
            `\`[${idx}]\` in \`${path}\` is not a valid index — ` +
            "only a non-negative integer literal is allowed (e.g. `[0]`)",
        };
      }
      rest = rest.slice(end + 1);
    } else {
      return disallowedExpression(rest[0] ?? "", path, index);
    }
  }
  return null;
}

function checkField(
  field: string,
  path: string,
  index: number,
): ConcurrencyKeyTemplateIssue | null {
  if (field === "") {
    return {
      index,
      message: `path \`${path}\` has an empty field segment — write \`input.<field>\``,
    };
  }
  if (IDENT_RE.test(field)) return null;
  // Pinpoint the first non-identifier character for a targeted message (skipping whitespace so
  // `a || b` reports the operator, not the space).
  for (const ch of field) {
    if (/\s/.test(ch)) continue;
    if (!IDENT_CHAR_RE.test(ch)) return disallowedExpression(ch, path, index);
  }
  if (/\s/.test(field)) {
    return { index, message: `whitespace is not allowed inside a path (\`${path}\`)` };
  }
  // All identifier characters but an invalid start (a leading digit).
  return { index, message: `\`${field}\` in \`${path}\` is not a valid field name` };
}

function disallowedExpression(
  ch: string,
  path: string,
  index: number,
): ConcurrencyKeyTemplateIssue {
  if (ch === "(" || ch === ")") {
    return {
      index,
      message:
        `function calls are not allowed in \`${path}\` — ` +
        "a path is pure data access (dotted fields + `[index]` only)",
    };
  }
  if ("+-*/%<>!&|?=~^".includes(ch)) {
    return {
      index,
      message:
        `operators are not allowed in \`${path}\` — ` +
        "a path is pure data access (dotted fields + `[index]` only)",
    };
  }
  return {
    index,
    message:
      `unexpected \`${ch}\` in \`${path}\` — ` +
      "a path is dotted fields + `[index]` only (e.g. `input.items[0].sku`)",
  };
}

// ============================================================================
// The canonical default-entry candidates
// ============================================================================

/**
 * Where a package's `run` entry is looked for when the descriptor declares no `entry`, in
 * priority order. THE one list — the CLI's build, the backend's deploy-time derivation, and any
 * other resolver consume it from here, so a package with two candidate files can never have its
 * schemas derived from a different file than the one that runs.
 */
export const DEFAULT_ENTRY_SOURCES = [
  "src/index.ts",
  "src/index.tsx",
  "src/index.mts",
  "src/index.js",
  "src/index.mjs",
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.js",
  "index.mjs",
] as const;

/** The Python default entry (a package is Python when this resolves and no TS candidate does). */
export const PYTHON_DEFAULT_ENTRY = "main.py";
