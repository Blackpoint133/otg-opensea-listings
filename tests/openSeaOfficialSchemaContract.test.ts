import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import {
  CURRENT_OPENAPI_DOCUMENT_BYTES,
  CURRENT_OPENAPI_DOCUMENT_SHA256,
  CURRENT_GET_ORDER_SCHEMA_SHA256,
  GET_ORDER_METHOD,
  GET_ORDER_OPERATION_ID,
  GET_ORDER_PATH,
  PREVIOUS_HISTORICAL_OPENAPI_PIN,
  SCHEMA_CANONICALIZATION,
  canonicalJson,
  effectiveRequired,
  extractGetOrderSchemaFromBytes,
  resolveJsonPointer,
  sha256Hex,
  unresolvedLocalSchemaRefs,
} from "../scripts/lib/openseaGetOrderSchemaExtraction.mjs";

const root = process.cwd();
const snapshotPath = path.join(root, "DEV", "upstream", "opensea", "openapi", "2026-09-11_f9b79429a3e7b095", "openapi.json");
const fixturePath = path.join(root, "tests", "fixtures", "opensea_get_order_schema_2026-09-11_f9b79429.json");
const cliPath = path.join(root, "scripts", "extract_opensea_get_order_schema.mjs");
const temporaryRoots: string[] = [];
after(async () => { for (const directory of temporaryRoots) await rm(directory, { recursive: true, force: true }); });

const snapshot = fs.readFileSync(snapshotPath);
const committedBytes = fs.readFileSync(fixturePath);
const fixture = JSON.parse(committedBytes.toString("utf8"));
const schema = (name: string) => fixture.components.schemas[name];

test("task32 committed upstream snapshot has the authorized exact bytes", () => {
  assert.equal(snapshot.byteLength, CURRENT_OPENAPI_DOCUMENT_BYTES);
  assert.equal(sha256Hex(snapshot), CURRENT_OPENAPI_DOCUMENT_SHA256);
  assert.deepEqual(PREVIOUS_HISTORICAL_OPENAPI_PIN, {
    sha256: "feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922",
    byteLength: 590486,
    sourceBytesAvailable: false,
  });
});

test("task32 extractor locates the exact Get Order operation and response", () => {
  const generated = extractGetOrderSchemaFromBytes(snapshot);
  assert.deepEqual(generated.source, {
    openApiDocumentSha256: CURRENT_OPENAPI_DOCUMENT_SHA256,
    operationId: GET_ORDER_OPERATION_ID,
    method: GET_ORDER_METHOD,
    path: GET_ORDER_PATH,
  });
  assert.deepEqual(Object.keys(generated.response.content), ["*/*"]);
  assert.equal(generated.response.content["*/*"].schema.$ref, "#/components/schemas/GetOrderResponse");
});

test("task32 canonical extractor output is byte-identical to committed fixture", () => {
  const generatedBytes = Buffer.from(canonicalJson(extractGetOrderSchemaFromBytes(snapshot)), "utf8");
  assert.equal(Buffer.compare(generatedBytes, committedBytes), 0);
});

test("task32 CLI reproduces the committed fixture without network access", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opensea-schema-task32-"));
  temporaryRoots.push(directory);
  const output = path.join(directory, "fixture.json");
  const run = spawnSync(process.execPath, [cliPath, snapshotPath, "--output", output], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(Buffer.compare(await readFile(output), committedBytes), 0);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.extractedSha256, CURRENT_GET_ORDER_SCHEMA_SHA256);
  assert.deepEqual(summary.unresolvedLocalRefs, []);
});

test("task32 sorted-json-v1 canonical fixture hash is deterministic", () => {
  assert.equal(SCHEMA_CANONICALIZATION, "sorted-json-v1");
  assert.equal(committedBytes.toString("utf8"), canonicalJson(fixture));
  assert.equal(sha256Hex(committedBytes), CURRENT_GET_ORDER_SCHEMA_SHA256);
  assert.equal(sha256Hex(Buffer.from(canonicalJson(JSON.parse(canonicalJson(fixture))), "utf8")), CURRENT_GET_ORDER_SCHEMA_SHA256);
});

test("task32 every local schema JSON Pointer resolves from fixture root", () => {
  assert.deepEqual(unresolvedLocalSchemaRefs(fixture), []);
  assert.ok(resolveJsonPointer(fixture, "#/components/schemas/GetOrderResponse"));
  assert.ok(resolveJsonPointer(fixture, "#/components/schemas/ConsiderationItem/properties/recipient"));
});

test("task32 effective required sets are derived from exact components", () => {
  assert.deepEqual(effectiveRequired(schema("Listing"), fixture), ["chain", "price", "remaining_quantity", "status", "type"]);
  assert.deepEqual(effectiveRequired(schema("ListingOrOffer"), fixture), []);
  assert.deepEqual(effectiveRequired(schema("Parameters"), fixture), ["conduitKey", "consideration", "counter", "endTime", "offer", "offerer", "orderType", "salt", "startTime", "totalOriginalConsiderationItems", "zone", "zoneHash"]);
  assert.deepEqual(effectiveRequired(schema("Item"), fixture), ["endAmount", "identifierOrCriteria", "itemType", "startAmount", "token"]);
  assert.deepEqual(effectiveRequired(schema("ConsiderationItem"), fixture), ["endAmount", "identifierOrCriteria", "itemType", "recipient", "startAmount", "token"]);
  assert.deepEqual(effectiveRequired(schema("ListingPrice"), fixture), ["current"]);
  assert.deepEqual(effectiveRequired(schema("Price"), fixture), ["currency", "decimals", "value"]);
});

test("task32 Listing price ref chain and exact required scalar types are pinned", () => {
  const listingBranch = schema("Listing").allOf[1];
  assert.equal(listingBranch.properties.price.$ref, "#/components/schemas/ListingPrice");
  assert.equal(schema("ListingPrice").properties.current.$ref, "#/components/schemas/Price");
  assert.deepEqual(schema("Price").required.slice().sort(), ["currency", "decimals", "value"]);
  assert.equal(schema("Price").properties.currency.type, "string");
  assert.deepEqual(schema("Price").properties.decimals, { format: "int32", type: "integer" });
  assert.equal(schema("Price").properties.value.type, "string");
  assert.equal("additionalProperties" in schema("ListingPrice"), false);
  assert.equal("additionalProperties" in schema("Price"), false);
});

test("task32 ConsiderationItem requires recipient and exact item types", () => {
  assert.deepEqual(schema("ConsiderationItem").required.slice().sort(), ["endAmount", "identifierOrCriteria", "itemType", "recipient", "startAmount", "token"]);
  assert.deepEqual(schema("ConsiderationItem").properties.itemType, { format: "int32", type: "integer" });
  for (const key of ["token", "identifierOrCriteria", "startAmount", "endAmount", "recipient"])
    assert.equal(schema("ConsiderationItem").properties[key].type, "string", key);
});

test("task32 offer and consideration have no official minItems or maxItems", () => {
  for (const key of ["offer", "consideration"]) {
    const property = schema("Parameters").properties[key];
    assert.equal(property.type, "array");
    assert.equal("minItems" in property, false);
    assert.equal("maxItems" in property, false);
  }
  assert.equal(schema("Parameters").properties.offer.items.$ref, "#/components/schemas/Item");
  assert.equal(schema("Parameters").properties.consideration.items.$ref, "#/components/schemas/ConsiderationItem");
});

test("task32 complete component dependency set is exact and stable", () => {
  assert.deepEqual(Object.keys(fixture.components.schemas).sort(), [
    "CollectionInner", "ConsiderationItem", "ContractInner", "Criteria", "GetOrderResponse", "Item", "Listing", "ListingOrOffer", "ListingPrice", "NumericTraitData", "Offer", "OrderAsset", "Parameters", "Price", "ProtocolData", "SvmOrderIdentity", "TraitData",
  ]);
  assert.equal(crypto.createHash("sha256").update(committedBytes).digest("hex"), CURRENT_GET_ORDER_SCHEMA_SHA256);
});
