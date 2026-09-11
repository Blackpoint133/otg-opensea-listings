# Task 44 — overall-deadline precedence

Baseline: `3281efcdd5fb42a9aa413e33d02b9ff1a1059892`.

Закрыт MEDIUM-дефект, при котором oversized HTTP-200 data event после истечения monotonic deadline мог claim BODY_TOO_LARGE до delayed timer callback; аналогично поздний request/response error мог claim CONNECTION_RESET. Terminal decisions теперь проходят через централизованный `finish` deadline gate: единый elapsed sample сравнивается с deadline перед non-timeout claim. При `elapsedMs > overallDeadlineMs` claim выполняется как TIMEOUT с `httpStatus:null`, `body:null`; ровно `<=` разрешает обычный результат.

Normal HTTP-200 end использует один completion monotonic sample для deadline decision и timing evidence, без второго monotonic read. Claim-before-destroy Task-43 сохранён: settlement state и timer clear происходят до cancellation, synchronous destroy errors не меняют результат. Timer остаётся scheduling mechanism, а не единственным источником deadline truth. Native timer maximum `2147483647` сохранён.

Body cap 1048577, non-200 isolation, raw headers, fixed production API, no redirect/retry/decompression и accepted adapter contract не изменены. Transport version остаётся `opensea-exact-order-http-transport-v1-2026-09`.

HTTP TRANSPORT IMPLEMENTED; LOCALHOST HTTPS MATRIX NOT YET RUN; LIVE GET ORDER NOT CALLED; REAL API KEY NOT USED; DB/MUTATION NOT USED; DEACTIVATION AUTHORITY = FALSE.
