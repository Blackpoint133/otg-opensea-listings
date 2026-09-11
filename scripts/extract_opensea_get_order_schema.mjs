import fs from "node:fs";
import {
  CURRENT_OPENAPI_DOCUMENT_SHA256,
  CURRENT_GET_ORDER_SCHEMA_SHA256,
  canonicalJson,
  extractGetOrderSchemaFromBytes,
  sha256Hex,
  unresolvedLocalSchemaRefs,
} from "./lib/openseaGetOrderSchemaExtraction.mjs";

const args = process.argv.slice(2);
const input = args[0];
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
if (!input || (outputIndex >= 0 && !output)) {
  throw new Error("usage: node scripts/extract_opensea_get_order_schema.mjs OPENAPI.json [--output FIXTURE.json]");
}

const bytes = fs.readFileSync(input);
const fixture = extractGetOrderSchemaFromBytes(bytes);
const canonical = canonicalJson(fixture);
const extractedSha256 = sha256Hex(Buffer.from(canonical, "utf8"));
if (extractedSha256 !== CURRENT_GET_ORDER_SCHEMA_SHA256) throw new Error(`GET_ORDER_SCHEMA_SHA_MISMATCH:${extractedSha256}`);
if (output) fs.writeFileSync(output, Buffer.from(canonical, "utf8"));

console.log(JSON.stringify({
  fullSha256: CURRENT_OPENAPI_DOCUMENT_SHA256,
  extractedSha256,
  expectedExtractedSha256: CURRENT_GET_ORDER_SCHEMA_SHA256,
  canonicalization: "sorted-json-v1",
  output,
  components: Object.keys(fixture.components.schemas).sort(),
  unresolvedLocalRefs: unresolvedLocalSchemaRefs(fixture),
}, null, 2));
