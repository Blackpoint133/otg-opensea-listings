/** Reproducible offline pin of the official OpenSea OpenAPI Get Order contract. */
export const OPENAPI_DOCUMENT_URL = "https://api.opensea.io/api/v2/openapi.json" as const;
export const OPENAPI_SCHEMA_PIN_RETRIEVED_AT = "2026-09-11T03:51:37.437Z" as const;
export const OPENAPI_DOCUMENT_SHA256 = "feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922" as const;
export const OPENAPI_DOCUMENT_BYTES = 590486 as const;
export const OPENAPI_VERSION = "3.1.0" as const;
export const OPENAPI_INFO_VERSION = "2.0.0" as const;
export const GET_ORDER_OPERATION_ID = "get_order" as const;
export const GET_ORDER_RESPONSE_REF = "#/components/schemas/GetOrderResponse" as const;
export const GET_ORDER_SCHEMA_SHA256 = "9176d22da88aa04b9688be7b5be9ccd08d71a61b95796be33af3bb6e107a2e72" as const;
export const GET_ORDER_SCHEMA_EXTRACTION = "recursive-local-ref-graph-v1; canonical UTF-8 JSON.stringify with insertion order" as const;

/** The GetOrderResponse.order oneOf is Listing | Offer. The adapter accepts Listing only. */
export const GET_ORDER_FIELD_CONTRACT = Object.freeze({
  wrapper: "order",
  outer: ["order_hash", "chain", "protocol_address", "status", "remaining_quantity", "asset", "protocol_data"],
  asset: ["contract", "identifier"],
  parameters: ["offer", "startTime", "endTime", "orderType", "counter"],
  offerItem: ["itemType", "token", "identifierOrCriteria", "startAmount", "endAmount"],
  jsonTypes: Object.freeze({
    itemType: "integer/int32", orderType: "integer/int32", startTime: "string", endTime: "string",
    counter: "integer", remaining_quantity: "integer/int64", assetIdentifier: "string", offerIdentifier: "string",
    startAmount: "string", endAmount: "string"
  })
} as const);
