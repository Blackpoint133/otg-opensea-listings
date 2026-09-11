# Task 26 — required OpenAPI schema admission

База: `81f2f437041ef95ea33bc71acfbcd827d22e609a`. Добавлены offline extraction utility `scripts/extract_opensea_get_order_schema.mjs`, ref-complete fixture and schema admission helper. Fixture graph is walked recursively; unresolved local refs: 0. Full OpenAPI SHA-256: `feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922`; extracted fixture SHA-256: `62043c23a7622336adfe1919386f9f8ff668d398ce166397f93dc1df405a6dfc` (old `9176d22...` was incomplete and changed when missing components were added).

Effective Listing fields: chain, price, remaining_quantity, status, type. Parameters: offerer, offer, consideration, startTime, endTime, orderType, zone, zoneHash, salt, conduitKey, totalOriginalConsiderationItems, counter. Required-shape validation is centralized in `openSeaSchemaAdmission.ts`; timing keeps exact boolean false. Adapter versioning remains coherent with durable schema v4 and unchanged candidate/generation/barrier versions.

HTTP TRANSPORT NOT IMPLEMENTED  
LIVE GET ORDER NOT CALLED  
API KEY NOT USED  
DB/MUTATION NOT USED  
DEACTIVATION AUTHORITY = FALSE

A. REQUIRED OPENAPI SCHEMA ADMISSION IMPLEMENTED  READY FOR CHATGPT SOURCE AUDIT
