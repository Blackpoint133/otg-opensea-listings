import crypto from "node:crypto";

export const PREVIOUS_HISTORICAL_OPENAPI_PIN = Object.freeze({
  sha256: "feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922",
  byteLength: 590486,
  sourceBytesAvailable: false,
});
export const CURRENT_OPENAPI_DOCUMENT_SHA256 = "f9b79429a3e7b095785f14b36171dcc4fb769a5a7ee04685f6e81ff742a7e18e";
export const CURRENT_OPENAPI_DOCUMENT_BYTES = 581930;
export const CURRENT_GET_ORDER_SCHEMA_SHA256 = "9cd70ac9d6b96532015ab0ce2e13a5220f69e6bc3b97baa66033c04834d6dc90";
export const GET_ORDER_PATH = "/api/v2/orders/chain/{chain}/protocol/{protocol_address}/{order_hash}";
export const GET_ORDER_METHOD = "GET";
export const GET_ORDER_OPERATION_ID = "get_order";
export const SCHEMA_CANONICALIZATION = "sorted-json-v1";

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
    return result;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function decodePointerToken(token) {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function resolveJsonPointer(root, pointer) {
  if (pointer === "#") return root;
  if (!pointer.startsWith("#/")) return undefined;
  let current = root;
  for (const token of pointer.slice(2).split("/").map(decodePointerToken)) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, token)) return undefined;
    current = current[token];
  }
  return current;
}

function visit(value, callback) {
  if (value === null || typeof value !== "object") return;
  callback(value);
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, callback);
  } else {
    for (const entry of Object.values(value)) visit(entry, callback);
  }
}

export function extractGetOrderSchema(document) {
  const operation = document?.paths?.[GET_ORDER_PATH]?.get;
  if (!operation || operation.operationId !== GET_ORDER_OPERATION_ID) throw new Error("GET_ORDER_OPERATION_NOT_FOUND");
  const response = operation.responses?.["200"];
  if (!response || typeof response !== "object") throw new Error("GET_ORDER_200_RESPONSE_NOT_FOUND");
  const sourceSchemas = document?.components?.schemas;
  if (!sourceSchemas || typeof sourceSchemas !== "object") throw new Error("OPENAPI_SCHEMAS_NOT_FOUND");

  const selected = new Set();
  const queue = [];
  const enqueueRefs = (value) => visit(value, (node) => {
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/components/schemas/")) queue.push(node.$ref);
  });
  enqueueRefs(response);
  while (queue.length) {
    const ref = queue.shift();
    const name = decodePointerToken(ref.slice("#/components/schemas/".length));
    if (selected.has(name)) continue;
    const schema = sourceSchemas[name];
    if (!schema || typeof schema !== "object") throw new Error(`UNRESOLVED_SOURCE_SCHEMA_REF:${ref}`);
    selected.add(name);
    enqueueRefs(schema);
  }

  const schemas = Object.create(null);
  for (const name of [...selected].sort()) schemas[name] = sourceSchemas[name];
  return {
    source: {
      openApiDocumentSha256: CURRENT_OPENAPI_DOCUMENT_SHA256,
      operationId: GET_ORDER_OPERATION_ID,
      method: GET_ORDER_METHOD,
      path: GET_ORDER_PATH,
    },
    response,
    components: { schemas },
  };
}

export function extractGetOrderSchemaFromBytes(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const hash = sha256Hex(buffer);
  if (hash !== CURRENT_OPENAPI_DOCUMENT_SHA256) throw new Error(`OPENAPI_SHA_MISMATCH:${hash}`);
  if (buffer.byteLength !== CURRENT_OPENAPI_DOCUMENT_BYTES) throw new Error(`OPENAPI_LENGTH_MISMATCH:${buffer.byteLength}`);
  return extractGetOrderSchema(JSON.parse(buffer.toString("utf8")));
}

export function unresolvedLocalSchemaRefs(fixture) {
  const unresolved = [];
  visit(fixture, (node) => {
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/components/schemas/") && resolveJsonPointer(fixture, node.$ref) === undefined) unresolved.push(node.$ref);
  });
  return [...new Set(unresolved)].sort();
}

export function localSchemaRefs(value) {
  const refs = [];
  visit(value, (node) => {
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/components/schemas/")) refs.push(node.$ref);
  });
  return [...new Set(refs)].sort();
}

export function effectiveRequired(schema, fixture, seen = new Set()) {
  if (!schema || typeof schema !== "object") return [];
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return [];
    const resolved = resolveJsonPointer(fixture, schema.$ref);
    if (!resolved) throw new Error(`UNRESOLVED_REF:${schema.$ref}`);
    return effectiveRequired(resolved, fixture, new Set([...seen, schema.$ref]));
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const branch of Array.isArray(schema.allOf) ? schema.allOf : []) {
    for (const key of effectiveRequired(branch, fixture, new Set(seen))) required.add(key);
  }
  return [...required].sort();
}
