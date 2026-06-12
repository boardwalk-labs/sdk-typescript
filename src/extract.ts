// @boardwalk/workflow/extract — static extraction of a workflow program's `meta` → manifest.
//
// A workflow is a TS/JS program file whose `export const meta = { … }` is a PURE LITERAL.
// Engines and tooling must derive the manifest WITHOUT executing the program, so this module
// parses the file's AST and reads the literal statically:
//
//   source text → TS AST → unwrap `satisfies`/`as` → evaluate the pure object literal
//                → validate against workflowManifestSchema → WorkflowManifest
//
// "Pure literal" means: object/array literals, string/number/boolean/null literals, and
// no-substitution template strings ONLY. Any variable reference, function call (incl.
// `defineMeta(...)`), spread, shorthand, computed key, or template interpolation is
// rejected — those would require executing the file to know the value. (`defineMeta` is
// deliberately unsupported; type the literal with `satisfies WorkflowMeta` instead.)
//
// This module executes none of the program. It is pure logic — tested exhaustively. It is a
// subpath export (`@boardwalk/workflow/extract`) consumed by engines and the CLI; author
// programs never import it.

import ts from "typescript";
import { validateMeta, type WorkflowManifest } from "./manifest.js";

/** Thrown when a program's `meta` cannot be statically extracted as a pure literal. */
export class MetaExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaExtractionError";
  }
}

export interface MetaExtractionOptions {
  /**
   * Logical file name. Drives TS-vs-JS parsing (the `.ts`/`.js` extension) and the
   * `file:line:col` prefix in error messages. Defaults to `index.ts`.
   */
  fileName?: string;
}

const DEFAULT_FILE_NAME = "index.ts";

/**
 * Statically extract the raw `meta` pure-literal object from a workflow program's source.
 *
 * Returns the plain JS object exactly as written (no schema defaults applied). Throws
 * {@link MetaExtractionError} when there is no `meta` declaration, when it is not an object
 * literal, or when any part of it is not a pure literal.
 */
export function extractMetaLiteral(
  source: string,
  options: MetaExtractionOptions = {},
): Record<string, unknown> {
  const fileName = options.fileName ?? DEFAULT_FILE_NAME;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);

  const initializer = findMetaInitializer(sf);
  if (initializer === null) {
    throw fail(
      "No `meta` declaration found — a workflow program must export a pure-literal " +
        "`export const meta = { … }`",
    );
  }

  const unwrapped = unwrapTypeOnly(initializer);

  // Targeted message for the one mistake the design explicitly forbids.
  if (ts.isCallExpression(unwrapped)) {
    throw fail(
      "`meta` must be a plain object literal, not a function call — `defineMeta(...)` is " +
        "not supported; type the literal with `satisfies WorkflowMeta` instead",
      unwrapped,
      sf,
    );
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    throw fail("`meta` must be an object literal (`export const meta = { … }`)", unwrapped, sf);
  }

  return evalObjectLiteral(unwrapped, sf);
}

/**
 * Statically extract `meta` and validate it against the manifest schema, returning the
 * fully-defaulted, validated manifest (the contract every engine consumes). Throws
 * {@link MetaExtractionError} on an unextractable literal, or `MetaValidationError` (from
 * `validateMeta`) on a schema violation.
 */
export function extractManifest(
  source: string,
  options: MetaExtractionOptions = {},
): WorkflowManifest {
  return validateMeta(extractMetaLiteral(source, options));
}

// ============================================================================
// AST walking
// ============================================================================

/** Find the initializer of the first top-level `const meta = …` (exported or not). */
function findMetaInitializer(sf: ts.SourceFile): ts.Expression | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === "meta" &&
        decl.initializer !== undefined
      ) {
        return decl.initializer;
      }
    }
  }
  return null;
}

/**
 * Strip type-only wrappers that are erased at compile time and don't affect the value:
 * `expr satisfies T`, `expr as T`, `<T>expr`, and `(expr)`. Applied repeatedly so
 * `({ … } satisfies WorkflowMeta)` unwraps fully.
 */
function unwrapTypeOnly(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

// ============================================================================
// Pure-literal evaluation
// ============================================================================

function evalObjectLiteral(
  node: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      throw fail(
        "shorthand properties reference a variable, which is not a pure literal — " +
          "write `key: value` with a literal value",
        prop,
        sf,
      );
    }
    if (ts.isSpreadAssignment(prop)) {
      throw fail("spread (`...`) is not allowed in a `meta` literal", prop, sf);
    }
    if (!ts.isPropertyAssignment(prop)) {
      // Method / get / set declarations.
      throw fail("methods and accessors are not allowed in a `meta` literal", prop, sf);
    }
    const key = propertyKey(prop.name, sf);
    out[key] = evalLiteral(prop.initializer, sf);
  }
  return out;
}

/** Resolve a property name to a string, allowing identifier / string / numeric / `["x"]`. */
function propertyKey(name: ts.PropertyName, sf: ts.SourceFile): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  throw fail(
    "property keys must be plain identifiers or string/number literals (no computed keys)",
    name,
    sf,
  );
}

/** Evaluate any value node, rejecting anything that isn't a pure literal. */
function evalLiteral(node: ts.Expression, sf: ts.SourceFile): unknown {
  const n = unwrapTypeOnly(node);

  if (ts.isObjectLiteralExpression(n)) return evalObjectLiteral(n, sf);
  if (ts.isArrayLiteralExpression(n)) return evalArrayLiteral(n, sf);
  if (ts.isStringLiteral(n)) return n.text;
  if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return parseNumber(n.text);

  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;

  // Negative numbers parse as `-` applied to a numeric literal.
  if (
    ts.isPrefixUnaryExpression(n) &&
    n.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(n.operand)
  ) {
    return -parseNumber(n.operand.text);
  }

  throw fail("unsupported expression in `meta` — only pure literals are allowed", n, sf);
}

function evalArrayLiteral(node: ts.ArrayLiteralExpression, sf: ts.SourceFile): unknown[] {
  const out: unknown[] = [];
  for (const el of node.elements) {
    if (ts.isSpreadElement(el)) {
      throw fail("spread (`...`) is not allowed in a `meta` literal array", el, sf);
    }
    if (el.kind === ts.SyntaxKind.OmittedExpression) {
      throw fail("array holes (`[1, , 3]`) are not allowed in a `meta` literal", el, sf);
    }
    out.push(evalLiteral(el, sf));
  }
  return out;
}

/** Parse a numeric-literal source token (handles separators, hex/oct/bin, floats, exponents). */
function parseNumber(text: string): number {
  return Number(text.replace(/_/g, ""));
}

// ============================================================================
// Errors
// ============================================================================

function fail(message: string, node?: ts.Node, sf?: ts.SourceFile): MetaExtractionError {
  if (node !== undefined && sf !== undefined) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return new MetaExtractionError(
      `${sf.fileName}:${String(line + 1)}:${String(character + 1)} — ${message}`,
    );
  }
  return new MetaExtractionError(message);
}
