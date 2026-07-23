// SPDX-License-Identifier: MIT

// The schema-guided revival pass — wire JSON → rich runtime values.
//
// Rich types cross the wire in a canonical, lossless JSON encoding; this pass walks a value
// GUIDED BY its JSON Schema and revives each encoded field into its runtime type:
//
//   {type: "string", format: "date-time"}        ISO-8601 string   → Date
//   {type: "string", pattern: "^-?\d+$"}         decimal string    → bigint
//   {type: "string", contentEncoding: "base64"}  base64 string     → Uint8Array
//   {type: "array",  uniqueItems: true}          deduped array     → Set
//
// Used symmetrically: the runner revives a run's `input` before calling `run(input, context)`,
// and `workflows.call` revives the child's `output` per the callee's `output_schema` — so a
// child returning a `Date` hands its parent a `Date`. An untyped contract (`null` / absent /
// `{}` schema) passes the plain JSON through, honestly.
//
// BEST-EFFORT, NEVER THROWS: a value that doesn't match its schema (wrong type, invalid date,
// non-integer string) is passed through unchanged — the same "run() sees what actually
// arrived" doctrine as input conversion. Pure logic, no I/O.

import type { JsonSchema, JsonValue } from "./types.js";

/** The exact `pattern` the derivation emits for a TS `bigint` (see WORKFLOW_TYPED_IO A.9). */
const BIGINT_PATTERN = "^-?\\d+$";
const BIGINT_VALUE_RE = /^-?\d+$/;

/** Max consecutive `$ref` hops per node — guards a degenerate self-referential schema. */
const MAX_REF_HOPS = 16;

/**
 * Revive `value` per `schema` (the whole document is also the `$ref` resolution root).
 * `schema` may be `null`/`undefined` (an untyped contract) — the value passes through as-is.
 */
export function reviveBySchema(value: unknown, schema: JsonSchema | null | undefined): unknown {
  if (schema === null || schema === undefined) return value;
  return revive(value, schema, schema);
}

function revive(value: unknown, schema: unknown, root: unknown): unknown {
  const resolved = resolveRefs(schema, root);
  if (!isRecord(resolved)) return value;

  // anyOf: revive through the one branch we can identify honestly; otherwise pass through.
  const anyOf = resolved["anyOf"];
  if (Array.isArray(anyOf)) {
    if (value === null) return null;
    const branches = anyOf.filter((b) => !(isRecord(b) && b["type"] === "null"));
    return branches.length === 1 ? revive(value, branches[0], root) : value;
  }

  switch (resolved["type"]) {
    case "string":
      return reviveString(value, resolved);
    case "array":
      return reviveArray(value, resolved, root);
    case "object":
      return reviveObject(value, resolved, root);
    default:
      return value;
  }
}

function reviveString(value: unknown, schema: Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  if (schema["format"] === "date-time") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  if (schema["contentEncoding"] === "base64") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  if (schema["pattern"] === BIGINT_PATTERN) {
    return BIGINT_VALUE_RE.test(value) ? BigInt(value) : value;
  }
  return value;
}

function reviveArray(value: unknown, schema: Record<string, unknown>, root: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const elements: readonly unknown[] = value;
  const prefixItems = schema["prefixItems"];
  const items = schema["items"];
  const revived = elements.map((item, i) => {
    if (Array.isArray(prefixItems) && i < prefixItems.length) {
      return revive(item, prefixItems[i], root);
    }
    // `items: false` (a fixed tuple's overflow guard) is not a subschema — pass through.
    return typeof items === "object" && items !== null ? revive(item, items, root) : item;
  });
  return schema["uniqueItems"] === true ? new Set(revived) : revived;
}

function reviveObject(value: unknown, schema: Record<string, unknown>, root: unknown): unknown {
  if (!isRecord(value)) return value;
  const properties = isRecord(schema["properties"]) ? schema["properties"] : undefined;
  const additional = schema["additionalProperties"];
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const propSchema = properties?.[key];
    if (propSchema !== undefined) {
      out[key] = revive(item, propSchema, root);
    } else if (typeof additional === "object" && additional !== null) {
      out[key] = revive(item, additional, root);
    } else {
      out[key] = item;
    }
  }
  return out;
}

/** Follow local `$ref`s (`#`, `#/$defs/<name>`, `#/definitions/<name>`), bounded. */
function resolveRefs(schema: unknown, root: unknown): unknown {
  let current = schema;
  for (let hop = 0; hop < MAX_REF_HOPS; hop++) {
    if (!isRecord(current) || typeof current["$ref"] !== "string") return current;
    const target = resolveLocalRef(current["$ref"], root);
    if (target === undefined || target === current) return undefined;
    current = target;
  }
  return undefined; // ref chain too deep — treat as unresolvable, caller passes through
}

function resolveLocalRef(ref: string, root: unknown): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined; // remote refs are never resolved (no I/O here)
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    // JSON Pointer unescape (RFC 6901): ~1 → "/", ~0 → "~".
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================================
// The canonical ENCODE pass — rich runtime values → wire JSON (revival's inverse)
// ============================================================================

/**
 * Encode a value into its canonical wire JSON (WORKFLOW_TYPED_IO A.9), schema-free:
 * `Date` → ISO-8601 string, `bigint` → decimal string, `Uint8Array` → base64, `Set` → array.
 * Non-JSON scalars (`NaN`/`Infinity`) and non-data values (functions, symbols) become `null`
 * (or are omitted as object properties, matching `JSON.stringify`) — dropped, never a crash.
 * An object with `toJSON()` is encoded via it (again `JSON.stringify` parity). Runs CLIENT-SIDE
 * on everything the program hands the host — the run's return (`report_return`), `workflows.*`
 * inputs, and `tool_invoke` handler outputs — because a rich value cannot cross the wire.
 */
export function encodeCanonical(value: unknown): JsonValue {
  return nullIfOmitted(value);
}

/** Sentinel: "omit this property" (functions/symbols/undefined inside objects). */
const OMIT = Symbol("omit");

/** Encode a value that must occupy a slot (an array/Set element, or the root): a value that
 *  would be omitted as an object property becomes `null` instead (`JSON.stringify` parity). */
function nullIfOmitted(value: unknown): JsonValue {
  const encoded = encodeNode(value);
  return encoded === OMIT ? null : encoded;
}

function encodeNode(value: unknown): JsonValue | typeof OMIT {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return OMIT;
    default:
      break;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  }
  if (value instanceof Set) {
    return [...value].map(nullIfOmitted);
  }
  if (Array.isArray(value)) {
    return value.map(nullIfOmitted);
  }
  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === "function") {
    return encodeNode((withToJson.toJSON as () => unknown)());
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const encoded = encodeNode(entry);
    if (encoded !== OMIT) out[key] = encoded;
  }
  return out;
}
