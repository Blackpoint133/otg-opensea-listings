# Task 25 — required schema and timing closure

База: `f45469c906bb92755a9e6cd03862d76edf477bb8`.

OpenAPI dependency pin воспроизводится из официального документа SHA-256 `feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922`; ref-complete extracted subtree SHA-256 `9176d22da88aa04b9688be7b5be9ccd08d71a61b95796be33af3bb6e107a2e72`. Effective Listing requirements: chain, price, remaining_quantity, status, type. Parameters: conduitKey, consideration, counter, endTime, offer, offerer, orderType, salt, startTime, totalOriginalConsiderationItems, zone, zoneHash.

Закрыты точные HTTP 5xx-причины, adapter/verifier reason contract, int64 range и canonical Content-Length. Timing требует literal `deadlineExceeded === false`, safe elapsed/deadline values and temporal boundaries. Candidate/envelope/generation/barrier unchanged; schema v4, adapter v4, normalizer v5, policy v8.

HTTP TRANSPORT NOT IMPLEMENTED  
LIVE GET ORDER NOT CALLED  
API KEY NOT USED  
DB/MUTATION NOT USED  
DEACTIVATION AUTHORITY = FALSE

A. REQUIRED SCHEMA/TIMING CLOSURE COMPLETE  READY FOR INDEPENDENT ACCEPTANCE AUDIT
