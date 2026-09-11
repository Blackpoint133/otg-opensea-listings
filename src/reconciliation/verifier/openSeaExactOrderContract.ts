/** Reproducible offline pin of the official OpenSea OpenAPI Get Order contract. */
export const OPENAPI_DOCUMENT_URL = "https://api.opensea.io/api/v2/openapi.json" as const;
export const OPENAPI_SCHEMA_PIN_RETRIEVED_AT = "2026-09-11T06:34:34.4537741Z" as const;
export const OPENAPI_DOCUMENT_SHA256 = "f9b79429a3e7b095785f14b36171dcc4fb769a5a7ee04685f6e81ff742a7e18e" as const;
export const OPENAPI_DOCUMENT_BYTES = 581930 as const;
export const OPENAPI_VERSION = "3.1.0" as const;
export const OPENAPI_INFO_VERSION = "2.0.0" as const;
export const GET_ORDER_OPERATION_ID = "get_order" as const;
export const GET_ORDER_RESPONSE_REF = "#/components/schemas/GetOrderResponse" as const;
export const GET_ORDER_SCHEMA_SHA256 = "9cd70ac9d6b96532015ab0ce2e13a5220f69e6bc3b97baa66033c04834d6dc90" as const;
export const GET_ORDER_SCHEMA_EXTRACTION = "sorted-json-v1; exact Get Order 200 response plus recursive local-schema dependency closure from immutable snapshot" as const;

/** The GetOrderResponse.order oneOf is Listing | Offer. The adapter accepts Listing only. */
export const GET_ORDER_FIELD_CONTRACT = Object.freeze({
  wrapper: "order",
  officialListingRequired: ["chain", "price", "remaining_quantity", "status", "type"],
  officialParametersRequired: ["conduitKey", "consideration", "counter", "endTime", "offer", "offerer", "orderType", "salt", "startTime", "totalOriginalConsiderationItems", "zone", "zoneHash"],
  officialItemRequired: ["endAmount", "identifierOrCriteria", "itemType", "startAmount", "token"],
  officialConsiderationItemRequired: ["endAmount", "identifierOrCriteria", "itemType", "recipient", "startAmount", "token"],
  officialListingPriceRequired: ["current"],
  officialPriceRequired: ["currency", "decimals", "value"],
  officialArrayCardinality: Object.freeze({ offerMinItems: null, considerationMinItems: null }),
  targetedIdentityRequired: ["order_hash", "protocol_address", "protocol_data", "asset"],
  jsonTypes: Object.freeze({
    priceCurrency: "string", priceDecimals: "integer/int32", priceValue: "string",
    itemType: "integer/int32", orderType: "integer/int32", totalOriginalConsiderationItems: "integer/int32",
    startTime: "string", endTime: "string", counter: "integer", remainingQuantity: "integer/int64",
    token: "string", identifierOrCriteria: "string", startAmount: "string", endAmount: "string", recipient: "string"
  })
} as const);
