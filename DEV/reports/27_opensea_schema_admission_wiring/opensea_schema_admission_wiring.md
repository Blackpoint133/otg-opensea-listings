# Task 27 — OpenAPI schema admission wiring

База: `40b79b1babfe78c3098b7338876ebcb3f500550a`. Цель — подключить admission к реальному adapter path и сделать ref-complete fixture/extraction воспроизводимыми. Официальный документ pin SHA-256: `feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922`.

Effective Listing: order_hash, chain, protocol_address, protocol_data, asset, price, remaining_quantity, status, type. Parameters: offerer, offer, consideration, startTime, endTime, orderType, zone, zoneHash, salt, conduitKey, totalOriginalConsiderationItems, counter. Offer/consideration items require itemType, token, identifierOrCriteria, startAmount, endAmount with exact JSON types.

HTTP TRANSPORT NOT IMPLEMENTED  
LIVE GET ORDER NOT CALLED  
API KEY NOT USED  
DB/MUTATION NOT USED  
DEACTIVATION AUTHORITY = FALSE

A. OPENAPI SCHEMA ADMISSION WIRED AND VERIFIED  READY FOR CHATGPT SOURCE AUDIT
