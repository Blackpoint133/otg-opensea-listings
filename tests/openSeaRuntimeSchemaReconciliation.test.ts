import assert from "node:assert/strict";
import { after, test } from "node:test";
import { adaptOpenSeaExactOrder, OPENSEA_EXACT_ORDER_ADAPTER_VERSION } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import {
  GET_ORDER_FIELD_CONTRACT, GET_ORDER_SCHEMA_SHA256, OPENAPI_DOCUMENT_BYTES,
  OPENAPI_DOCUMENT_SHA256, GET_ORDER_SCHEMA_EXTRACTION,
} from "../src/reconciliation/verifier/openSeaExactOrderContract.js";
import {
  isOfficialJsonInteger, officialJsonInt32Value, officialJsonInt64Value,
  validateOfficialListingRequired,
} from "../src/reconciliation/verifier/openSeaSchemaAdmission.js";
import { isJsonObject, parseLosslessJson, type LosslessJsonValue } from "../src/reconciliation/verifier/losslessJson.js";
import { interpretOpenSeaExactOrderObservation, validateProviderResult } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import { OPENSEA_ORDER_CONTRACT_VERSION } from "../src/reconciliation/verifier/targetedVerifierTypes.js";
import { encodeCanonicalOrder, makeCanonicalOfficialOrder } from "./helpers/openSeaCanonicalOrder.js";
import { disposeTrustedContexts, makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
after(async () => disposeTrustedContexts(graph.root));

function parsedOrder(order: Record<string, any>): Record<string, LosslessJsonValue> {
  const root = parseLosslessJson(new TextDecoder().decode(encodeCanonicalOrder(order)));
  assert.equal(isJsonObject(root), true);
  const value = (root as Record<string, LosslessJsonValue>).order;
  assert.equal(isJsonObject(value), true);
  return value as Record<string, LosslessJsonValue>;
}

function input(body: Uint8Array) {
  return {
    context, httpStatus: 200, body,
    timing: {
      requestStartedAt: "2030-01-01T00:00:00.000Z",
      responseHeadersAt: "2030-01-01T00:00:00.100Z",
      responseCompletedAt: "2030-01-01T00:00:00.200Z",
      elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false,
    },
    headers: [
      { name: "Date", value: "Tue, 01 Jan 2030 00:00:00 GMT" },
      { name: "Content-Type", value: "application/json" },
      { name: "Content-Encoding", value: "identity" },
    ],
  } as const;
}

function path(order: Record<string, any>) {
  const observation = adaptOpenSeaExactOrder(input(encodeCanonicalOrder(order)));
  const result = interpretOpenSeaExactOrderObservation({ context, observation });
  assert.equal(validateProviderResult(result), true);
  return { observation, result };
}

function rawNumber(raw: string): LosslessJsonValue {
  return parseLosslessJson(raw);
}

function parsedOrderBytes(bytes: Uint8Array): Record<string, LosslessJsonValue> {
  const root = parseLosslessJson(new TextDecoder().decode(bytes)) as Record<string, LosslessJsonValue>;
  return root.order as Record<string, LosslessJsonValue>;
}

test("runtime metadata is repinned to the immutable Task-32 evidence", () => {
  assert.equal(OPENAPI_DOCUMENT_SHA256, "f9b79429a3e7b095785f14b36171dcc4fb769a5a7ee04685f6e81ff742a7e18e");
  assert.equal(OPENAPI_DOCUMENT_BYTES, 581930);
  assert.equal(GET_ORDER_SCHEMA_SHA256, "9cd70ac9d6b96532015ab0ce2e13a5220f69e6bc3b97baa66033c04834d6dc90");
  assert.match(GET_ORDER_SCHEMA_EXTRACTION, /sorted-json-v1/);
  assert.equal(OPENSEA_ORDER_CONTRACT_VERSION, "opensea-get-order-v2-2026-09");
  assert.equal(OPENSEA_EXACT_ORDER_ADAPTER_VERSION, "opensea-exact-order-adapter-v10-2026-09");
  const observation = adaptOpenSeaExactOrder(input(encodeCanonicalOrder(makeCanonicalOfficialOrder(context))));
  assert.equal(observation.openApiDocumentSha256, OPENAPI_DOCUMENT_SHA256);
  assert.equal(observation.getOrderSchemaSha256, GET_ORDER_SCHEMA_SHA256);
  assert.equal(observation.providerContractVersion, OPENSEA_ORDER_CONTRACT_VERSION);
  assert.equal(observation.adapterVersion, OPENSEA_EXACT_ORDER_ADAPTER_VERSION);
});

test("GET_ORDER_FIELD_CONTRACT separates official requirements from targeted identity", () => {
  assert.deepEqual(GET_ORDER_FIELD_CONTRACT.officialListingRequired, ["chain", "price", "remaining_quantity", "status", "type"]);
  assert.deepEqual(GET_ORDER_FIELD_CONTRACT.officialPriceRequired, ["currency", "decimals", "value"]);
  assert.deepEqual(GET_ORDER_FIELD_CONTRACT.officialConsiderationItemRequired, ["endAmount", "identifierOrCriteria", "itemType", "recipient", "startAmount", "token"]);
  assert.deepEqual(GET_ORDER_FIELD_CONTRACT.officialArrayCardinality, { offerMinItems: null, considerationMinItems: null });
  assert.deepEqual(GET_ORDER_FIELD_CONTRACT.targetedIdentityRequired, ["order_hash", "protocol_address", "protocol_data", "asset"]);
});

test("canonical exact-price Listing passes admission and targeted normalization", () => {
  const order = makeCanonicalOfficialOrder(context);
  assert.equal(validateOfficialListingRequired(parsedOrder(order)), true);
  assert.equal(path(order).result.status, "ACTIVE_CONFIRMED");
});

const priceCases: Array<[string, (order: Record<string, any>) => void, boolean]> = [
  ["missing price", (o) => { delete o.price; }, false],
  ["null price", (o) => { o.price = null; }, false],
  ["string price", (o) => { o.price = "1"; }, false],
  ["empty price", (o) => { o.price = {}; }, false],
  ["missing current", (o) => { delete o.price.current; }, false],
  ["null current", (o) => { o.price.current = null; }, false],
  ["missing currency", (o) => { delete o.price.current.currency; }, false],
  ["numeric currency", (o) => { o.price.current.currency = 1; }, false],
  ["missing decimals", (o) => { delete o.price.current.decimals; }, false],
  ["string decimals", (o) => { o.price.current.decimals = "18"; }, false],
  ["below int32 decimals", (o) => { o.price.current.decimals = -2147483649; }, false],
  ["minimum int32 decimals", (o) => { o.price.current.decimals = -2147483648; }, true],
  ["maximum int32 decimals", (o) => { o.price.current.decimals = 2147483647; }, true],
  ["above int32 decimals", (o) => { o.price.current.decimals = 2147483648; }, false],
  ["missing value", (o) => { delete o.price.current.value; }, false],
  ["numeric value", (o) => { o.price.current.value = 1; }, false],
];
for (const [name, mutate, expected] of priceCases) {
  test(`official Price: ${name}`, () => {
    const order = makeCanonicalOfficialOrder(context); mutate(order);
    assert.equal(validateOfficialListingRequired(parsedOrder(order)), expected);
    if (!expected) assert.ok(path(order).observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"));
  });
}

const integerCases: Array<[string, boolean, number | null]> = [
  ["-2147483649", true, null], ["-2147483648", true, -2147483648], ["-1", true, -1],
  ["-0", true, 0], ["0", true, 0], ["1", true, 1], ["2147483647", true, 2147483647],
  ["2147483648", true, null], ["1.0", true, 1], ["-1.0", true, -1],
  ["1e0", true, 1], ["1e2", true, 100], ["1.5", false, null], ["1e-1", false, null],
];
for (const [raw, integer, int32] of integerCases) {
  test(`official integer semantics preserve ${raw}`, () => {
    const value = rawNumber(raw);
    assert.equal(isOfficialJsonInteger(value), integer);
    assert.equal(officialJsonInt32Value(value), int32);
  });
}

for (const [raw, expected] of [
  ["-9223372036854775809", null], ["-9223372036854775808", -9223372036854775808n],
  ["9223372036854775807", 9223372036854775807n], ["9223372036854775808", null],
] as const) {
  test(`official int64 boundary ${raw}`, () => assert.equal(officialJsonInt64Value(rawNumber(raw)), expected));
}

test("integral fraction and exponent forms pass official and targeted integer semantics", () => {
  const source = new TextDecoder().decode(encodeCanonicalOrder(makeCanonicalOfficialOrder(context)));
  for (const raw of ["1.0", "1e0"]) {
    const bytes = new TextEncoder().encode(source.replace('"remaining_quantity":1', '"remaining_quantity":' + raw));
    const observation = adaptOpenSeaExactOrder(input(bytes));
    assert.equal(observation.outcome, "VALID", raw);
  }
});

test("remaining_quantity separates official int64 from targeted quantity policy", () => {
  const source = new TextDecoder().decode(encodeCanonicalOrder(makeCanonicalOfficialOrder(context)));
  const cases: Array<[string, string, string]> = [
    ["-1", "MALFORMED", "REMAINING_QUANTITY_INVALID"],
    ["0", "UNKNOWN", "ACTIVE_QUANTITY_UNPROVEN"],
    ["9223372036854775807", "VALID", ""],
    ["9223372036854775808", "MALFORMED", "OFFICIAL_SCHEMA_INVALID"],
  ];
  for (const [raw, outcome, reason] of cases) {
    const observation = adaptOpenSeaExactOrder(input(new TextEncoder().encode(source.replace('"remaining_quantity":1', '"remaining_quantity":' + raw))));
    assert.equal(observation.outcome, outcome, raw);
    if (reason) assert.ok(observation.reasonCodes.includes(reason), raw);
  }
});

for (const [raw, official] of [
  ["-9223372036854775809", false],
  ["-9223372036854775808", true],
  ["-1", true],
  ["-0", true],
  ["0", true],
  ["1.0", true],
  ["1e2", true],
  ["1.5", false],
  ["9223372036854775807", true],
  ["9223372036854775808", false],
] as const) {
  test(`remaining_quantity official admission ${raw}`, () => {
    const source = new TextDecoder().decode(encodeCanonicalOrder(makeCanonicalOfficialOrder(context)));
    const bytes = new TextEncoder().encode(source.replace('"remaining_quantity":1', '"remaining_quantity":' + raw));
    assert.equal(validateOfficialListingRequired(parsedOrderBytes(bytes)), official);
  });
}

test("empty arrays are officially valid without invented minItems", () => {
  const emptyOffer = makeCanonicalOfficialOrder(context); emptyOffer.protocol_data.parameters.offer = [];
  assert.equal(validateOfficialListingRequired(parsedOrder(emptyOffer)), true);
  const offerPath = path(emptyOffer);
  assert.notEqual(offerPath.observation.outcome, "VALID");
  assert.equal(offerPath.observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"), false);

  const emptyConsideration = makeCanonicalOfficialOrder(context); emptyConsideration.protocol_data.parameters.consideration = [];
  assert.equal(validateOfficialListingRequired(parsedOrder(emptyConsideration)), true);
  assert.equal(path(emptyConsideration).result.status, "ACTIVE_CONFIRMED");
});

test("nonempty Item and ConsiderationItem arrays validate every required field", () => {
  for (const [arrayName, fields] of [
    ["offer", ["itemType", "token", "identifierOrCriteria", "startAmount", "endAmount"]],
    ["consideration", ["itemType", "token", "identifierOrCriteria", "startAmount", "endAmount", "recipient"]],
  ] as const) {
    for (const field of fields) {
      const order = makeCanonicalOfficialOrder(context);
      delete order.protocol_data.parameters[arrayName][0][field];
      assert.equal(validateOfficialListingRequired(parsedOrder(order)), false, `${arrayName}.${field}`);
    }
  }
});

test("Item and ConsiderationItem exact primitive types are enforced", () => {
  for (const arrayName of ["offer", "consideration"] as const) {
    const itemTypeString = makeCanonicalOfficialOrder(context);
    itemTypeString.protocol_data.parameters[arrayName][0].itemType = "2";
    assert.equal(validateOfficialListingRequired(parsedOrder(itemTypeString)), false, `${arrayName}.itemType`);
    for (const field of ["token", "identifierOrCriteria", "startAmount", "endAmount"] as const) {
      const order = makeCanonicalOfficialOrder(context);
      order.protocol_data.parameters[arrayName][0][field] = 1;
      assert.equal(validateOfficialListingRequired(parsedOrder(order)), false, `${arrayName}.${field}`);
    }
  }
  const recipient = makeCanonicalOfficialOrder(context);
  recipient.protocol_data.parameters.consideration[0].recipient = 1;
  assert.equal(validateOfficialListingRequired(parsedOrder(recipient)), false);
});

test("counter uses unbounded official integer semantics without invented signed range", () => {
  const source = new TextDecoder().decode(encodeCanonicalOrder(makeCanonicalOfficialOrder(context)));
  for (const raw of ["-1", "-0", "1.0", "1e1000000000"]) {
    const bytes = new TextEncoder().encode(source.replace('"counter":0', '"counter":' + raw));
    assert.equal(validateOfficialListingRequired(parsedOrderBytes(bytes)), true, raw);
  }
  for (const raw of ["1.5", "1e-1"]) {
    const bytes = new TextEncoder().encode(source.replace('"counter":0', '"counter":' + raw));
    assert.equal(validateOfficialListingRequired(parsedOrderBytes(bytes)), false, raw);
  }
});

test("all official int32 fields accept signed/integral forms and reject non-integers", () => {
  const fields = ["orderType", "totalOriginalConsiderationItems"] as const;
  for (const field of fields) {
    for (const raw of ["-2147483648", "-1.0", "1e2", "2147483647"]) {
      const source = new TextDecoder().decode(encodeCanonicalOrder(makeCanonicalOfficialOrder(context)));
      const current = field === "orderType" ? "0" : "1";
      const bytes = new TextEncoder().encode(source.replace(`"${field}":${current}`, `"${field}":${raw}`));
      assert.equal(validateOfficialListingRequired(parsedOrderBytes(bytes)), true, `${field}=${raw}`);
    }
    for (const raw of ["-2147483649", "1.5", "2147483648"]) {
      const source = new TextDecoder().decode(encodeCanonicalOrder(makeCanonicalOfficialOrder(context)));
      const current = field === "orderType" ? "0" : "1";
      const bytes = new TextEncoder().encode(source.replace(`"${field}":${current}`, `"${field}":${raw}`));
      assert.equal(validateOfficialListingRequired(parsedOrderBytes(bytes)), false, `${field}=${raw}`);
    }
  }
});

test("signed official orderType is schema-valid but targeted unsupported", () => {
  const order = makeCanonicalOfficialOrder(context); order.protocol_data.parameters.orderType = -1;
  assert.equal(validateOfficialListingRequired(parsedOrder(order)), true);
  const { observation } = path(order);
  assert.equal(observation.outcome, "UNSUPPORTED");
  assert.equal(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"), false);
});

for (const field of ["order_hash", "protocol_address", "protocol_data", "asset"] as const) {
  test(`optional official ${field} remains a targeted verifier requirement`, () => {
    const order = makeCanonicalOfficialOrder(context); delete order[field];
    assert.equal(validateOfficialListingRequired(parsedOrder(order)), true);
    const { observation } = path(order);
    assert.notEqual(observation.outcome, "VALID");
    assert.equal(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"), false);
  });
}

test("optional consumed official objects are type-checked when present", () => {
  for (const [field, value] of [["order_hash", 1], ["protocol_address", 1], ["protocol_data", "bad"], ["asset", "bad"]] as const) {
    const order = makeCanonicalOfficialOrder(context); order[field] = value;
    assert.equal(validateOfficialListingRequired(parsedOrder(order)), false, field);
    assert.ok(path(order).observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"), field);
  }
});
